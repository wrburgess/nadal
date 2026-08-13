import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../src/db/client.js";

export const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
);

/**
 * Builds a database migrated to all but the LAST migration — the exact shape of a checkout that has
 * pulled a new migration and not run it, and the state nadal's production database was actually in
 * on 2026-08-13 (13 of 14, after PR #152 merged `players.plays`). Used by #160's drift tests.
 *
 * It applies a real SUBSET of the migration folder rather than deleting the newest journal row from
 * a fully-migrated database. The shortcut was written first and is wrong: it removes the
 * bookkeeping while leaving the schema change in place, so `tn db migrate` then re-runs
 * `ALTER TABLE players ADD plays` against a column that already exists and fails with
 * `duplicate column name`. That is a defect in the fixture masquerading as a defect in the code —
 * it reads exactly like "the create:true exemption does not work".
 */
export function migrateToAllButLast(path: string): { applied: number; available: number } {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const keep = journal.entries.slice(0, -1);

  const folder = mkdtempSync(join(tmpdir(), "tn-migrations-"));
  mkdirSync(join(folder, "meta"), { recursive: true });
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: keep }));
  for (const entry of keep) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }

  const sqlite = new Database(path);
  applyMigrations(sqlite, folder);
  sqlite.close();
  return { applied: keep.length, available: journal.entries.length };
}
