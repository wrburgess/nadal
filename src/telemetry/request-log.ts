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
    // forever, so surface it to stderr as one diagnostic line.
    console.error(`telemetry: request_log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return code;
}
