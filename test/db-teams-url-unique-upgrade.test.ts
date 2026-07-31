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
    // The recovery (docs/runbooks/db-migration-recovery.md).
    expect(message).toMatch(/tn db migrate/);
  });

  // Codex adversarial review, rated CRITICAL. `runMigrations(path)` takes the database path — it is
  // routinely NOT the default (every test here, and any run with TN_DB_PATH set) — but the first
  // draft of the recovery hardcoded `rm data/nadal.db`. Following that instruction would delete a
  // DIFFERENT, unrelated database and leave the failing one untouched: a destructive command aimed
  // at the wrong file. Two things are asserted, because fixing only the first would still ship a
  // destructive default:
  //   1. the message names the database that ACTUALLY failed, and never the default when they differ
  //   2. the recovery does not tell anyone to `rm` anything — it MOVES the file aside, which reaches
  //      the same end state (the next migrate creates a fresh DB) while staying recoverable
  it("REGRESSION: the recovery names the ACTUAL failing database and is non-destructive", () => {
    const dbPath = freshDbPath();
    expect(dbPath).not.toContain("data/nadal.db"); // the premise of this test
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
    const message = (caught as Error).message;

    expect(message).toContain(dbPath);
    expect(message).not.toContain("data/nadal.db");
    // No destructive command anywhere in the guidance.
    expect(message).not.toMatch(/\brm\b/);
    expect(message).toMatch(/\bmv\b/);
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
