import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMigrations, enableWal, openDb, runMigrations } from "../src/db/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(HERE, "..", "drizzle");

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-serial-")), "test.db");
}

/** Everything a comparison between two migration implementations should see. */
function snapshot(path: string): { schema: unknown[]; journal: unknown[] } {
  const sqlite = new Database(path, { fileMustExist: true });
  const schema = sqlite
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all();
  const journal = sqlite
    .prepare('SELECT hash, created_at FROM "__drizzle_migrations" ORDER BY created_at')
    .all();
  sqlite.close();
  return { schema, journal };
}

/** A throwaway migrations folder holding one migration whose SQL is exactly `sql`. */
function singleMigrationFolder(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tn-onemig-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [{ idx: 0, version: "6", when: 1785000000000, tag: "0000_probe", breakpoints: true }],
    }),
  );
  writeFileSync(join(dir, "0000_probe.sql"), sql);
  return dir;
}

/** Bootstrap a database the way drizzle's own migrator would, bypassing `runMigrations` entirely. */
function migrateWithDrizzle(path: string): void {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  sqlite.close();
}

/** Every SQL statement one `runMigrations` call issued, in order, via `openDb`'s `verbose` seam. */
function statementsFor(path: string): string[] {
  const seen: string[] = [];
  runMigrations(path, { verbose: (message) => seen.push(String(message)) });
  return seen;
}

const BEGIN_IMMEDIATE = /^\s*BEGIN\s+IMMEDIATE\s*;?\s*$/i;
const BEGIN_DEFERRED = /^\s*BEGIN\s*;?\s*$/i;
const JOURNAL_READ = /^\s*SELECT[\s\S]*__drizzle_migrations/i;

/**
 * Issue #117. The defect is an ORDERING one, and that is why it survived every existing test: a
 * finished database cannot show the order its statements arrived in, so `test/db-migrate.test.ts`'s
 * "creates every table" and "is idempotent" assertions are both true before and after the fix.
 *
 * drizzle-orm 0.45.2's `SQLiteSyncDialect.migrate` runs `CREATE TABLE IF NOT EXISTS
 * __drizzle_migrations` and then `SELECT … ORDER BY created_at DESC LIMIT 1` in AUTOCOMMIT, and only
 * then issues a **deferred** `BEGIN`. So the decision of what to apply is made outside the
 * transaction that applies it, and a second process that read the same empty journal replays
 * migration 0000 over tables the first process has since committed.
 *
 * Asserting the ORDER is what makes this deterministic. The alternative — racing two processes —
 * is `test/db-migrate-concurrent.test.ts`, which proves the whole path end to end but can only ever
 * be probabilistic about catching a regression. This test cannot miss one.
 */
describe("tn db migrate — the migration journal is read under the write lock (#117)", () => {
  it("takes BEGIN IMMEDIATE before reading __drizzle_migrations, so no other process can commit in between", () => {
    const seen = statementsFor(freshDbPath());

    const begin = seen.findIndex((s) => BEGIN_IMMEDIATE.test(s));
    const journalRead = seen.findIndex((s) => JOURNAL_READ.test(s));

    expect(begin, "no BEGIN IMMEDIATE was issued at all").toBeGreaterThanOrEqual(0);
    expect(journalRead, "the migration journal was never read").toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(journalRead);
  });

  it("issues no deferred BEGIN — a deferred transaction takes the write lock late, which is the same hole", () => {
    // `BEGIN` alone acquires nothing until its first write, so a journal read inside one is still
    // stale by the time the writes it decided on run. Pinned separately from the ordering assertion
    // above because a fix that moved the read inside a DEFERRED transaction would satisfy that one
    // and still be wrong.
    expect(statementsFor(freshDbPath()).filter((s) => BEGIN_DEFERRED.test(s))).toEqual([]);
  });

  it("creates the bookkeeping table inside the same transaction, not ahead of it", () => {
    const seen = statementsFor(freshDbPath());
    const begin = seen.findIndex((s) => BEGIN_IMMEDIATE.test(s));
    const bookkeeping = seen.findIndex((s) => /CREATE TABLE IF NOT EXISTS[\s\S]*__drizzle_migrations/i.test(s));

    // `begin >= 0` FIRST, and it is not ceremony: `findIndex` returns -1 when there is no
    // BEGIN IMMEDIATE at all, and `-1 < bookkeeping` is true for every index — so without this the
    // assertion below passes precisely on the unfixed code it exists to reject. Caught by running
    // this test red before the fix, where it was the one case that came back green.
    expect(begin, "no BEGIN IMMEDIATE was issued at all").toBeGreaterThanOrEqual(0);
    expect(bookkeeping, "the bookkeeping table was never created").toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(bookkeeping);
  });
});

/**
 * The cost of #117's fix is that `applyMigrations` now owns ~25 lines drizzle owned before, and the
 * risk that buys is **silent** drift: a drizzle-orm upgrade that changes the journal format or the
 * watermark rule would leave this copy applying migrations by the old rule against databases written
 * under the new one, with nothing in a green suite to say so.
 *
 * This is the whole mitigation, and it works by re-deriving the claim every run rather than trusting
 * a comment: both implementations are pointed at the real `drizzle/` folder and their results are
 * compared row for row. It fails on exactly the upgrade that would otherwise be invisible.
 */
describe("applying migrations locally is equivalent to drizzle's own migrator (#117)", () => {
  it("produces a byte-identical sqlite_master and __drizzle_migrations on a fresh database", () => {
    const byDrizzle = freshDbPath();
    const byTn = freshDbPath();

    migrateWithDrizzle(byDrizzle);
    runMigrations(byTn);

    const expected = snapshot(byDrizzle);
    const actual = snapshot(byTn);

    // `sql` is compared too, not just the table names: SQLite stores a CREATE statement's text
    // verbatim, so this is what caught the bookkeeping DDL being written on one line with backticks
    // instead of drizzle's tabs — a functionally identical table that no name-only check would see.
    expect(actual.schema).toEqual(expected.schema);
    expect(actual.journal).toEqual(expected.journal);
  });

  it("re-applies nothing to a database drizzle already migrated, and records no new journal row", () => {
    // The upgrade path every existing nadal database is on: its journal was written by drizzle's
    // `migrate()`, and the local loop has to read that journal and reach the same conclusion.
    const path = freshDbPath();
    migrateWithDrizzle(path);
    const before = snapshot(path);

    const seen: string[] = [];
    runMigrations(path, { verbose: (message) => seen.push(String(message)) });

    expect(snapshot(path)).toEqual(before);
    // Not just "the end state matched" — that would also hold if it re-ran every migration and each
    // happened to be idempotent (they are not, but a reader cannot tell from the end state). Assert
    // it issued no journal write and ran no migration DDL at all.
    expect(seen.filter((s) => /INSERT INTO[\s\S]*__drizzle_migrations/i.test(s))).toEqual([]);
    expect(seen.filter((s) => /^\s*CREATE TABLE\s+`/i.test(s))).toEqual([]);
  });
});

/**
 * Both cases here came from the independent Reviewer on PR #120, and both were confirmed by running
 * the traces it supplied rather than by agreeing with them.
 *
 * They need a purpose-built migrations folder and a capped database for **different** reasons, and an
 * earlier version of this comment flattened the two into "neither is reachable through the real
 * migrations" — which the Reviewer corrected, rightly. A malformed multi-statement chunk genuinely
 * cannot occur in `drizzle/` today; `SQLITE_FULL` plainly *can*, on any of the twelve, the moment a
 * disk fills. The fixtures are here to make that second failure **deterministic and late enough in
 * the transaction to matter**, not to reach something otherwise unreachable.
 */
describe("applyMigrations fails loudly rather than quietly (#117, Reviewer round 1)", () => {
  it("refuses a migration chunk holding more than one statement", () => {
    // drizzle runs each chunk through `prepare().run()`, which rejects a multi-statement string.
    // The first revision of `applyMigrations` used `exec`, which runs them all — so a hand-authored
    // migration that forgot a `--> statement-breakpoint` would have executed both halves and
    // recorded itself as applied. This repo DOES hand-author migration DML (0001, 0010), so that is
    // a live shape, not a hypothetical.
    //
    // The reviewer's own trace, executed: with `exec` the `DROP TABLE` ran and `teams` was gone.
    const folder = singleMigrationFolder("CREATE TABLE audit (id integer);\nDROP TABLE teams;");
    const path = freshDbPath();
    const sqlite = new Database(path);
    sqlite.exec("CREATE TABLE teams (id integer primary key)");
    try {
      expect(() => applyMigrations(sqlite, folder)).toThrowError(/more than one statement/i);
      // The guard is worth nothing if the damage happened before the throw.
      const teams = sqlite
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'teams'")
        .get() as { count: number };
      expect(teams.count, "the rejected migration still dropped the table").toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("propagates the real error when SQLite has already rolled the transaction back itself", () => {
    // `BEGIN IMMEDIATE` outside the `try` proves a transaction OPENED, not that it is still open.
    // SQLite ends one itself on `SQLITE_FULL`, after which a bare `ROLLBACK` throws "cannot rollback
    // - no transaction is active" and REPLACES the real error — so the operator debugs the wrong
    // one. An earlier comment in `applyMigrations` asserted this was unreachable and that a guard
    // would be unkillable; the reviewer refuted it and measurement settled it.
    //
    // **The exact shape matters, and the first version of this test had it wrong.** A capped
    // database whose FIRST statement fails yields `inTransaction === true` — SQLite can still undo
    // one statement, so a bare ROLLBACK succeeds and the test passed against the unguarded code it
    // was written to reject. Measured across seven configurations: single-statement failures never
    // abandon the transaction; a failure AFTER earlier statements in the same transaction have
    // dirtied and spilled pages always does (7 of 7). That second shape is precisely
    // `applyMigrations` — dozens of statements under one `BEGIN IMMEDIATE` — so the migration below
    // is many small writes rather than one big one.
    const path = freshDbPath();
    const sqlite = new Database(path);
    try {
      // **Pin the page size, or this test quietly stops testing anything** — the Reviewer's round-2
      // finding, confirmed by replaying the shape across six page sizes. `max_page_count + 20` is a
      // budget in PAGES, so it is 80 KiB at 4 KiB pages but 640 KiB at 32 KiB — and at 32 KiB and
      // 64 KiB all 2000 inserts fit, no `SQLITE_FULL` occurs, and the case fails at "the capped
      // migration did not fail at all" instead of exercising the guard. Measured: 512 B → 40
      // statements before the cap, 4 KiB → 380, 8 KiB → 764, 16 KiB → 1542, 32 KiB and 64 KiB →
      // never. Pinned, it is 380 on every one of them.
      //
      // `page_size` must be set before any content AND before WAL (changing it under WAL needs a
      // VACUUM), so the order of these three lines is load-bearing.
      sqlite.pragma("page_size = 4096");
      sqlite.pragma("journal_mode = WAL");
      sqlite.exec("CREATE TABLE ballast (id integer primary key, pad text)");
      // Assert the pin TOOK, rather than trusting it: if a future SQLite ignored it, the case would
      // go back to silently passing for the wrong reason, which is precisely what it just did.
      expect(sqlite.pragma("page_size", { simple: true }), "page_size pin did not take").toBe(4096);
      // Enough headroom for the bookkeeping table and the early inserts to land, little enough that
      // the cap is hit long before the migration runs out of statements.
      const pages = sqlite.pragma("page_count", { simple: true }) as number;
      sqlite.pragma(`max_page_count = ${pages + 20}`);

      const inserts = Array.from(
        { length: 2000 },
        () => `INSERT INTO ballast (pad) VALUES ('${"x".repeat(200)}')`,
      ).join(";--> statement-breakpoint\n");

      let thrown: unknown;
      try {
        applyMigrations(sqlite, singleMigrationFolder(inserts));
      } catch (err) {
        thrown = err;
      }

      expect(thrown, "the capped migration did not fail at all").toBeDefined();
      expect((thrown as Error).message).toMatch(/database or disk is full/i);
      // The whole point: NOT the rollback's own error. An unconditional `ROLLBACK` surfaces
      // "cannot rollback - no transaction is active" here and buries the real cause.
      expect((thrown as Error).message).not.toMatch(/cannot rollback/i);
    } finally {
      sqlite.close();
    }
  });
});

/**
 * Issue #117's second mechanism, and the measurement that bounds it. `PRAGMA journal_mode = WAL`
 * does not honour SQLite's busy handler, so two processes converting one fresh database collide
 * before the migrator is reached at all.
 */
describe("enabling WAL is safe against a concurrent converter (#117)", () => {
  it("converts a fresh delete-mode database", () => {
    const path = freshDbPath();
    const sqlite = new Database(path);
    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("delete");

    enableWal(sqlite);

    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    sqlite.close();
  });

  it("is a no-op on an already-WAL database even while another connection holds the write lock", () => {
    // **This pins a PREMISE, not the retry** — flagged by the Reviewer, and the distinction is worth
    // keeping straight: it passes against the old one-line `sqlite.pragma("journal_mode = WAL")` too,
    // because on an already-WAL database that assignment is also a no-op under a held lock. That is
    // the point. The premise is what bounds the whole fix — it is why converting is contended and
    // re-asserting an existing mode is not, and therefore why the ~30 non-bootstrap `openDb` call
    // sites never contend. If SQLite or better-sqlite3 ever made this pragma take a lock
    // unconditionally, that bound would silently become false and this test is what would say so.
    // The retry itself is covered by the two cases below.
    const path = freshDbPath();
    runMigrations(path);

    const holder = new Database(path, { fileMustExist: true });
    holder.exec("BEGIN IMMEDIATE");
    try {
      const { sqlite } = openDb(path);
      expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      sqlite.close();
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("retries a contended conversion rather than failing on the first SQLITE_BUSY", () => {
    const path = freshDbPath();
    // Deliberately NOT converted to WAL: a delete-mode database with its write lock held is the one
    // state in which the conversion is refused, and it is held for the whole test, so this case is
    // deterministic rather than raced.
    const holder = new Database(path);
    holder.exec("CREATE TABLE placeholder (id integer primary key)");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO placeholder (id) VALUES (1)");

    const blocked = new Database(path, { fileMustExist: true });
    try {
      // A budget passed explicitly so the exhausted case costs ~3ms instead of the production 5s.
      // It must still THROW: silently returning a delete-mode database is the fail-open this whole
      // change exists to avoid.
      expect(() => enableWal(blocked, 3, 1)).toThrowError(/database is locked/);
      // ...and it must have spent its whole budget getting there, not bailed on attempt one.
      const attempts: string[] = [];
      const counted = new Database(path, { fileMustExist: true, verbose: (m) => attempts.push(String(m)) });
      expect(() => enableWal(counted, 3, 1)).toThrow();
      expect(attempts.filter((s) => /journal_mode\s*=\s*WAL/i.test(s))).toHaveLength(3);
      counted.close();
    } finally {
      blocked.close();
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("retries an EXTENDED busy code too, not only the bare SQLITE_BUSY", () => {
    // SQLite defines SQLITE_BUSY as a family and better-sqlite3 reports the extended name on
    // `.code` — measured: a write on a stale WAL read snapshot raises `SQLITE_BUSY_SNAPSHOT`, not
    // `SQLITE_BUSY`. A guard written as `code !== "SQLITE_BUSY"` therefore reads a
    // `SQLITE_BUSY_RECOVERY` during conversion as "not contention" and fails fast, reinstating the
    // very symptom the retry removes.
    //
    // Driven from a stub rather than a real database because the conversion path raises the BARE
    // code in every state reachable here — so the real database can only ever exercise the member
    // that was already covered, which is exactly how an enumeration bug survives a green suite.
    let calls = 0;
    const extendedBusy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY_RECOVERY" });
    const stub = {
      pragma(source: string) {
        if (!source.includes("=")) return "delete";
        calls += 1;
        throw extendedBusy;
      },
    } as unknown as Database.Database;

    expect(() => enableWal(stub, 3, 1)).toThrow(extendedBusy);
    expect(calls, "an extended busy code was not retried").toBe(3);
  });

  it("propagates a non-SQLITE_BUSY failure on the first attempt instead of retrying it", () => {
    // A readonly connection cannot convert, and the reason is not contention — so the retry loop
    // must fail fast rather than spend its whole 5s budget on an error more waiting cannot fix.
    //
    // **Counting the attempts is the assertion; the error type is not.** An earlier version of this
    // case asserted only `toThrowError(/read.?only/i)` and claimed in its own comment to kill the
    // `code !== "SQLITE_BUSY"` branch. It did not: with that guard removed the readonly error is
    // retried to exhaustion and then thrown, so the same assertion still passed. A mutation sweep
    // caught the claim outrunning the code. What distinguishes the two implementations is *how many
    // times the pragma runs*, so that is what this measures.
    const path = freshDbPath();
    const seed = new Database(path);
    seed.exec("CREATE TABLE placeholder (id integer primary key)");
    seed.close();

    const attempts: string[] = [];
    const readonly = new Database(path, {
      readonly: true,
      verbose: (message) => attempts.push(String(message)),
    });
    try {
      expect(readonly.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(() => enableWal(readonly, 3, 1)).toThrowError(/read.?only/i);
      expect(attempts.filter((s) => /journal_mode\s*=\s*WAL/i.test(s))).toHaveLength(1);
    } finally {
      readonly.close();
    }
  });
});
