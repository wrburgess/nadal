import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DatabaseBehindMigrationsError,
  applyMigrations,
  openDb,
  pendingMigrationCount,
  runMigrations,
} from "../src/db/client.js";
import { logRequest } from "../src/telemetry/request-log.js";
import { MIGRATIONS_FOLDER, migrateToAllButLast } from "./helpers/migrations.js";
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

  it("PARITY: the checker and the migrator agree about what 'current' means, across the whole journal", () => {
    // The hazard this kills: a checker that agrees with `applyMigrations` by coincidence looks
    // identical to one that agrees by construction. Both read the same single-watermark rule
    // (`Number(watermark) < folderMillis`), so walking the journal from empty to full must show
    // pendingMigrationCount hitting zero at exactly the point applyMigrations stops doing work.
    const sqlite = new Database(fixture.path());
    const available = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length;

    expect(pendingMigrationCount(sqlite)).toBe(available);
    applyMigrations(sqlite, MIGRATIONS_FOLDER);
    expect(pendingMigrationCount(sqlite)).toBe(0);

    // A second application is a no-op for the migrator; the checker must still say zero rather
    // than re-counting anything as pending.
    applyMigrations(sqlite, MIGRATIONS_FOLDER);
    expect(pendingMigrationCount(sqlite)).toBe(0);
    sqlite.close();
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
