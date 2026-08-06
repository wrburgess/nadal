import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { errorMessage } from "../error-message.js";
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
    // `!= '__drizzle_migrations'` — an EXACT name, not `NOT LIKE '%drizzle%'`. The sibling query in
    // `test/db-migrate.test.ts` uses the wildcard, and copying it here would have quietly broken the
    // promise in the doc comment above: any future application table whose name merely CONTAINS
    // "drizzle" would be dropped from the comparison and so never verified, while this comment went
    // on claiming every new table is covered automatically. Exact-matching fails in the safe
    // direction instead — a host that renames drizzle's bookkeeping table gets it INCLUDED in the
    // comparison, which is harmless (both files carry it identically, so it can only ever agree).
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'")
    .all() as Array<{ name: string }>;
  const counts = new Map<string, number>();
  for (const { name } of names) {
    // Identifiers cannot be bound as `?` parameters, so the name is interpolated — and therefore has
    // to be QUOTED the way SQLite quotes identifiers, by doubling any embedded `"`. Codex
    // adversarial review of PR #115, finding 2 [medium], confirmed by direct probe rather than
    // accepted on assertion: a table created as `CREATE TABLE "odd""name" (v)` comes back from
    // `sqlite_master` as the 8 characters `odd"name`, and the un-escaped interpolation then prepares
    // `SELECT COUNT(*) AS n FROM "odd"name"`, which SQLite rejects with `unrecognized token: """`.
    //
    // The bug this fixes is NOT injection — the comment that used to sit here was right that
    // `sqlite_master` is not caller input, and then treated "not attacker-controlled" as though it
    // implied "safe to interpolate raw". It does not: a legal table name is enough. The failure is
    // that `tn db backup` could not back up a perfectly valid database at all, which falsifies this
    // function's own doc comment above about covering every future table automatically.
    const quoted = name.replaceAll('"', '""');
    const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${quoted}"`).get() as { n: number };
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

// Guarantees two backups issued within the same millisecond still land on distinct destination
// names (plan amendment 3), mirroring `src/ingest/archive.ts`'s own `nextTimestamp()`/`lastStampMs`
// pattern rather than reinventing it — not imported directly, since that module is ingest-layer and
// this one is db-layer, and the whole pattern is four lines. `Date.now()`'s 1ms resolution means two
// calls close enough together (two rapid MCP `db_backup` calls, or two sequential calls in one
// process within the same wall-clock millisecond) can read the identical value; without the bump
// both would derive the identical destination name, and the SECOND to actually invoke `.backup()`
// would race the first through the exists-check with no name-based signal that anything was wrong.
// This does not close the TOCTOU window Risk 2 already accepts (`.backup()` runs against a path this
// module resolved, not one it holds a lock on) — it removes the far more common cause of hitting
// that window at all: two calls that were never concurrent, only close in time.
let lastStampMs = 0;

function nextStampMs(): number {
  let ms = Date.now();
  if (ms <= lastStampMs) ms = lastStampMs + 1;
  lastStampMs = ms;
  return ms;
}

/**
 * `{dirname(source)}/backups/{basename-without-ext}-YYYYMMDDTHHMMSSmmmZ.db` (step 3). The stamp is
 * `new Date(nextStampMs()).toISOString()` with `-`, `:` and `.` stripped, so
 * `2026-08-05T12:34:56.789Z` becomes `20260805T123456789Z` — filesystem-safe on every platform (no
 * `:`) and, via `nextStampMs()` above, unique per call within one process even at millisecond
 * resolution. The existing-destination refusal (step 4) is the backstop for every collision this
 * does not prevent — two separate `tn` processes racing on the exact same millisecond — rather than
 * the primary mechanism the original plan described, which is what plan amendment 3 changed.
 */
function deriveDestination(source: string): string {
  const ext = extname(source);
  const stem = basename(source, ext);
  const stamp = new Date(nextStampMs()).toISOString().replace(/[-:.]/g, "");
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
 * Checked on the RESOLVED (absolute) path, deliberately, not the raw candidate: `resolve()` always
 * returns a string prefixed by the cwd or root, so a LEADING space on the raw input lands mid-string
 * after resolving and stops being edge whitespace at all — checking the raw value there would refuse
 * a path the driver would not actually clamp. A TRAILING space survives `resolve()` at the string's
 * edge either way (verified above), which is the realistic, GRAMMAR.md-promised case this guards.
 *
 * This is why `refuseUnusableDestination` below is a SEPARATE function checked on the RAW candidate
 * instead of being folded in here: `resolve()` is exactly what erases an empty-after-trim or
 * `:memory:` destination (`resolve("")` is the cwd; `resolve(":memory:")` is `{cwd}/:memory:`), so a
 * post-resolve check for either can never fire — a branch no fixture could kill (`rules/testing.md`).
 * Checking them pre-resolve, on the destination-only path, is what plan amendment 1 also asks for.
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
 * Plan amendment 1, second half. Called on the RAW `destinationPath` a caller supplies — before
 * `resolve()` — because `resolve()` is exactly what makes both conditions below unreachable
 * afterward (see `assertNoSilentTrim`'s own comment). `destinationPath` exists only for this
 * module's own tests, so this is reachable through direct calls, not through `TN_DB_PATH` or any CLI
 * surface — unlike the trim guard above, which the CLI's own config surface can trigger.
 *
 * Both conditions are `TypeError`s better-sqlite3's own `.backup()` throws unprompted
 * (`lib/methods/backup.js`: `"Backup filename cannot be an empty string"`,
 * `"Invalid backup filename \":memory:\""`) — bare, undated, and naming neither this command nor
 * `BackupRefusedError`. Refusing here first is the same call this module makes everywhere else: a
 * destination that cannot be honored is reported as this module's own refusal, not left to surface
 * as an unrelated driver exception two calls later.
 */
function refuseUnusableDestination(raw: string): void {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new BackupRefusedError("refusing an empty destination path");
  }
  if (trimmed === ":memory:") {
    throw new BackupRefusedError(
      'refusing ":memory:" as a destination — a backup must be a real file on disk, not SQLite\'s in-memory sentinel',
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
  } catch (err) {
    // ABSENT and UNREADABLE raise the SAME `SQLITE_CANTOPEN` here — verified against a chmod-000
    // file and a directory-at-the-path, both of which throw it while `existsSync` reports true. So
    // the branch below is a DIAGNOSIS, not the guard: `fileMustExist` above is still the only thing
    // deciding whether this call proceeds, and `existsSync` never gates it. That distinction is the
    // whole reason this is safe — an `existsSync` used as the guard is the check-then-act shape
    // step 2 exists to avoid.
    //
    // Worth the branch because the two failures call for opposite operator responses: "there is
    // nothing here" versus "your database is right there and I cannot read it". Telling someone the
    // second is the first is the most dangerous wrong answer a BACKUP command can give — it reports
    // nothing to lose at the exact moment there is something to lose.
    if (!existsSync(source)) {
      throw new BackupRefusedError(`no database ${namePath(source)} — nothing to back up`);
    }
    throw new BackupRefusedError(
      `cannot open the database ${namePath(source)} — it exists but could not be opened: ${errorMessage(err)}`,
    );
  }

  try {
    // 3. Derive the destination when the caller did not supply one. A SUPPLIED one is screened on
    // the RAW string first — `resolve()` below is precisely what would make both of those checks
    // unreachable, so the order here is the whole reason they can fire at all.
    if (destinationPath !== undefined) refuseUnusableDestination(destinationPath);
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

    // Summed from `backupCounts` — the WRITTEN FILE — not from `sourceCounts`. The two are provably
    // equal by the check immediately above, so this changes no value; it changes what the number
    // IS. The issue's requirement is that the command "read the counts back out of the finished
    // file and report them", and a total summed from the source would satisfy that only by way of
    // an argument, which is the kind of thing that stays true right up until someone reorders the
    // steps.
    const rows = [...backupCounts.values()].reduce((total, count) => total + count, 0);
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
