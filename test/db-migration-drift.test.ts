import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DatabaseBehindMigrationsError,
  applyMigrations,
  openDb,
  pendingMigrationCount,
  runMigrations,
} from "../src/db/client.js";
import { logRequest } from "../src/telemetry/request-log.js";
import {
  MIGRATIONS_FOLDER,
  journalRowCount,
  migrateToAllButLast,
  migrateToPrefix,
  migrationTags,
} from "./helpers/migrations.js";
import { useTnDbPath } from "./helpers/tn-db.js";

/**
 * Part D of #160. A production database one migration behind `main` made every command reading
 * `players` through the ORM throw `SqliteError: no such column: plays`. Part A' guarantees that
 * error now reaches the operator; this part guarantees it says something an operator can ACT on —
 * "run `tn db migrate`" rather than a column name.
 *
 * Observed live 2026-08-13: the real database sat at 13 of 14 migrations for a day after PR #152
 * merged, and nothing anywhere said so.
 */

describe("migration drift is named rather than decoded (#160 part D)", () => {
  const fixture = useTnDbPath();

  it("a fully migrated database reports zero pending and opens normally", () => {
    runMigrations(fixture.path());

    const sqlite = new Database(fixture.path());
    expect(pendingMigrationCount(sqlite)).toBe(0);
    sqlite.close();

    expect(() => openDb(fixture.path()).sqlite.close()).not.toThrow();
  });

  it("a database one migration behind REFUSES, naming both counts and the command that fixes it", () => {
    const { applied, available } = migrateToAllButLast(fixture.path());

    let caught: unknown;
    try {
      openDb(fixture.path());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DatabaseBehindMigrationsError);
    // Both numbers, so the operator can tell "one behind" from "never bootstrapped", and the
    // remedy by name. Asserted on the whole message: a substring match cannot distinguish a
    // complete diagnostic from a truncated one, which is the class this whole issue is about.
    expect((caught as Error).message).toBe(
      `database at ${resolve(fixture.path())} is at ${applied} of ${available} migrations — run \`tn db migrate\``,
    );
  });

  it("`db migrate` is NOT locked out by its own guard — create:true still opens AND repairs a behind database", () => {
    // Without this exemption the fix is self-defeating: the one command that repairs drift could
    // no longer open a drifted database, and the only escape would be deleting it.
    migrateToAllButLast(fixture.path());

    expect(() => openDb(fixture.path(), { create: true }).sqlite.close()).not.toThrow();
    // The half that matters: it must actually migrate back to current, not merely open.
    expect(() => runMigrations(fixture.path())).not.toThrow();
    const sqlite = new Database(fixture.path());
    expect(pendingMigrationCount(sqlite)).toBe(0);
    sqlite.close();
    // And an ordinary open now succeeds, which is the operator-visible end of the repair.
    expect(() => openDb(fixture.path()).sqlite.close()).not.toThrow();
  });

  it("a database with no journal table at all reads as fully behind rather than crashing", () => {
    // The boundary below "one behind": a file that exists but was never bootstrapped. It must not
    // throw a raw `no such table: __drizzle_migrations` out of the checker itself.
    const sqlite = new Database(fixture.path());
    sqlite.exec("CREATE TABLE unrelated (id integer)");
    const available = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length;
    expect(pendingMigrationCount(sqlite)).toBe(available);
    sqlite.close();

    // And `db migrate` still bootstraps it from there.
    expect(() => runMigrations(fixture.path())).not.toThrow();
  });

  it("PARITY: at every prefix state, the checker's count equals the work the migrator actually does", () => {
    // The property, executed rather than asserted about: `pendingMigrationCount` must equal the
    // number of migrations `applyMigrations` GOES ON TO APPLY from that same state. A checker with
    // its own notion of "current" would eventually refuse a database `tn db migrate` considers
    // finished, and the two disagreeing is invisible at any single state — so this walks all of
    // them, 0 applied through N applied, and compares the prediction against the observed work.
    const total = migrationTags().length;
    expect(total).toBeGreaterThan(1); // a one-migration journal would make the walk vacuous

    for (let applied = 0; applied <= total; applied++) {
      const path = join(mkdtempSync(join(tmpdir(), "tn-parity-")), "db.sqlite");
      migrateToPrefix(path, applied);
      const sqlite = new Database(path);

      const predicted = pendingMigrationCount(sqlite);
      const before = journalRowCount(sqlite);
      applyMigrations(sqlite, MIGRATIONS_FOLDER);
      const actuallyApplied = journalRowCount(sqlite) - before;

      expect(predicted, `at ${applied} of ${total} applied`).toBe(actuallyApplied);
      // And having caught up, the checker says so — a second application is a no-op for the
      // migrator and must not be re-counted as pending.
      expect(pendingMigrationCount(sqlite), `after catching up from ${applied}`).toBe(0);
      applyMigrations(sqlite, MIGRATIONS_FOLDER);
      expect(pendingMigrationCount(sqlite)).toBe(0);
      sqlite.close();
    }
  });

  it("the checker reads the journal's own rule, not the migration folder's size", () => {
    // The limit of the walk above, closed here rather than left to a comment. Every state a prefix
    // walk can reach has `COUNT(*) === (migrations at or below the watermark)`, so that walk cannot
    // tell the watermark rule from `total - COUNT(*)` — both pass it. Verified by mutation: swapping
    // `migrationStatus`'s body for the row count leaves the whole drift suite green.
    //
    // A journal that is NOT a clean prefix separates them. An extra row — what a hand-repaired
    // journal or a re-run of a squashed migration leaves behind — makes the row count claim one
    // MORE migration is applied than the folder holds, while the watermark rule keeps answering the
    // question `applyMigrations` actually asks: is anything on disk newer than what I last applied?
    const path = join(mkdtempSync(join(tmpdir(), "tn-journal-")), "db.sqlite");
    const { available } = migrateToPrefix(path, migrationTags().length - 1);
    const sqlite = new Database(path);

    const watermark = sqlite
      .prepare(`SELECT created_at AS createdAt FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`)
      .get() as { createdAt: number };
    sqlite
      .prepare(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`)
      .run("a duplicate of an already-applied migration", watermark.createdAt);

    // Row count now says `available` are applied and nothing is pending. The watermark says the
    // newest migration on disk is still ahead of everything recorded — which is the truth, and is
    // what `applyMigrations` will act on.
    expect(journalRowCount(sqlite)).toBe(available);
    expect(pendingMigrationCount(sqlite)).toBe(1);

    const before = journalRowCount(sqlite);
    applyMigrations(sqlite, MIGRATIONS_FOLDER);
    expect(journalRowCount(sqlite) - before).toBe(1);
    sqlite.close();
  });

  it("a preflight that THROWS does not leak the handle it was checking", () => {
    // Contractor review of f1242fd, finding 1. The refusal branch closes explicitly; the branch
    // where `migrationStatus` itself throws did not, so `openDb` lost an open connection every
    // time. It matters in `tn mcp serve`, a long-lived process where `logMcpTool` re-throws and the
    // next request opens again — one leaked descriptor per failed call, forever.
    //
    // The state that reaches it: a `__drizzle_migrations` table that EXISTS but has no
    // `created_at`, so the `sqlite_master` probe finds the journal and the watermark query then
    // throws `no such column`. A partially restored backup or a hand-repaired journal is this.
    //
    // Observed rather than reasoned about: better-sqlite3 checkpoints and REMOVES `-wal`/`-shm`
    // when the last connection closes, so their survival is the leak, visible from the filesystem
    // and not from any counter this process could fake.
    const path = join(mkdtempSync(join(tmpdir(), "tn-leak-")), "db.sqlite");
    const seed = new Database(path);
    seed.exec(`CREATE TABLE "__drizzle_migrations" (id integer)`);
    seed.close();

    expect(() => openDb(path)).toThrow(/no such column/);

    expect(existsSync(`${path}-wal`), "a leaked connection keeps the WAL alive").toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it("telemetry stays silent on a behind database — one fault must not print two diagnostics", async () => {
    // `writeRequestLogRow` opens the database itself, so without an exemption a drifted database
    // would emit the drift refusal AND a "telemetry: request_log write failed" line. The operator
    // gets one fault, so they get one message. Same treatment MissingDatabaseError already has.
    migrateToAllButLast(fixture.path());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await logRequest("cli", "player show", [], async () => 0);

    expect(code).toBe(0);
    const telemetryLines = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes("telemetry: request_log write failed"),
    );
    expect(telemetryLines).toEqual([]);
  });
});
