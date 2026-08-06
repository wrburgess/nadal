import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { losslessPath, runMigrations } from "../src/db/client.js";
import { BackupRefusedError, BackupVerificationError, backupDatabase, compareTableCounts } from "../src/db/backup.js";
import { useTnDbPath } from "./helpers/tn-db.js";

// `String.fromCharCode`, not a regex literal embedding the raw code points: a literal control
// character inside a `/…/`-delimited pattern is unterminated-regex-prone at whatever boundary wrote
// this file — the same trap test/cli-db-migrate-command.test.ts's own LINE_SEPARATOR/
// PARAGRAPH_SEPARATOR constants exist to avoid.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

// Issue #110, Testing Strategy table (`test/db-backup.test.ts` rows). Each `it` below is numbered
// against that table so the mapping from plan to test is direct.
describe("backupDatabase (issue #110)", () => {
  const fixture = useTnDbPath("source.db");

  it("1: every table's count in the BACKUP FILE equals the source's, read out of the written file itself", async () => {
    const sourcePath = fixture.path();
    runMigrations(sourcePath);
    const seed = new Database(sourcePath);
    seed.exec("INSERT INTO teams (name) VALUES ('Norbury'), ('Rolling Hills')");
    seed.exec("INSERT INTO players (canonical_name) VALUES ('A Player')");
    seed.close();

    const result = await backupDatabase(sourcePath);

    // A fresh connection THIS TEST opens on the written file — not the counts `backupDatabase`
    // itself reports about its own source — so a `compareTableCounts` bug that agreed with a
    // broken snapshot could not hide behind the function's own report of success.
    const readback = new Database(result.destination, { readonly: true, fileMustExist: true });
    const teams = readback.prepare("SELECT COUNT(*) AS n FROM teams").get() as { n: number };
    const players = readback.prepare("SELECT COUNT(*) AS n FROM players").get() as { n: number };
    readback.close();

    expect(teams.n).toBe(2);
    expect(players.n).toBe(1);
  });

  it("2: captures uncheckpointed WAL content that a raw byte-copy of the main file at the same instant does not have", async () => {
    const sourcePath = fixture.path();
    runMigrations(sourcePath); // openDb() inside sets journal_mode = WAL before closing cleanly.

    // Left OPEN and UNCHECKPOINTED across the whole backup call — the scenario's whole point. A
    // `cp`-style raw copy of the main file taken while this connection is open would miss this row.
    const writer = new Database(sourcePath);
    writer.pragma("journal_mode = WAL");
    const marker = "WalOnlyTeam_scenario2";
    writer.exec(`INSERT INTO teams (name) VALUES ('${marker}')`);

    // The raw bytes of the MAIN file, read directly (no SQLite involved) right after the insert and
    // before backupDatabase runs. This is the half that makes the test about WAL rather than about
    // nothing: if it did NOT capture the row here, the assertion below would prove nothing about
    // .backup() specifically, since a `cp` would have "passed" too.
    const rawMainFileBytes = readFileSync(sourcePath, "latin1");
    expect(rawMainFileBytes.includes(marker)).toBe(false);

    const result = await backupDatabase(sourcePath);
    writer.close();

    const readback = new Database(result.destination, { readonly: true, fileMustExist: true });
    const row = readback.prepare("SELECT COUNT(*) AS n FROM teams WHERE name = ?").get(marker) as { n: number };
    readback.close();
    expect(row.n).toBe(1);
  });

  it("3: a missing source refuses without creating the file or its parent directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const missingDir = join(dir, "nonexistent-subdir");
    const missingPath = join(missingDir, "ghost.db");

    await expect(backupDatabase(missingPath)).rejects.toThrow(BackupRefusedError);

    // This asserts the refusal creates nothing, which is still worth pinning. What it no longer
    // does is guard the choice its previous comment claimed: that comment said `openDb()`
    // `mkdirSync`s the parent as a side effect of checking whether the source exists, and issue
    // #111 made that false — `openDb()` now `mkdirSync`s only under `create: true` and otherwise
    // opens with `fileMustExist: true`. So both assertions below would stay green even if
    // `backupDatabase` were routed back through a default `openDb()`, which is exactly the
    // refactor they were written to catch. The guard that actually discriminates it now lives in
    // scenario 3b below. (Found by the independent Codex review of PR #116 while checking whether
    // #110's merge left stale claims behind — it had, in one more place than the merge log said.)
    expect(existsSync(missingPath)).toBe(false);
    expect(existsSync(missingDir)).toBe(false);
  });

  // The replacement guard for the rationale scenario 3 lost, pinning the reasons `src/db/backup.ts`
  // NOW gives for opening SQLite directly rather than through `openDb()`: a backup SOURCE is only
  // read, and must not have `openDb()`'s `journal_mode = WAL` / `foreign_keys = ON` pragmas applied
  // to it.
  //
  // `journal_mode` is the discriminator because it is the one that PERSISTS: setting it to WAL
  // rewrites the source database's own header, so the damage outlives the connection. Measured, not
  // assumed — a DELETE-mode source stays `delete` through a direct open, and becomes `wal`
  // permanently once `openDb()`'s pragma runs. Routing `backupDatabase` through a default
  // `openDb()` therefore turns this test red, which is the property scenario 3 no longer has.
  it("3b: leaves the SOURCE's journal_mode untouched — the reason the source is opened directly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-journal-mode-"));
    const sourcePath = join(dir, "delete-mode.db");
    runMigrations(sourcePath);

    // runMigrations goes through openDb({ create: true }), so the fixture starts in WAL; put it
    // into DELETE deliberately, which is the state a pragma-applying open would destroy.
    const seed = new Database(sourcePath);
    seed.pragma("journal_mode = DELETE");
    seed.close();
    expect(new Database(sourcePath).pragma("journal_mode", { simple: true })).toBe("delete");

    await backupDatabase(sourcePath, join(dir, "backups", "snapshot.db"));

    const after = new Database(sourcePath, { fileMustExist: true });
    try {
      expect(after.pragma("journal_mode", { simple: true })).toBe("delete");
    } finally {
      after.close();
    }
  });

  it("4: refuses a destination that already exists, and leaves its bytes byte-for-byte unchanged", async () => {
    const sourcePath = fixture.path();
    runMigrations(sourcePath);

    const destination = join(dirname(sourcePath), "backups", "taken.db");
    mkdirSync(dirname(destination), { recursive: true });
    const originalBytes = Buffer.from("not a real backup, just a marker file");
    writeFileSync(destination, originalBytes);

    await expect(backupDatabase(sourcePath, destination)).rejects.toThrow(BackupRefusedError);

    expect(readFileSync(destination)).toEqual(originalBytes);
  });

  it("5: a source path containing a newline is refused via the losslessPath escape, never a raw control character", async () => {
    // A legal POSIX filename containing a newline, mirroring the pinned pattern in
    // test/cli-db-migrate-command.test.ts's "renders an ESCAPED #46 recovery" case — deliberately
    // never created, since this scenario is about the MISSING-source refusal's message.
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const missingPath = join(dir, "no\nsuch.db");

    let caught: unknown;
    try {
      await backupDatabase(missingPath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BackupRefusedError);
    const message = (caught as Error).message;
    expect(message).toContain("path escaped");
    expect(message).toContain(losslessPath(missingPath));
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(message).not.toContain(LINE_SEPARATOR);
    expect(message).not.toContain(PARAGRAPH_SEPARATOR);
  });

  it("7: a snapshot that disagrees with the source throws BackupVerificationError, names the table, and is left on disk", async () => {
    const sourcePath = fixture.path();
    runMigrations(sourcePath);
    const seed = new Database(sourcePath);
    seed.exec("INSERT INTO teams (name) VALUES ('Norbury'), ('Rolling Hills')");
    seed.close();

    const destination = join(dirname(sourcePath), "backups", "short.db");

    // Spies on the REAL backup() call and lets it run to completion, then deliberately shortens the
    // file it just wrote — so this exercises "the readback disagreed with the source", not "the spy
    // fabricated a result the real .backup() never gives".
    const realBackup = Database.prototype.backup;
    const spy = vi
      .spyOn(Database.prototype, "backup")
      .mockImplementation(async function (this: InstanceType<typeof Database>, dest: string) {
        const metadata = await realBackup.call(this, dest);
        const corrupt = new Database(dest);
        corrupt.exec("DELETE FROM teams WHERE name = 'Rolling Hills'");
        corrupt.close();
        return metadata;
      });

    try {
      let caught: unknown;
      try {
        await backupDatabase(sourcePath, destination);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BackupVerificationError);
      expect((caught as Error).message).toContain("teams");
      // The documented behavior (Task 2, step 9): deleting the bad snapshot would destroy the only
      // evidence of what went wrong, so it stays on disk.
      expect(existsSync(destination)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("8: the backups directory is created when it doesn't exist yet", async () => {
    const sourcePath = fixture.path();
    runMigrations(sourcePath);
    const backupsDir = join(dirname(sourcePath), "backups");
    expect(existsSync(backupsDir)).toBe(false);

    const result = await backupDatabase(sourcePath);

    expect(existsSync(backupsDir)).toBe(true);
    expect(existsSync(result.destination)).toBe(true);
  });

  it("9: an empty but migrated source backs up successfully with rows=0 — empty is not broken", async () => {
    const sourcePath = fixture.path();
    runMigrations(sourcePath);

    const result = await backupDatabase(sourcePath);

    expect(result.rows).toBe(0);
    expect(result.tables.length).toBeGreaterThan(0);
    for (const t of result.tables) {
      expect(t.source).toBe(0);
      expect(t.backup).toBe(0);
    }
  });
});

// Scenario 6: `compareTableCounts` is pure, so it is tested directly against synthetic maps rather
// than through a real database — the exhaustive case list the plan calls out, both directions.
// Verify-stage adversarial finding (issue #110, fail-open lens). `new Database(path, {fileMustExist:
// true})` raises the SAME `SQLITE_CANTOPEN` for a database that is ABSENT and one that is merely
// UNREADABLE — verified: a chmod-000 file and a directory-at-the-path both throw it, while
// `existsSync` is true for the latter two. Reporting "no database — nothing to back up" for all
// three tells an operator whose database exists but cannot be opened that they have nothing to lose,
// which is the most dangerous wrong answer a BACKUP command can give.
//
// A directory at the source path is the fixture rather than chmod 000, deliberately: permission bits
// are bypassed when the suite runs as root (a routine CI container configuration), so a chmod-based
// test would silently stop exercising this on exactly the machine nobody watches.
describe("an unreadable source is distinguished from an absent one (issue #110, verify stage)", () => {
  it("does not claim there is nothing to back up when the source exists but cannot be opened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const sourcePath = join(dir, "iam-a-directory.db");
    mkdirSync(sourcePath);

    const error = await backupDatabase(sourcePath).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BackupRefusedError);
    const message = (error as Error).message;
    // The path is still named — that half was never wrong.
    expect(message).toContain(sourcePath);
    // ...but the diagnosis must not be the absent-file one, and must carry the real cause.
    expect(message).not.toContain("nothing to back up");
    expect(message.toLowerCase()).toContain("unable to open database file");
  });

  it("still reports a genuinely absent source as absent", async () => {
    // The other side of the same branch — without this, the assertion above is satisfied by a
    // version that simply deleted the absent-source message entirely.
    const dir = mkdtempSync(join(tmpdir(), "tn-"));

    const error = await backupDatabase(join(dir, "never-existed.db")).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BackupRefusedError);
    expect((error as Error).message).toContain("nothing to back up");
  });
});

// Plan amendment 1 (issue #110). better-sqlite3 trims the filename it is handed — in BOTH
// `new Database(filenameGiven)` (lib/database.js:30) and `db.backup(filename)`
// (lib/methods/backup.js:8) — while `path.resolve` preserves trailing whitespace
// (`resolve("/tmp/x/nadal.db ")` === `"/tmp/x/nadal.db "`, verified). So a `TN_DB_PATH` with a
// trailing space makes the driver open a DIFFERENT file than the one every message reports, and
// GRAMMAR.md explicitly promises such a value round-trips unchanged — which makes this reachable
// through the documented configuration surface rather than only through a direct JS call.
describe("silent-trim refusal (issue #110 plan amendment 1)", () => {
  it("refuses a source path whose own trim differs from it, rather than backing up the trimmed sibling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const realPath = join(dir, "source.db");
    runMigrations(realPath);
    const seed = new Database(realPath);
    seed.exec("INSERT INTO teams (name) VALUES ('Norbury')");
    seed.close();

    // The assertion that makes this about the TRIM rather than about a missing file: the trimmed
    // sibling genuinely EXISTS and is a perfectly good database. Without the guard, `fileMustExist`
    // is satisfied by it, the backup succeeds, and every reported path names a file that was never
    // read. A fixture pointing at a nonexistent path would pass on the pre-existing "no source"
    // refusal and prove nothing about trimming.
    await expect(backupDatabase(`${realPath} `)).rejects.toThrow(BackupRefusedError);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  // The other half of amendment 1, and the reason it is a SEPARATE guard checked BEFORE `resolve()`:
  // afterwards neither condition can fire (`resolve("")` returns the cwd, `resolve(":memory:")`
  // returns `{cwd}/:memory:`), so a post-resolve check would be two branches no fixture could kill.
  // Pre-resolve, on the raw parameter, both are reachable — which is what makes these tests possible
  // at all, and is the correction to an earlier reading that called the guard itself unreachable.
  it("refuses an empty destination rather than letting the driver raise a bare TypeError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const sourcePath = join(dir, "source.db");
    runMigrations(sourcePath);

    const error = await backupDatabase(sourcePath, "   ").catch((err: unknown) => err);

    // The class matters as much as the refusal: an unguarded call surfaces better-sqlite3's own
    // `TypeError("Backup filename cannot be an empty string")`, which names neither this command nor
    // this module's error type, so a caller catching BackupRefusedError would miss it entirely.
    expect(error).toBeInstanceOf(BackupRefusedError);
    expect((error as Error).message).toContain("empty destination");
  });

  it("refuses \":memory:\" as a destination — a backup must be a real file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const sourcePath = join(dir, "source.db");
    runMigrations(sourcePath);

    const error = await backupDatabase(sourcePath, ":memory:").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BackupRefusedError);
    expect((error as Error).message).toContain(":memory:");
  });

  it("refuses a destination path whose own trim differs from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const sourcePath = join(dir, "source.db");
    runMigrations(sourcePath);

    await expect(backupDatabase(sourcePath, `${join(dir, "snap.db")} `)).rejects.toThrow(BackupRefusedError);
    // `.backup()` would have written to the TRIMMED name; nothing may exist at either spelling.
    expect(existsSync(join(dir, "snap.db"))).toBe(false);
  });
});

// Codex adversarial review of PR #115, finding 2 [medium, class A] — CONFIRMED by probe before
// fixing, not accepted on assertion.
describe("a legal table name containing a double quote (Codex finding 2)", () => {
  it("counts and verifies a table whose name contains a double quote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const sourcePath = join(dir, "source.db");
    runMigrations(sourcePath);

    // `CREATE TABLE "odd""name"` is SQLite's own escaping: the resulting table is named with the 8
    // characters `odd"name`, which is exactly what `sqlite_master` hands back. Before the fix, the
    // un-escaped interpolation built `... FROM "odd"name"` and SQLite rejected it with
    // `unrecognized token: """` — so the command could not back up this database at all.
    const seed = new Database(sourcePath);
    seed.exec('CREATE TABLE "odd""name" (v)');
    seed.exec('INSERT INTO "odd""name" VALUES (1), (2)');
    seed.exec("INSERT INTO teams (name) VALUES ('Norbury')");
    seed.close();

    const result = await backupDatabase(sourcePath);

    // The table is not merely tolerated — it is actually counted and actually verified, which is the
    // claim the doc comment makes about structure-derived enumeration.
    const odd = result.tables.find((t) => t.table === 'odd"name');
    expect(odd, 'the double-quoted table was not in the verified set').toBeDefined();
    expect(odd?.source).toBe(2);
    expect(odd?.backup).toBe(2);
  });
});

// Codex adversarial review of PR #115, finding 1 [medium, class A] — REFUTED, and pinned here so the
// refutation is executable rather than a sentence in a review reply.
//
// The finding held that a `.backup()` rejecting mid-copy leaves a partial, unlabelled `.db` in the
// backups directory. Directly observed instead: better-sqlite3 removes the file it created.
// `runBackup` (lib/methods/backup.js) wraps the whole transfer loop in one try/catch whose handler
// calls `backup.close()` before rejecting, and the native close unlinks a destination it created
// (`isNewFile`). EVERY rejection path — a `transfer()` failure such as the finding's SQLITE_FULL, or
// a throw from the progress handler — lands in that same catch.
//
// This test exists because the refutation depends on a THIRD-PARTY library's behavior. A
// better-sqlite3 upgrade that stopped cleaning up would silently reintroduce exactly the hazard the
// finding described, and nothing else in this suite would notice. If this goes red, the finding was
// right about the newer version and `backupDatabase` needs the cleanup it currently does not.
describe("better-sqlite3 removes its own partial destination on a failed copy (Codex finding 1)", () => {
  it("creates the destination during the copy and unlinks it when the copy rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const sourcePath = join(dir, "source.db");
    const seed = new Database(sourcePath);
    seed.exec("CREATE TABLE t (v)");
    const insert = seed.prepare("INSERT INTO t VALUES (?)");
    // Enough pages that the transfer is genuinely multi-step and the destination is created before
    // the first `progress` callback fires — without that, the mid-copy observation below proves
    // nothing, because a single-page copy could complete before anything could interrupt it.
    seed.transaction(() => {
      for (let i = 0; i < 20000; i++) insert.run(`row-${i}-${"x".repeat(80)}`);
    })();

    const destination = join(dir, "interrupted.db");
    let existedMidCopy: boolean | null = null;

    await expect(
      seed.backup(destination, {
        progress() {
          if (existedMidCopy === null) existedMidCopy = existsSync(destination);
          throw new Error("simulated mid-copy failure");
        },
      }),
    ).rejects.toThrow("simulated mid-copy failure");
    seed.close();

    // Both halves are the assertion. Without the first, "the file is absent" would also pass on a
    // library that never created it, and the test would say nothing about cleanup at all.
    expect(existedMidCopy, "the destination was never created, so cleanup is untested").toBe(true);
    expect(existsSync(destination), "better-sqlite3 left a partial destination behind").toBe(false);
  });
});

describe("compareTableCounts — pure, exhaustive (issue #110 scenario 6)", () => {
  it("equal maps produce no disagreements", () => {
    const source = new Map([["teams", 3], ["players", 5]]);
    const backup = new Map([["teams", 3], ["players", 5]]);
    expect(compareTableCounts(source, backup)).toEqual([]);
  });

  it("an unequal count is reported for that table only", () => {
    const source = new Map([["teams", 3], ["players", 5]]);
    const backup = new Map([["teams", 3], ["players", 4]]);
    expect(compareTableCounts(source, backup)).toEqual([{ table: "players", source: 5, backup: 4 }]);
  });

  it("a table missing from the backup is reported", () => {
    const source = new Map([["teams", 3], ["players", 5]]);
    const backup = new Map([["teams", 3]]);
    expect(compareTableCounts(source, backup)).toEqual([{ table: "players", source: 5, backup: 0 }]);
  });

  it("a table present only in the backup is reported — a one-way containment is not enough", () => {
    const source = new Map([["teams", 3]]);
    const backup = new Map([["teams", 3], ["players", 5]]);
    expect(compareTableCounts(source, backup)).toEqual([{ table: "players", source: 0, backup: 5 }]);
  });
});
