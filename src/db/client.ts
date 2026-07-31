import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
/**
 * POSIX single-quote wrapping for a path interpolated into a copy-pasteable shell command. The
 * database path is caller-supplied (`TN_DB_PATH`, or a `runMigrations(path)` argument), so it can
 * contain spaces — an unquoted `mv /tmp/my db.db …` would silently become a two-source `mv`.
 * Unconditional rather than "quote only if it looks unsafe": a conditional would be a branch whose
 * false side no fixture in this repo distinguishes (`rules/testing.md`).
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A backup path for `dbPath` that is **not already taken**. The first draft of the recovery moved
 * the database to a FIXED `<path>.pre-0006.bak`, which meant a SECOND failure overwrote the FIRST
 * backup — silently destroying the captain notes and availability the same message promises are
 * safe (Codex adversarial review round 2, rated high: the fix for a data-loss hazard reintroducing
 * one). Checking what is on disk closes it by construction rather than by warning the reader.
 *
 * Both sides of the branch are reachable and test-pinned (`test/db-teams-url-unique-upgrade.test.ts`):
 * the plain name on a first failure, the disambiguated one when a backup already exists. The
 * residual TOCTOU — a backup appearing between this message and the human running it — is covered
 * separately by `mv -i`, which is why that flag is not redundant with this function.
 */
function untakenBackupPath(dbPath: string): string {
  const preferred = `${dbPath}.pre-0006.bak`;
  return existsSync(preferred) ? `${dbPath}.pre-0006.${Date.now()}.bak` : preferred;
}

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
        // ABSOLUTE, always. Two reasons, and the second is the load-bearing one:
        //   1. the reader may not be in the directory the run used, so a relative path in a
        //      copy-pasteable recovery command is a trap;
        //   2. an absolute path cannot begin with `-`, so it can never be parsed as an OPTION —
        //      which closes the dash-prefixed-`TN_DB_PATH` hazard structurally rather than relying
        //      on the `--` terminator alone (Codex round 3; see the note on `--` below).
        const source = resolve(path);
        throw new Error(
          `${chain}\n\n` +
            `This database (${source}) has two team rows sharing the same tennisrecord_url ` +
            "(issue #46) — migration 0006's unique index cannot apply until that is resolved.\n\n" +
            "Recovery — moves the database aside rather than deleting it, so nothing is lost. " +
            "`-i` refuses to overwrite silently if a backup appeared since this message; `--` ends " +
            "option parsing (kept as belt-and-braces — the absolute paths above already cannot be " +
            "read as options):\n" +
            `  mv -i -- ${shellQuote(source)} ${shellQuote(untakenBackupPath(source))} && tn db migrate\n\n` +
            "Then re-pull. Rosters, ratings and match history are all re-derivable from the " +
            "archived raw/ pages, but captain notes and availability exist ONLY in this file — " +
            "extract those from the backup first if you recorded any " +
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
