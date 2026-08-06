import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";

describe("runMigrations() error path", () => {
  it("closes the sqlite handle even when migrate() itself throws", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tn-")), "conflict.db");

    // Pre-create a conflicting `players` table so the real migration's own
    // `CREATE TABLE players (...)` statement fails. This reproduces a failure
    // AFTER openDb() has already created a live handle — unlike the ENOTDIR
    // case in cli-db-migrate-command.test.ts, which fails inside openDb()
    // before any handle exists, and so never exercises runMigrations()'s own
    // close-on-error path.
    // Issue #111: `openDb()` now requires the file to already exist by default — this seed call
    // is deliberately creating a BRAND NEW file, so it opts in with `create: true` (mirroring what
    // `runMigrations` itself does internally).
    const { sqlite: seed } = openDb(dbPath, { create: true });
    seed.exec("CREATE TABLE players (id INTEGER PRIMARY KEY)");
    seed.close();

    // Install the spy only after the seed connection is closed, so the only
    // close() calls it records are the ones made during runMigrations() —
    // this is what makes the assertion below unambiguous rather than a false
    // positive from the seed's own (unrelated) close() call.
    const closeSpy = vi.spyOn(Database.prototype, "close");
    try {
      expect(() => runMigrations(dbPath)).toThrow();

      // Direct assertion via better-sqlite3's own `.open` property (not a
      // proxy): exactly one close() call happened, on the handle opened for
      // this path, and it is now closed.
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const ctx = closeSpy.mock.contexts[0] as InstanceType<typeof Database>;
      expect(ctx.name).toBe(dbPath);
      expect(ctx.open).toBe(false);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
