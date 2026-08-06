import { AmbiguousIdentityError } from "./errors.js";
import { FetchError } from "./fetch.js";
import { ParseError } from "../parsers/types.js";

/**
 * What an operator should DO about a failure — issue #98.
 *
 * `tn team pull --players` has reported *who* was skipped since #31 and *why* since #96, but the why
 * arrives as one stderr line per failure. A caller reading the summary line, or an agent reading the
 * MCP result, could not tell a rate-limited pull to re-run from a dead profile URL or a page-shape
 * regression to investigate. This is the vocabulary that distinction is reported in.
 *
 * **Three values, not two, and the third is load-bearing.** `SQLITE_BUSY` behind a wrapper, an
 * unrecognized libuv code, and any error class this module has never seen are genuinely unknown at
 * the point of classification. A two-value vocabulary would have to assert one of them falsely, and
 * the direction of the lie is not harmless either way: a wrong `retryable` sends an operator to
 * re-run a doomed pull twice before they read the warning, which is worse than the no-label state
 * this issue set out to fix. `unclassified` says "read the reason", which is exactly true.
 */
export type FailureDisposition = "retryable" | "permanent" | "unclassified";

/** Statuses that indicate load or a transient upstream fault rather than a wrong request. */
const RETRYABLE_STATUSES = new Set([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests — the rate-limiting #98 measured
]);

/**
 * libuv/DNS codes that mean the request never got a real answer. `ENOTFOUND` is the judgement call
 * in this list: a permanently dead host resolves to it too, so a retry can be futile. It is retryable
 * anyway because the observed cause on this source is a transient resolver failure, and because the
 * cost of the two mistakes is asymmetric — one wasted re-run against a human sent to investigate a
 * fault that had already healed.
 */
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]);

/** `AbortSignal.timeout` rejects with a `TimeoutError`; a manual abort gives `AbortError`. */
const RETRYABLE_ERROR_NAMES = new Set(["TimeoutError", "AbortError"]);

/**
 * SQLite contention. Matched as a PREFIX because better-sqlite3 returns extended result codes on
 * some paths (`SQLITE_BUSY_SNAPSHOT`, `SQLITE_LOCKED_SHAREDCACHE`), and an exact-equality set would
 * silently miss them while reading as though it covered the class.
 */
const RETRYABLE_CODE_PREFIXES = ["SQLITE_BUSY", "SQLITE_LOCKED"];

/**
 * How far the `cause` walk goes. `Error.cause` is an ordinary writable property, so a cycle is
 * constructible, and this function runs inside a `catch` where a hang is indistinguishable from a
 * slow pull. A bound is the only termination guarantee that does not depend on the chain being
 * well-formed; 16 is far beyond any real wrapper depth (undici wraps once, drizzle once).
 */
const MAX_CAUSE_DEPTH = 16;

/**
 * Read one property off a possibly-hostile caught value without throwing.
 *
 * Reading a property IS an operation that can throw — a getter, or a Proxy trap — which is the same
 * lesson `errorMessage` (src/error-message.ts) records after its first draft guarded only the
 * coercion and not the `err.message` read. Returning `undefined` for an unreadable property lets the
 * walk continue to the next link rather than abandoning a chain whose LATER hop carries a real fact.
 */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** `instanceof` against a hostile value throws (a Proxy may trap `getPrototypeOf`); this does not. */
function isInstanceOf(value: unknown, ctor: new (...args: never[]) => unknown): boolean {
  try {
    return value instanceof ctor;
  } catch {
    return false;
  }
}

/** One link of the chain, classified on its own; `null` = this link says nothing. */
function classifyLink(value: unknown): FailureDisposition | null {
  if (typeof value !== "object" || value === null) return null;

  // Checked before the generic `code` read: a FetchError is a completed HTTP exchange, so its status
  // is a stronger fact than anything else on the object.
  if (isInstanceOf(value, FetchError)) {
    const status = readProperty(value, "status");
    if (typeof status === "number") {
      if (RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599)) return "retryable";
      return "permanent";
    }
    // A FetchError with no numeric status is a shape this module does not recognize; say so rather
    // than defaulting it into either bucket.
    return "unclassified";
  }

  // Both mean "retrying reproduces this identically" — a parse failure needs the page or the parser
  // looked at, and an ambiguity needs a human to rule with `tn player distinct` / `tn player alias`.
  if (isInstanceOf(value, ParseError) || isInstanceOf(value, AmbiguousIdentityError)) return "permanent";

  const name = readProperty(value, "name");
  if (typeof name === "string" && RETRYABLE_ERROR_NAMES.has(name)) return "retryable";

  const code = readProperty(value, "code");
  if (typeof code === "string") {
    if (RETRYABLE_CODES.has(code)) return "retryable";
    if (RETRYABLE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) return "retryable";
  }

  return null;
}

/**
 * Classify a caught value — the ONE place a failure's disposition is decided.
 *
 * **It classifies from structure, never from a rendered message.** A `ParseError` quotes the document
 * it choked on, and that document is fetched from an upstream source, so a message-matching classifier
 * would let a scraped page spell `fetch failed with status 503` into itself and buy a `retryable`
 * label. Every verdict below comes from a class, a numeric status, or a code.
 *
 * **It walks `cause`** rather than checking the top level or two fixed levels, matching the shape
 * `runMigrations` already uses (src/db/client.ts): undici reports every socket failure as a bare
 * `TypeError: fetch failed` with the real code on `.cause`, and drizzle wraps better-sqlite3 the same
 * way. Checking `err` and `err.cause` would classify one of those and miss the other.
 *
 * **The whole body is inside one `try`, including every `instanceof` and every property read.** This
 * function is called from inside a `catch`, so a throw here converts a handled failure into an
 * unhandled one — precisely the failure the catch existed to prevent. That is not a hypothetical
 * shape in this codebase: `errorMessage`'s first draft guarded only its coercion, and an `Error` with
 * a throwing `message` getter escaped the function whose entire contract was that it does not.
 * `instanceof` is the same hazard on a different operation, since a Proxy can trap `getPrototypeOf`.
 */
export function dispositionOfThrown(err: unknown): FailureDisposition {
  try {
    let current: unknown = err;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
      const verdict = classifyLink(current);
      if (verdict !== null) return verdict;
      if (typeof current !== "object" || current === null) return "unclassified";
      current = readProperty(current, "cause");
    }
    return "unclassified";
  } catch {
    return "unclassified";
  }
}
