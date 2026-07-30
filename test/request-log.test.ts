import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/client.js";
import { logRequest } from "../src/telemetry/request-log.js";

let dbPath: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
  process.env.TN_DB_PATH = dbPath;
  runMigrations(dbPath);
});

afterEach(() => {
  delete process.env.TN_DB_PATH;
});

function rows() {
  const sqlite = new Database(dbPath);
  const r = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
  sqlite.close();
  return r;
}

describe("request telemetry", () => {
  it("logs surface, command, args, timestamps, and ok outcome", async () => {
    const code = await logRequest("cli", "db migrate", ["--quiet"], async () => 0);
    expect(code).toBe(0);
    const [row] = rows();
    expect(row).toMatchObject({ surface: "cli", command: "db migrate", outcome: "ok" });
    expect(row?.started_at).toBeTruthy();
    expect(row?.ended_at).toBeTruthy();
    expect(JSON.parse(String(row?.args))).toEqual(["--quiet"]);
  });

  it("records error outcome and still returns the exit code when fn throws", async () => {
    const code = await logRequest("cli", "db migrate", [], async () => {
      throw new Error("boom");
    });
    expect(code).toBe(1);
    const [row] = rows();
    expect(String(row?.outcome)).toMatch(/^error:/);
  });

  it("closes the sqlite handle even when the insert itself throws", async () => {
    // Drop request_log after migration so openDb() still succeeds but the
    // insert fails post-open — mirrors db-client-error-handling.test.ts's
    // seed-a-conflict approach, exercising close-on-error rather than the
    // before-first-migrate swallow path the other tests cover.
    const seed = new Database(dbPath);
    seed.exec("DROP TABLE request_log");
    seed.close();

    const closeSpy = vi.spyOn(Database.prototype, "close");
    try {
      const code = await logRequest("cli", "db migrate", [], async () => 0);
      expect(code).toBe(0);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const ctx = closeSpy.mock.contexts[0] as InstanceType<typeof Database>;
      expect(ctx.open).toBe(false);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
