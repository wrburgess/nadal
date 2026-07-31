import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    // `--` is the argument terminator, and it is what makes a dash-prefixed path safe. Codex round
    // 2 (rated high): single-quoting protects shell METACHARACTERS but not `mv`'s own OPTION
    // parsing, so a legitimate `TN_DB_PATH=-db` emitted as `mv '-db' …` is read as a flag, not a
    // pathname. `-i` is the second, independent guard — see the clobber test below.
    expect(message).toMatch(/mv -i -- /);
    // Pins the PLAIN backup name for the "nothing taken yet" case. Without this the disambiguating
    // branch in `untakenBackupPath` is half-unkillable: a mutant that ALWAYS disambiguates still
    // satisfies every other assertion here, and `rules/testing.md` does not allow a branch side no
    // test can kill. The clobber test below pins the other side.
    expect(message).toContain(`${dbPath}.pre-0006.bak'`);
  });

  // Codex round 2, rated HIGH: the round-1 fix replaced `rm` with a bare `mv` to a FIXED backup
  // name, so a SECOND migration failure would overwrite the FIRST backup — silently destroying the
  // captain notes and availability that the very same message promises are safe. A fix that
  // introduced the failure mode it was written to remove.
  //
  // Closed by construction rather than by warning: the backup name is chosen only after checking
  // what is already on disk, so the command never names an existing file. `mv -i` then covers the
  // residual TOCTOU (a backup appearing between this message and the user running it).
  it("REGRESSION: a second failure never names an existing backup as its target", () => {
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

    // Stand in for "a previous recovery already produced a backup" — with real content, so an
    // overwrite would be real data loss.
    const takenBackup = `${dbPath}.pre-0006.bak`;
    writeFileSync(takenBackup, "a previous backup holding captain notes");

    let caught: unknown;
    try {
      runMigrations(dbPath);
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;

    // The emitted command must not target the file that already exists...
    expect(message).not.toContain(`${takenBackup}'`);
    // ...but must still propose a backup derived from this database.
    expect(message).toMatch(/mv -i -- /);
    expect(message).toContain(`${dbPath}.pre-0006.`);
    // And the untouched prior backup still holds its content.
    expect(readFileSync(takenBackup, "utf8")).toBe("a previous backup holding captain notes");
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
