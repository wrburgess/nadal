import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
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
    // Three independent guards, in the order they were learned:
    //   `-i`  — refuses a silent overwrite (round 2's clobber finding; see the test below)
    //   `--`  — ends option parsing (round 2: single-quoting protects shell METACHARACTERS but not
    //           `mv`'s own OPTION parsing, so `TN_DB_PATH=-db` emitted as `mv '-db' …` reads as a flag)
    //   absolute paths — round 3; the structural fix, since a path starting with `/` can never be
    //           parsed as an option at all. Pinned by its own test below.
    expect(message).toMatch(/mv -i -- /);
    // Pins the PLAIN backup name for the "nothing taken yet" case. Without this the disambiguating
    // branch in `untakenBackupPath` is half-unkillable: a mutant that ALWAYS disambiguates still
    // satisfies every other assertion here, and `rules/testing.md` does not allow a branch side no
    // test can kill. The clobber test below pins the other side.
    expect(message).toContain(`${dbPath}.pre-0006.bak'`);
    // MERGE-BORN regression, caught integrating #44/PR #51. `tn db migrate` renders this message
    // through `emitSummary`'s one-line `key=value` summary, and `sanitizeValue` turns every control
    // character into a space — so a multi-line message silently collapses into one run of prose
    // with the `mv` command buried mid-paragraph. The message must be single-line BY CONSTRUCTION.
    // Guarded here (the message itself) and end-to-end in test/cli-db-migrate-command.test.ts (the
    // rendered CLI line), because this defect lives in the seam between them and neither side had
    // it alone.
    // The predicate is sanitizeValue's OWN character class, not a hand-listed subset: \p{Cc} +
    // \p{Cf} + U+2028/U+2029 (src/sanitize.ts). A narrower list here would claim "single-line" while
    // missing DEL, the C1 block and every format control — a check whose comment outruns what it
    // enforces, which rules/testing.md names as worse than no check. Codex round 4 caught exactly
    // that in the first draft of this assertion.
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
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

  // Codex round 3 recommended emitting absolute paths so neither argument can begin with `-`.
  // Adopted — it closes the dash-prefixed-path class structurally instead of relying on `--`, and a
  // recovery command is copy-pasted from wherever the reader happens to be standing, so a relative
  // path is a trap regardless.
  //
  // (The round-3 finding this came attached to — that BSD `mv` on macOS rejects `--` — was DISPUTED
  // and not accepted; see the PR thread. `mv -i -- -db -db.bak` exits 0 on this host. The `mv:
  // illegal option -- -` text that finding cited comes from `mv --version`, which BSD `mv` has no
  // flag for; its wording merely reads as though the terminator were rejected.)
  it("REGRESSION: the recovery command emits an ABSOLUTE path even when given a relative one", () => {
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

    // Address the very same file by a RELATIVE path, without chdir-ing into the repo or writing
    // anything into it: `resolve(cwd, relative(cwd, p))` is exactly `p`.
    const relativePath = relative(process.cwd(), dbPath);
    expect(relativePath).not.toBe(dbPath); // the premise of this test
    expect(isAbsolute(relativePath)).toBe(false);

    let caught: unknown;
    try {
      runMigrations(relativePath);
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;

    // The emitted `mv` source is the absolute path, not the relative one it was called with.
    expect(message).toContain(`mv -i -- '${dbPath}'`);
    expect(message).not.toContain(`'${relativePath}'`);
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
