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

export function runMigrations(path: string = dbPath()): void {
  const { db, sqlite } = openDb(path);
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    // Issue #32: keys every row `migrate()` didn't (a fresh DB has none to backfill; an existing
    // DB upgrading past migration 0004 does). JS-side, idempotent — see backfillNameKeys's doc.
    backfillNameKeys(db);
  } finally {
    sqlite.close();
  }
}
