import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillNameKeys } from "./name-key.js";

export const DEFAULT_DB_PATH = "data/nadal.db";

export type OpenDbOptions = {
  // Issue #32, ask #4 (test/identity-query-count.test.ts): better-sqlite3's `new Database(path, {
  // verbose })` invokes `verbose` with every SQL statement the connection executes — this is the
  // observation seam the query-count test uses to assert resolution issues a constant number of
  // statements regardless of table size, rather than one per row.
  verbose?: (message?: unknown, ...args: unknown[]) => void;
};

// drizzle-orm's migrator resolves `migrationsFolder` with plain `fs` calls against
// `process.cwd()` — it does no path resolution of its own. Anchor to this module's own
// location (repo root, two levels up from src/db/) so `tn db migrate` finds the migrations
// regardless of the caller's working directory.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(MODULE_DIR, "..", "..", "drizzle");

export function dbPath(): string {
  return process.env.TN_DB_PATH ?? DEFAULT_DB_PATH;
}

export function openDb(path: string = dbPath(), options: OpenDbOptions = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = options.verbose !== undefined ? new Database(path, { verbose: options.verbose }) : new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { sqlite, db: drizzle(sqlite) };
}

// Issue #46: a pre-existing database holding a duplicate `teams.tennisrecord_url` pair (the exact
// damage #46 fixes) makes migration 0006's `CREATE UNIQUE INDEX` fail with a bare "UNIQUE
// constraint failed: teams.tennisrecord_url" — legible to nobody who hasn't read this migration.
// Shipping no dedupe DML for that pair is a deliberate choice (a same-URL rename collision is a
// merge decision, out of bounds per spec § Ingestion, same as `upsertTeam`'s own
// `AmbiguousIdentityError`), so THIS message is the whole mitigation: it names the cause and the
// one-line recovery rather than silently leaving `tn db migrate` broken. See
// docs/runbooks/db-migration-recovery.md for the full runbook this line is drawn from.
const TEAMS_URL_UNIQUE_FAILURE = /UNIQUE constraint failed: teams\.tennisrecord_url/;

/**
 * drizzle-orm's `SQLiteSyncDialect` wraps every failed migration statement in a `DrizzleError`
 * whose OWN message is the generic `Failed to run the query '<sql>'` — the actual
 * better-sqlite3 message ("UNIQUE constraint failed: ...") lives on `.cause` (native `Error.cause`,
 * which `DrizzleError`'s constructor sets). Walking the whole chain rather than checking two fixed
 * levels keeps this matching if a future drizzle-orm version stops wrapping, or wraps one deeper.
 *
 * Written as a walk, not as `err instanceof Error ? … : String(err)` guards, for a testing reason
 * (`rules/testing.md`: never keep a branch no test can kill). Those guards cannot fail in this
 * codebase — `migrate()`'s throw is always an `Error` — so no fixture distinguishes them, and an
 * unkillable branch reads as coverage to every later reader. The loop condition has no such
 * problem: it is exercised in both directions on every call (true for the DrizzleError, true for
 * its cause, false at the end of the chain), so a mutation to it is caught. A non-`Error` throw
 * yields `""` here, which matches no pattern and so falls through to the `throw err` below — the
 * original is re-thrown untouched, which is what the discarded `String(err)` branch was for.
 */
function messageChain(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

export function runMigrations(path: string = dbPath()): void {
  const { db, sqlite } = openDb(path);
  try {
    try {
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } catch (err) {
      const chain = messageChain(err);
      if (TEAMS_URL_UNIQUE_FAILURE.test(chain)) {
        throw new Error(
          `${chain}\n\n` +
            "This database has two team rows sharing the same tennisrecord_url (issue #46) — " +
            "migration 0006's unique index cannot apply until that is resolved.\n" +
            "Recovery: rm data/nadal.db && tn db migrate, then re-pull. The database is a " +
            "disposable cache over the archived raw/, not a system of record " +
            "(docs/runbooks/db-migration-recovery.md).",
        );
      }
      throw err;
    }
    // Issue #32: keys every row `migrate()` didn't (a fresh DB has none to backfill; an existing
    // DB upgrading past migration 0004 does). JS-side, idempotent — see backfillNameKeys's doc.
    backfillNameKeys(db);
  } finally {
    sqlite.close();
  }
}
