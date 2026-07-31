import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/client.js";
import { buildLegacyMigrationsFolder } from "./helpers/legacy-migrations.js";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
}

/**
 * Issue #46, Task 5: a pre-existing database holding a duplicate `tennisrecord_url` pair (the
 * exact damage #46 fixes) makes migration 0006's `CREATE UNIQUE INDEX` fail. This models "a real
 * database that was created and used before this PR's partial-unique-index migration existed" the
 * same way `test/db-membership-unique-upgrade.test.ts` does for the membership index, via
 * `buildLegacyMigrationsFolder` (migrations 0000-0005, i.e. everything before #46's migration).
 */
describe("upgrading an existing v5 database with duplicate tennisrecord_url rows (#46)", () => {
  it("runMigrations throws a legible error naming teams.tennisrecord_url and the recovery, not a bare UNIQUE constraint message", () => {
    const dbPath = freshDbPath();
    const legacyDir = buildLegacyMigrationsFolder(5);
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: legacyDir });
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A', 'https://tr/team?a')`,
      );
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A 4.0', 'https://tr/team?a')`,
      );
    } finally {
      sqlite.close();
    }

    let caught: unknown;
    try {
      runMigrations(dbPath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/teams\.tennisrecord_url/);
    // The legibility fix — not a bare passthrough of SQLite's own message.
    expect(message).not.toBe("UNIQUE constraint failed: teams.tennisrecord_url");
    // The one-line recovery (docs/runbooks/db-migration-recovery.md).
    expect(message).toMatch(/rm data\/nadal\.db && tn db migrate/);
  });

  it("the same legacy database WITHOUT duplicates upgrades cleanly and the index exists", () => {
    const dbPath = freshDbPath();
    const legacyDir = buildLegacyMigrationsFolder(5);
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: legacyDir });
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A', 'https://tr/team?a')`,
      );
    } finally {
      sqlite.close();
    }

    expect(() => runMigrations(dbPath)).not.toThrow();

    const after = new Database(dbPath);
    try {
      const indexes = after
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='teams'`)
        .all() as Array<{ name: string }>;
      expect(indexes.some((i) => i.name === "teams_tennisrecord_url_unique")).toBe(true);
    } finally {
      after.close();
    }
  });
});
