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

    // The regression guard against ever routing this check back through `openDb()`, which
    // `mkdirSync`s the parent as a side effect of merely checking whether the source exists.
    expect(existsSync(missingPath)).toBe(false);
    expect(existsSync(missingDir)).toBe(false);
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

  it("refuses a destination path whose own trim differs from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const sourcePath = join(dir, "source.db");
    runMigrations(sourcePath);

    await expect(backupDatabase(sourcePath, `${join(dir, "snap.db")} `)).rejects.toThrow(BackupRefusedError);
    // `.backup()` would have written to the TRIMMED name; nothing may exist at either spelling.
    expect(existsSync(join(dir, "snap.db"))).toBe(false);
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
