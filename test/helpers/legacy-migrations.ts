import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_FOLDER = join(MODULE_DIR, "..", "..", "drizzle");

/**
 * Builds a throwaway migrations folder containing only migrations 0000-0003 — i.e. the schema as
 * it existed immediately BEFORE issue #32's migration 0004 added `name_key`. `drizzle-orm`'s
 * migrator (`readMigrationFiles` in `drizzle-orm/migrator`) only ever reads `meta/_journal.json`
 * and the `.sql` files it names — never the `meta/*_snapshot.json` files, which are drizzle-kit's
 * own diffing state — so copying just those two kinds of file is enough to reproduce "a DB
 * migrated up through 0003 and no further" for `test/db-name-key-backfill.test.ts`'s "an existing
 * local DB survives" scenario.
 *
 * Because the copied `.sql` files are byte-identical to the real ones, a LATER `runMigrations()`
 * call against the real (0000-0004) migrations folder re-hashes 0000-0003 to the same hash already
 * recorded in the DB's migrations table, recognizes them as already applied, and runs only 0004 —
 * exactly the "upgrade an existing DB" path this helper exists to construct.
 */
export function buildLegacyMigrationsFolder(throughIndex: number): string {
  const dir = mkdtempSync(join(tmpdir(), "tn-legacy-migrations-"));
  mkdirSync(join(dir, "meta"), { recursive: true });

  const journal = JSON.parse(
    readFileSync(join(REAL_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { version: string; dialect: string; entries: Array<{ idx: number; tag: string }> };

  const trimmedEntries = journal.entries.filter((entry) => entry.idx <= throughIndex);
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: trimmedEntries }, null, 2),
  );

  for (const entry of trimmedEntries) {
    copyFileSync(join(REAL_MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }

  return dir;
}
