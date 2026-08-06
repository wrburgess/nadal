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
 * Codes for a connection that was established and then failed, or a resolver that explicitly said
 * "ask again". Each one is a fault in the *attempt*, not a statement about the destination, so a
 * retry is a real remedy for all of them.
 *
 * **`ENOTFOUND` is deliberately NOT here, and it was, in an earlier revision of this file.** The
 * justification then was "the observed cause on this source is a transient resolver failure" — an
 * empirical claim with no measurement behind it. #98's four measured failures were rate-limiting,
 * not DNS. `ENOTFOUND` is NXDOMAIN, which a permanently dead host returns exactly as a flapping
 * resolver does, so it cannot be *positively identified* as transient — and this module's whole
 * contract is that `retryable` is only ever positively identified. It falls to `unclassified`, which
 * sends the operator to the reason instead of to a re-run that may be doomed. `EAI_AGAIN` stays,
 * because it is the resolver's own "temporary failure, retry" code.
 * (Independent Codex review of PR #119, rated medium.)
 *
 * **The list is exactly what is enumerated — no wider class is claimed.** A libuv code not named
 * here (`ENETUNREACH`, `EHOSTUNREACH`, …) is `unclassified`, not retryable. GRAMMAR.md and the
 * runbook say so in those words rather than promising "a socket error"; the same review found the
 * prose asserting a class this set does not cover.
 */
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);

/** `AbortSignal.timeout` rejects with a `TimeoutError`; a manual abort gives `AbortError`. */
const RETRYABLE_ERROR_NAMES = new Set(["TimeoutError", "AbortError"]);

/**
 * SQLite contention, in the two shapes the extended result codes actually take.
 *
 * better-sqlite3 sets `err.code` to the extended name where SQLite defines one — read from
 * `node_modules/better-sqlite3/src/util/constants.cpp`, which registers `SQLITE_BUSY_RECOVERY`,
 * `SQLITE_BUSY_SNAPSHOT`, `SQLITE_LOCKED_SHAREDCACHE` and `SQLITE_LOCKED_VTAB` as literal strings —
 * so an exact match on the two base codes alone would silently miss the extended forms while reading
 * as though it covered the class.
 *
 * **`SQLITE_BUSY` is a prefix and `SQLITE_LOCKED` is not, and that asymmetry is the point.** Every
 * `SQLITE_BUSY*` code is contention that clears on a retry. `SQLITE_LOCKED*` is not uniform:
 * `SQLITE_LOCKED_SHAREDCACHE` is contention, but `SQLITE_LOCKED_VTAB` reports a locked virtual table,
 * which a retry does not clear — so a prefix here would hand out the one verdict this module says is
 * worst to get wrong, a `retryable` an operator would act on twice. nadal declares no virtual tables
 * today; the enumeration is written for what the codes MEAN rather than for what this schema happens
 * to reach, because the second is a fact about the caller and the first is a fact about SQLite.
 */
const RETRYABLE_CODE_PREFIXES = ["SQLITE_BUSY"];
const RETRYABLE_EXACT_CODES = new Set(["SQLITE_LOCKED", "SQLITE_LOCKED_SHAREDCACHE"]);

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
    // `Number.isInteger`, not `typeof === "number"`. `NaN` and `Infinity` are both numbers and
    // neither compares into the 5xx range, so a `typeof` test would fall through to `permanent` —
    // asserting "retrying reproduces this" about a status nothing ever identified, which is exactly
    // the claim this module's docblock says it never makes. They land in `unclassified` instead.
    if (Number.isInteger(status)) {
      const code = status as number;
      if (RETRYABLE_STATUSES.has(code) || (code >= 500 && code <= 599)) return "retryable";
      return "permanent";
    }
    // A FetchError carrying no usable status is a shape this module does not recognize; say so
    // rather than defaulting it into either bucket.
    return "unclassified";
  }

  // Both mean "retrying reproduces this identically" — a parse failure needs the page or the parser
  // looked at, and an ambiguity needs a human to rule with `tn player distinct` / `tn player alias`.
  if (isInstanceOf(value, ParseError) || isInstanceOf(value, AmbiguousIdentityError)) return "permanent";

  const name = readProperty(value, "name");
  if (typeof name === "string" && RETRYABLE_ERROR_NAMES.has(name)) return "retryable";

  const code = readProperty(value, "code");
  if (typeof code === "string") {
    if (RETRYABLE_CODES.has(code) || RETRYABLE_EXACT_CODES.has(code)) return "retryable";
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
