import { MissingDatabaseError, openDb } from "../db/client.js";
import { requestLog } from "../db/schema.js";
import { errorClass, errorMessage } from "../error-message.js";
import { sanitizeValue } from "../sanitize.js";

type RequestLogRow = {
  surface: "cli" | "mcp";
  command: string;
  args: string;
  startedAt: string;
  endedAt: string;
  outcome: string;
};

/**
 * The single row-write both `logRequest` (CLI) and `logMcpTool` (MCP, Task 6) share — extracted so
 * the two callers cannot drift on how a write failure is handled. Telemetry must never break the
 * request/tool call itself (e.g. before the first `tn db migrate`), so any failure here is caught
 * and never rethrown — but swallowing it with zero signal would let a stopped capture (SQLITE_BUSY,
 * a dropped table, a read-only volume) go undiscovered forever, so it is surfaced to stderr as one
 * diagnostic line. The underlying error's message can itself carry attacker-controlled text (e.g.
 * from `TN_DB_PATH`), so it goes through the same `sanitizeValue()` every other CLI-surfaced value
 * does before being printed.
 *
 * Issue #111 Task 6: `MissingDatabaseError` is the ONE exception to "always print a diagnostic".
 * `openDb()` throws it on every command run before `tn db migrate` has ever bootstrapped a
 * database, and `logRequest`/`logMcpTool` wrap EVERY dispatched command — so without this
 * carve-out, the very first command a fresh checkout ever runs would print a spurious "telemetry:
 * request_log write failed" line ahead of (or instead of) the command's own, more useful
 * diagnostic, for a condition that isn't a telemetry failure at all: there is nothing to log to
 * yet, and the command's own guard is what reports the missing database. Caught BY CLASS, not by
 * widening this catch generally, so a genuine telemetry failure against a database that DOES exist
 * (a dropped table, SQLITE_BUSY, a read-only volume) still prints exactly as before.
 */
function writeRequestLogRow(row: RequestLogRow): void {
  try {
    const { db, sqlite } = openDb();
    try {
      db.insert(requestLog).values(row).run();
    } finally {
      sqlite.close();
    }
  } catch (err) {
    if (err instanceof MissingDatabaseError) return;
    // `errorMessage`, not `err instanceof Error ? err.message : String(err)`: the latter puts the
    // coercion on the wrong branch, so an Error whose `message` is not a string made
    // `sanitizeValue()` call `.replace()` on a non-string and throw a TypeError from inside THIS
    // catch — breaking the request this whole function exists not to break (#64).
    console.error(`telemetry: request_log write failed: ${sanitizeValue(errorMessage(err))}`);
  }
}

export async function logRequest(
  surface: "cli" | "mcp",
  command: string,
  args: string[],
  fn: () => Promise<number>,
): Promise<number> {
  const startedAt = new Date().toISOString();
  let outcome = "ok";
  let code: number;
  try {
    code = await fn();
    if (code !== 0) outcome = `error:exit-${code}`;
  } catch (err) {
    // `errorClass`, not an inline `instanceof` + `.constructor.name` (Reviewer finding 3 on
    // PR #84): both operations throw on a hostile caught value — a Proxy trapping
    // getPrototypeOf, or an Error with `constructor` redefined — which made THIS catch throw
    // and `logRequest` reject instead of returning the wrapped call's exit code.
    outcome = `error:${errorClass(err)}`;
    code = 1;
  }
  writeRequestLogRow({
    surface,
    command,
    args: JSON.stringify(args.map(sanitizeValue)),
    startedAt,
    endedAt: new Date().toISOString(),
    outcome,
  });
  return code;
}

/**
 * Recursively sanitizes every string leaf of an arbitrary JSON-shaped value the same way
 * `sanitizeValue` sanitizes a single CLI arg string — an MCP tool call's args arrive as a structured
 * object/array, not a flat `string[]` like argv, so `logRequest`'s `args.map(sanitizeValue)` has no
 * direct analog here; this is that analog, applied at every depth rather than only the top level.
 */
function sanitizeArgsDeep(value: unknown): unknown {
  if (typeof value === "string") return sanitizeValue(value);
  if (Array.isArray(value)) return value.map(sanitizeArgsDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, sanitizeArgsDeep(v)]));
  }
  return value;
}

/**
 * The MCP-surface sibling of `logRequest` (Task 6) — `logRequest`'s signature is CLI-shaped
 * (`fn: () => Promise<number>`, exit-code outcomes); an MCP tool returns a VALUE, not an exit code,
 * so this is a value-returning variant rather than an adapter over `logRequest` itself.
 * `logRequest`'s own public behavior is unchanged by this addition — `test/request-log.test.ts`
 * passes unmodified, which is this file's own regression assertion.
 *
 * On success, writes `outcome="ok"` and returns `fn`'s result. On a thrown error, writes
 * `outcome="error:<ClassName>"` and RE-THROWS the original error — telemetry must never swallow a
 * tool failure, the same contract `logRequest` gives the CLI (there, a non-zero exit code IS the
 * "error" signal; here, since there is no exit code, the throw itself has to be the signal, so it
 * cannot be absorbed).
 */
export async function logMcpTool<T>(tool: string, args: unknown, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString();
  const sanitizedArgs = JSON.stringify(sanitizeArgsDeep(args));
  try {
    const result = await fn();
    writeRequestLogRow({
      surface: "mcp",
      command: tool,
      args: sanitizedArgs,
      startedAt,
      endedAt: new Date().toISOString(),
      outcome: "ok",
    });
    return result;
  } catch (err) {
    writeRequestLogRow({
      surface: "mcp",
      command: tool,
      args: sanitizedArgs,
      startedAt,
      endedAt: new Date().toISOString(),
      outcome: `error:${errorClass(err)}`,
    });
    throw err;
  }
}
