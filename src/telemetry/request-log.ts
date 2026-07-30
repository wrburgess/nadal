import { openDb } from "../db/client.js";
import { requestLog } from "../db/schema.js";

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
        .values({ surface, command, args: JSON.stringify(args), startedAt, endedAt: new Date().toISOString(), outcome })
        .run();
    } finally {
      sqlite.close();
    }
  } catch {
    // Telemetry must never break the request itself (e.g. before first migrate).
  }
  return code;
}
