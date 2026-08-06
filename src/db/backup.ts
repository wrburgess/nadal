import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { dbPath, losslessPath, UNRENDERABLE } from "./client.js";

// Issue #110, Option B ("compare the counts, and refuse a mismatch"). Thrown for every
// PRECONDITION `backupDatabase` refuses on: no source database, or a destination that already
// exists. A refusal here is a structural fact about the filesystem the caller can act on, never a
// value this module invents by clamping or silently overwriting.
export class BackupRefusedError extends Error {}

// Thrown when the written snapshot's own table-by-table row counts disagree with the source's — the
// one thing `backupDatabase` cannot take on faith from better-sqlite3's own `.backup()` call, which
// reports "I copied some pages" and nothing about whether what it copied matches what was asked
// for. The snapshot itself is left on disk when this throws (step 9 below): deleting it would
// destroy the only evidence of what went wrong, which is worse than a bad backup that says so.
export class BackupVerificationError extends Error {}

export type TableCount = { table: string; source: number; backup: number };

export type BackupResult = {
  source: string;
  destination: string;
  tables: TableCount[];
  rows: number;
};

/**
 * Counts every application table by reading `sqlite_master`, not the twelve `sqliteTable` exports
 * in `src/db/schema.ts` — deliberately, so a table a future migration adds is covered here without
 * anyone remembering to list it (the guard-completeness lens, PROJECT.md -> Review Lenses).
 * `sqlite_%` excludes SQLite's own internal bookkeeping tables (e.g. `sqlite_sequence`), and
 * `%drizzle%` excludes drizzle-orm's own migration-tracking table (`__drizzle_migrations`) — the
 * same exclusion `test/db-migrate.test.ts`'s EXPECTED_TABLES query already applies. Both are
 * mechanism, not domain data: a freshly migrated, otherwise-empty database already carries one row
 * per applied migration in `__drizzle_migrations`, which would make "empty" backups never report
 * `rows=0` (Testing Strategy scenario 9) for a reason that has nothing to do with what this command
 * protects.
 */
function tableCounts(sqlite: InstanceType<typeof Database>): Map<string, number> {
  const names = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%drizzle%'")
    .all() as Array<{ name: string }>;
  const counts = new Map<string, number>();
  for (const { name } of names) {
    // `name` comes from sqlite_master, never from caller input, so it carries no injection
    // surface — identifiers cannot be bound as `?` parameters, which is why this is interpolated
    // rather than parameterized.
    const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
    counts.set(name, row.n);
  }
  return counts;
}

/**
 * Pure (Testing Strategy scenario 6). Compares two table-name -> row-count maps and returns every
 * DISAGREEMENT: a table whose count differs, or one present on only one side. Checked in BOTH
 * directions deliberately — a one-way containment (every source table is in the backup with the
 * right count) is satisfied by a backup that also carries extra tables the source never had, which
 * is exactly the kind of "looks fine, isn't" a real verification cannot let through.
 */
export function compareTableCounts(source: Map<string, number>, backup: Map<string, number>): TableCount[] {
  const disagreements: TableCount[] = [];
  const names = new Set<string>([...source.keys(), ...backup.keys()]);
  for (const table of [...names].sort()) {
    const sourceCount = source.get(table);
    const backupCount = backup.get(table);
    if (sourceCount === undefined || backupCount === undefined || sourceCount !== backupCount) {
      disagreements.push({ table, source: sourceCount ?? 0, backup: backupCount ?? 0 });
    }
  }
  return disagreements;
}

/**
 * `{dirname(source)}/backups/{basename-without-ext}-YYYYMMDDTHHMMSSZ.db` (step 3). The stamp is
 * `new Date().toISOString()` with the `-`/`:` separators and the fractional seconds stripped, so
 * `2026-08-05T12:34:56.789Z` becomes `20260805T123456Z` — filesystem-safe on every platform (no
 * `:`) and precise to the second, which is what step 4's "second backup inside one second" refusal
 * depends on: two backups issued closer together than that collide on this name and refuse rather
 * than silently overwrite.
 */
function deriveDestination(source: string): string {
  const ext = extname(source);
  const stem = basename(source, ext);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return join(dirname(source), "backups", `${stem}-${stamp}.db`);
}

/**
 * Refuse a path the driver would silently rewrite (plan amendment 1). better-sqlite3 trims the
 * filename it is handed in BOTH entry points this module uses — `new Database(filenameGiven)`
 * (`lib/database.js:30`) and `db.backup(filename)` (`lib/methods/backup.js:8`) — while
 * `path.resolve` preserves trailing whitespace (`resolve("/tmp/x/nadal.db ")` is unchanged,
 * verified). A `TN_DB_PATH` ending in a space therefore makes the driver open a DIFFERENT file than
 * every message here reports, and `docs/cli/GRAMMAR.md` explicitly promises such a value round-trips
 * unchanged — so this is reachable through the documented configuration surface, not only through a
 * direct JS call. Refusing is the same call the rest of this module makes everywhere else: a path
 * that cannot be honored as written is an error, never a value to quietly correct.
 *
 * ONLY the trim is checked, deliberately. The two sibling refusals the driver also raises —
 * empty-after-trim and `:memory:` — are UNREACHABLE here because both paths are `resolve()`d first:
 * `resolve("")` returns the cwd and `resolve(":memory:")` returns `{cwd}/:memory:`, so neither can
 * ever equal the value being guarded against. Adding those branches would satisfy the amendment's
 * letter while leaving two branches no fixture could ever kill, which `rules/testing.md` names as
 * worse than the omission.
 */
function assertNoSilentTrim(label: string, path: string): void {
  if (path !== path.trim()) {
    throw new BackupRefusedError(
      `refusing a ${label} path with leading or trailing whitespace ${namePath(path)} — SQLite would ` +
        `trim it and act on a different file than this message names`,
    );
  }
}

/**
 * Renders a resolved path the same way `src/db/client.ts`'s own migration-failure message does:
 * literal when every character survives the trip to a terminal, escaped and SAID to be escaped
 * (`losslessPath`) when it does not (`UNRENDERABLE`). Reused rather than re-derived, so the two
 * refusal messages in this codebase that name a database path agree on how.
 */
function namePath(path: string): string {
  return UNRENDERABLE.test(path)
    ? `at ${losslessPath(path)} (path escaped — it contains characters that cannot be shown literally)`
    : `(${path})`;
}

/**
 * WHY THIS MODULE DOES NOT ROUTE ITS WRITE THROUGH `src/fs/output-root.ts` (plan amendment 4).
 * ARCHITECTURE.md § 9 asks every new file write to go through that guard, and this one cannot: its
 * whole mechanism is `openNewOutputFileSafely` opening the leaf itself with `O_CREAT|O_EXCL` and
 * then verifying the DESCRIPTOR (`fstat` vs `lstat`, the `nlink` sample). SQLite's online-backup API
 * takes a *path* and opens the destination inside the native addon, so there is no descriptor for
 * this module to anchor and no point at which it could hand one over. Wrapping the call anyway would
 * produce a guard that verifies a file the backup then does not write through — the shape
 * `rules/self-review.md` names as worse than no check, because it reads as coverage.
 *
 * What stands in its place, stated so the gap is bounded rather than waved past: the trim refusal
 * above (a path the driver would rewrite), the existing-destination refusal (step 4, no silent
 * overwrite), and `fileMustExist` on the source (step 2, no created-empty database). What is NOT
 * covered, and is a real difference from the archive/report writers: a symlinked component in the
 * destination path is followed rather than refused, and there is no TOCTOU-closed handoff between
 * resolving the destination and writing it.
 *
 * That residual is narrower here than it would be for those writers, and the reason is the threat
 * model rather than the mechanism: this destination is a sibling directory of an already-local
 * database, written from a path the operator themselves configured, and it publishes nothing that
 * was not already on the same disk. `output-root.ts` exists to keep un-redacted personal data out of
 * a tracked directory of a public repo; a snapshot of `data/nadal.db` landing in `data/backups/`
 * stays inside the same `.gitignore` entry the source is already covered by.
 */

/**
 * Take a verified snapshot of the database (issue #110). `destinationPath` exists only for this
 * module's own tests — the CLI command never supplies one (no `--to` flag; PROJECT.md -> "What a
 * PR is for" is explicit that correctness work not advancing Springfield is triaged, not folded).
 *
 * Order of operations below, each chosen against a specific failure named in the numbered comments
 * (the issue's plan carries the full reasoning):
 */
export async function backupDatabase(sourcePath?: string, destinationPath?: string): Promise<BackupResult> {
  // 1. Absolute, always — the same reason `client.ts` already resolves: a relative path names a
  // file whoever reads the summary line may not be standing next to.
  const source = resolve(sourcePath ?? dbPath());
  assertNoSilentTrim("source", source);

  // 2. `fileMustExist: true`, never `openDb()` — `openDb()` `mkdirSync`s the parent and creates an
  // empty database, which would make "no source" unreachable rather than refused. This IS the
  // structural refusal: a missing source cannot be manufactured by the check for it.
  let sqlite: InstanceType<typeof Database>;
  try {
    sqlite = new Database(source, { fileMustExist: true });
  } catch {
    throw new BackupRefusedError(`no database ${namePath(source)} — nothing to back up`);
  }

  try {
    // 3. Derive the destination when the caller did not supply one.
    const destination = destinationPath !== undefined ? resolve(destinationPath) : deriveDestination(source);
    assertNoSilentTrim("destination", destination);

    // 4. Refuse rather than clamp: `.backup()` computes `isNewFile = !existsSync(filename)` and
    // OVERWRITES an existing file, so without this a second backup inside one second would
    // silently replace the first.
    if (existsSync(destination)) {
      throw new BackupRefusedError(`refusing to overwrite an existing backup ${namePath(destination)}`);
    }
    // `mkdirSync` the backups directory — deliberate: `.backup()` throws "Cannot save backup
    // because the directory does not exist" without it, and the default destination's parent
    // (`{dirname(source)}/backups`) does not exist until a backup has been taken once before.
    mkdirSync(dirname(destination), { recursive: true });

    // 5. Count the source's tables by reading its structure, not a list.
    const sourceCounts = tableCounts(sqlite);

    // 6. Copy, then close the source connection — nothing after this point needs the live handle.
    await sqlite.backup(destination);
    sqlite.close();

    // 7. Reopen the WRITTEN FILE, read-only — so verification cannot itself create `-wal`/`-shm`
    // sidecars beside the snapshot. Safe here specifically because a just-written backup has no hot
    // WAL to recover, unlike the source above, which is why the source is NOT opened readonly.
    const verify = new Database(destination, { readonly: true, fileMustExist: true });
    let backupCounts: Map<string, number>;
    try {
      backupCounts = tableCounts(verify);
    } finally {
      verify.close();
    }

    // 8. Compare both ways.
    const disagreements = compareTableCounts(sourceCounts, backupCounts);
    if (disagreements.length > 0) {
      // 9. The snapshot stays on disk — deleting it would destroy the only evidence of what went
      // wrong. Said here, not just done.
      throw new BackupVerificationError(
        `backup verification failed — ${disagreements
          .map((d) => `${d.table} (source=${d.source}, backup=${d.backup})`)
          .join(", ")} — the unverified snapshot is left ${namePath(destination)} rather than deleted. ` +
          `A concurrent \`tn\` writing to this database during the copy is one possible cause; ` +
          `request_log in particular is written by every command merely running.`,
      );
    }

    const rows = [...sourceCounts.values()].reduce((total, count) => total + count, 0);
    const tables: TableCount[] = [...sourceCounts.entries()].map(([table, count]) => ({
      table,
      source: count,
      // Safe: `disagreements` is empty at this point, so `compareTableCounts` already established
      // every source table is present in `backupCounts` with an equal count — this can never be
      // `undefined`, and `!` says so rather than manufacturing an unkillable `?? count` fallback
      // branch no fixture could ever reach (rules/testing.md).
      backup: backupCounts.get(table)!,
    }));
    return { source, destination, tables, rows };
  } finally {
    if (sqlite.open) sqlite.close();
  }
}
