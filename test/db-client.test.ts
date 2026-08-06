import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DB_PATH, MissingDatabaseError, dbPath, openDb, runMigrations } from "../src/db/client.js";
import { PACKAGE_ROOT } from "../src/fs/package-root.js";
import { playerAliases, players, teams } from "../src/db/schema.js";
import { restoreTnDbPathAfterEach } from "./helpers/tn-db.js";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
}

describe("dbPath()", () => {
  restoreTnDbPathAfterEach();

  // Issue #111: this used to assert `dbPath() === DEFAULT_DB_PATH` — tautological, and it passed
  // identically whether or not the returned path was anchored at all. The real contract is that the
  // *unset* default resolves to an ABSOLUTE path under the package root, not the bare relative
  // string a caller's own cwd could reinterpret.
  it("falls back to an absolute, package-root-anchored path when TN_DB_PATH is unset", () => {
    delete process.env.TN_DB_PATH;
    expect(dbPath()).toBe(join(PACKAGE_ROOT, DEFAULT_DB_PATH));
    expect(resolve(dbPath())).toBe(dbPath());
  });

  it("honors TN_DB_PATH verbatim when set to an absolute path", () => {
    process.env.TN_DB_PATH = "/tmp/tn-custom-path.db";
    expect(dbPath()).toBe("/tmp/tn-custom-path.db");
  });

  // The documented decision (issue #111): an override is used VERBATIM, so a relative
  // `TN_DB_PATH` stays resolved against the CALLER's cwd, not re-anchored to the package root the
  // way the unset default is. `??` (not `||`) is what makes this true even for an empty string.
  it("honors TN_DB_PATH verbatim when set to a relative path — it is not re-anchored", () => {
    process.env.TN_DB_PATH = "relative/tn.db";
    expect(dbPath()).toBe("relative/tn.db");
  });

  it("treats an empty-string TN_DB_PATH as a set (not unset) value", () => {
    process.env.TN_DB_PATH = "";
    expect(dbPath()).toBe("");
  });
});

describe("openDb() + schema", () => {
  it("round-trips rows through the generated schema and its column mapping", () => {
    const path = freshDbPath();
    runMigrations(path);
    const { db, sqlite } = openDb(path);

    db.insert(teams).values({ name: "IA/Versteeg/40&Over3.5M", section: "Iowa" }).run();
    const foundTeams = db.select().from(teams).all();
    expect(foundTeams).toHaveLength(1);
    expect(foundTeams[0]?.name).toBe("IA/Versteeg/40&Over3.5M");
    expect(foundTeams[0]?.section).toBe("Iowa");

    db.insert(players).values({ canonicalName: "Jane Doe" }).run();
    const foundPlayers = db.select().from(players).all();
    expect(foundPlayers).toHaveLength(1);
    const player = foundPlayers[0]!;
    expect(player.canonicalName).toBe("Jane Doe");

    db.insert(playerAliases).values({ playerId: player.id, alias: "J. Doe" }).run();
    const foundAliases = db.select().from(playerAliases).all();
    expect(foundAliases).toHaveLength(1);
    expect(foundAliases[0]?.alias).toBe("J. Doe");
    expect(foundAliases[0]?.playerId).toBe(player.id);

    sqlite.close();
  });
});

// Issue #111 Task 5: a missing database used to be silently bootstrapped into existence (an
// unconditional `mkdirSync` plus a create-happy `new Database(path)`), so a command run before `tn
// db migrate` reported `status=ok` against a database with no tables at all. `openDb()` now
// refuses by default, and `create: true` (only `runMigrations`'s own choice) is what still creates.
describe("openDb() vs. a missing database (issue #111)", () => {
  it("throws MissingDatabaseError naming the resolved absolute path, creating neither the file nor its parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-missing-db-"));
    const nestedPath = join(dir, "nested", "test.db"); // parent "nested" does not exist yet either

    let caught: unknown;
    try {
      openDb(nestedPath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MissingDatabaseError);
    expect((caught as Error).message).toContain(resolve(nestedPath));
    expect((caught as Error).message).toContain("tn db migrate");
    // The exact silent-directory-creation this issue fixes: today's unconditional `mkdirSync`
    // would have created "nested" even though the open itself failed.
    expect(existsSync(join(dir, "nested"))).toBe(false);
    expect(existsSync(nestedPath)).toBe(false);
  });

  it("openDb(path, { create: true }) creates a fresh database file and its parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-create-db-"));
    const nestedPath = join(dir, "nested", "fresh.db");

    const { sqlite } = openDb(nestedPath, { create: true });
    try {
      expect(existsSync(nestedPath)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  // Codex adversarial review, PR #116, [medium], class A. The first version of this guard asked
  // `!existsSync(path)` and called any false answer "the database is missing". But `existsSync` is
  // false for a path whose PARENT is a regular file (ENOTDIR) and for one whose parent is not
  // traversable (EACCES) just as it is for a genuinely absent file — and better-sqlite3 reports the
  // SAME `SQLITE_CANTOPEN` for all three, so the SQLite error code cannot separate them either
  // (measured; it is why the reviewer's own suggested "classify by the SQLite errno" fix does not
  // work). The result was that a misconfigured `TN_DB_PATH` told the operator to run `tn db
  // migrate` — which cannot repair ENOTDIR — while `writeRequestLogRow`'s MissingDatabaseError
  // carve-out silently swallowed the real storage failure. Only the raw `open(2)` errno separates
  // them, which is what `openFailureCode` now uses.
  //
  // ENOTDIR is the case pinned here because it is deterministic for any user. The EACCES sibling is
  // deliberately not asserted: `chmod 000` does not stop a process running as root, so the test
  // would silently pass for the wrong reason in a root container.
  it("does NOT call it a missing database when the path is unopenable for a different reason (parent is a regular file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-enotdir-"));
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a regular file, not a directory");
    const throughAFile = join(blocker, "nadal.db");

    // The precondition that made the old guard wrong: the path does not "exist", yet it is not absent.
    expect(existsSync(throughAFile)).toBe(false);

    let caught: unknown;
    try {
      openDb(throughAFile);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(MissingDatabaseError);
    // The operator must not be told to run a command that cannot fix this.
    expect((caught as Error).message).not.toContain("tn db migrate");
  });

  // Codex adversarial review, PR #116, fix-verification pass 1, [medium], class A — a defect in the
  // FIX, not in the original change. A dangling symlink reads as ENOENT through `open(2)` exactly
  // like a database that has simply never been bootstrapped, so no errno check can separate them,
  // and `tn db migrate` cannot repair it (it would `mkdirSync` the LINK's directory, which already
  // exists, and SQLite would still fail to create the target).
  //
  // The resolution was to stop the message from PROMISING a remedy rather than to keep sharpening
  // the predicate — `lstat` fixes this row but breaks a legitimate symlink-to-an-uncreated-database,
  // and a third revision would have had its own row. So what this test pins is the CLAIM, not the
  // classification: whatever the message says must be true here too.
  it("does not promise that `tn db migrate` will fix a dangling symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-dangling-"));
    const link = join(dir, "db-link");
    symlinkSync(join(dir, "missing-parent", "nadal.db"), link);

    let caught: unknown;
    try {
      openDb(link);
    } catch (err) {
      caught = err;
    }

    const message = (caught as Error).message;
    // It still names the real path and still offers the remedy — but CONDITIONALLY.
    expect(message).toContain(resolve(link));
    expect(message).toContain("if it has not been created yet");
    // The exact promise the reviewer showed to be false must not be present in any form.
    expect(message).not.toMatch(/run `tn db migrate` to create it/);
  });

  it("rethrows the original error when the file exists but the open still fails for an unrelated reason", () => {
    // A directory at the exact leaf path a database open would use: better-sqlite3's own open
    // fails (it is not a valid SQLite file), but `existsSync(path)` reports true, so this must NOT
    // be reclassified as MissingDatabaseError — the two failures are different and the message must
    // stay the real one, not a misleading "run tn db migrate" pointed at a path that already exists.
    const dir = mkdtempSync(join(tmpdir(), "tn-not-a-db-"));
    const notADbFile = join(dir, "not-a-database");
    mkdirSync(notADbFile);

    let caught: unknown;
    try {
      openDb(notADbFile);
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeInstanceOf(MissingDatabaseError);
    expect(caught).toBeInstanceOf(Error);
  });

  it("still rethrows the original error for a create:true open against a path that exists but is not a database", () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-not-a-db-create-"));
    const notADbFile = join(dir, "garbage.db");
    writeFileSync(notADbFile, "not a sqlite file");

    let caught: unknown;
    try {
      openDb(notADbFile, { create: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeInstanceOf(MissingDatabaseError);
    expect(caught).toBeInstanceOf(Error);
  });
});
