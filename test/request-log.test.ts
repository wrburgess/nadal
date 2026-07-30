import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/client.js";
import { logRequest } from "../src/telemetry/request-log.js";
import { useTnDbPath } from "./helpers/tn-db.js";

const fixture = useTnDbPath();

beforeEach(() => {
  runMigrations(fixture.path());
});

function rows() {
  const sqlite = new Database(fixture.path());
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

  it("records error:exit-N outcome and returns the exit code when fn returns non-zero without throwing", async () => {
    const code = await logRequest("cli", "x", [], async () => 2);
    expect(code).toBe(2);
    const [row] = rows();
    expect(row?.outcome).toBe("error:exit-2");
  });

  it("sanitizes control and bidi characters embedded in args before persisting", async () => {
    // Same contract as sanitizeValue() (Task 6, hardened via src/sanitize.ts):
    // control characters and bidi overrides must not survive into a value
    // that could later be rendered in a terminal or report. A newline and an
    // RTL override embedded in an arg must come out stripped/replaced.
    const rtlOverride = String.fromCharCode(0x202e);
    const dirty = [`a\nb`, `c${rtlOverride}d`];
    const code = await logRequest("cli", "db migrate", dirty, async () => 0);
    expect(code).toBe(0);
    const [row] = rows();
    const storedArgs = JSON.parse(String(row?.args)) as string[];
    expect(storedArgs).toEqual(["a b", "c d"]);
  });

  it("closes the sqlite handle even when the insert itself throws", async () => {
    // Drop request_log after migration so openDb() still succeeds but the
    // insert fails post-open — mirrors db-client-error-handling.test.ts's
    // seed-a-conflict approach, exercising close-on-error rather than the
    // before-first-migrate swallow path the other tests cover.
    const seed = new Database(fixture.path());
    seed.exec("DROP TABLE request_log");
    seed.close();

    const closeSpy = vi.spyOn(Database.prototype, "close");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await logRequest("cli", "db migrate", [], async () => 0);
      expect(code).toBe(0);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const ctx = closeSpy.mock.contexts[0] as InstanceType<typeof Database>;
      expect(ctx.open).toBe(false);
      // Not breaking the wrapped request is correct and stays (code is still 0 above) — but a
      // telemetry write failure (dropped table, SQLITE_BUSY, a read-only volume, ...) must not
      // vanish with zero signal: it needs to reach stderr so it's discoverable, not silently
      // swallowed forever.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("telemetry: request_log write failed"));
    } finally {
      closeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
