import { openDb } from "../db/client.js";
import { requestLog } from "../db/schema.js";
import { sanitizeValue } from "../sanitize.js";

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
    outcome = `error:${err instanceof Error ? err.constructor.name : "unknown"}`;
    code = 1;
  }
  try {
    const { db, sqlite } = openDb();
    try {
      db.insert(requestLog)
        .values({
          surface,
          command,
          args: JSON.stringify(args.map(sanitizeValue)),
          startedAt,
          endedAt: new Date().toISOString(),
          outcome,
        })
        .run();
    } finally {
      sqlite.close();
    }
  } catch (err) {
    // Telemetry must never break the request itself (e.g. before first migrate) — the wrapped
    // fn's own code/outcome above is untouched. But swallowing this with zero signal means a
    // stopped capture (SQLITE_BUSY, a dropped table, a read-only volume) could go undiscovered
    // forever, so surface it to stderr as one diagnostic line. The underlying error's message can
    // itself carry attacker-controlled text (e.g. from TN_DB_PATH), so it goes through the same
    // sanitizeValue() every other CLI-surfaced value does before being printed.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`telemetry: request_log write failed: ${sanitizeValue(message)}`);
  }
  return code;
}
