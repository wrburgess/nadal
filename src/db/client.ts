import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
// `drizzle-orm/migrator` is a PUBLIC entry point in drizzle-orm's `exports` map, not a reach into
// its internals — it is the same module drizzle's own `better-sqlite3/migrator` imports this same
// function from. Issue #117 replaces drizzle's `migrate()` (see `applyMigrations` below) but keeps
// its migration-file reader, so the journal parsing, the `--> statement-breakpoint` split and the
// hash derivation all stay drizzle's rather than becoming a second implementation to keep in step.
import { readMigrationFiles } from "drizzle-orm/migrator";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../error-message.js";
import { repoDefault } from "../fs/package-root.js";
import { backfillGenders } from "./gender-backfill.js";
import { backfillNameKeys } from "./name-key.js";

// Stays a BARE directory name — issue #111's anchoring goes in the ACCESSOR (`dbPath()` below),
// never here. `assertRootSafe`/`assertOutputPathSafe` (src/fs/output-root.ts) take a
// `permittedDir` argument that they resolve against the package root themselves; the sibling
// `DEFAULT_RAW_DIR`/`DEFAULT_REPORTS_DIR`/`DEFAULT_SCORECARD_PHOTOS_DIR` constants play exactly
// that role for their own callers, so keeping this one the same shape means one pattern, not two.
export const DEFAULT_DB_PATH = "data/nadal.db";

export type OpenDbOptions = {
  // Issue #32, ask #4 (test/identity-query-count.test.ts): better-sqlite3's `new Database(path, {
  // verbose })` invokes `verbose` with every SQL statement the connection executes — this is the
  // observation seam the query-count test uses to assert resolution issues a constant number of
  // statements regardless of table size, rather than one per row.
  verbose?: (message?: unknown, ...args: unknown[]) => void;
  // Issue #111: `false` by DEFAULT (see `openDb` below). `runMigrations` is the only caller that
  // passes `true` — every other one of the ~30 `openDb()` call sites is untouched and inherits the
  // new default, which refuses to silently create (and silently populate with an empty, unmigrated
  // schema) a database nothing has bootstrapped yet.
  create?: boolean;
};

// drizzle-orm's `readMigrationFiles` resolves `migrationsFolder` with plain `fs` calls against
// `process.cwd()` — it does no path resolution of its own. Anchor to this module's own
// location (repo root, two levels up from src/db/) so `tn db migrate` finds the migrations
// regardless of the caller's working directory. (Still true after #117: the migration APPLICATION
// moved into `applyMigrations` below, but reading the files is still drizzle's, and it still
// resolves this path the same way.)
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(MODULE_DIR, "..", "..", "drizzle");

/**
 * Issue #111: an unset `TN_DB_PATH` used to resolve to the bare relative string `DEFAULT_DB_PATH`,
 * which every caller then resolved against `process.cwd()` — so `tn player pull …` run from
 * anywhere other than the repo root silently created (and, on a second run, silently read from) a
 * DIFFERENT, empty database under that cwd's own `data/` directory rather than the repo's real one.
 * `repoDefault` anchors the unset case to the package root instead, exactly like
 * `MIGRATIONS_FOLDER` above already anchors the migrations folder.
 *
 * An EXPLICIT `TN_DB_PATH` is returned verbatim, `??` preserved exactly as before — a relative
 * override is a deliberate escape hatch (documented in the runbooks) and stays resolved against the
 * caller's cwd, and an empty-string override stays a set-but-empty value rather than becoming
 * "unset".
 */
export function dbPath(): string {
  return repoDefault(process.env.TN_DB_PATH, DEFAULT_DB_PATH);
}

/**
 * Issue #111: a missing database used to be silently bootstrapped into existence — `mkdirSync`
 * unconditionally created the parent directory and `new Database(path)` (no `fileMustExist`) then
 * created an empty, UNMIGRATED file — so a command run before `tn db migrate` reported
 * `status=ok` against a database with no tables at all, discovered only later as a confusing "no
 * such table" failure with no mention of the real cause.
 *
 * `create` now defaults to `false`: no `mkdirSync` at all (today's unconditional call was itself a
 * silent directory-creator, so it is gated the same way the file is) and the file must already
 * exist (`fileMustExist: true` — better-sqlite3's own enforcement at `open(2)`, not a
 * check-then-act pre-check racing across a WAL database). `runMigrations` is the only caller that
 * opts in with `create: true`, which is exactly where creating a fresh database is the intended
 * behavior. When that open fails, `openFailureCode` below shapes the message — by errno, never by
 * `existsSync` — and offers `tn db migrate` conditionally rather than promising it.
 */
export class MissingDatabaseError extends Error {}

/**
 * A database that exists and opens fine, but whose schema is OLDER than the code about to query it
 * — issue #160, part D.
 *
 * Filed from a live failure: on 2026-08-13 the production database sat at 13 of 14 migrations for a
 * day after PR #152 merged `players.plays`, so every command reading `players` through the ORM
 * threw `SqliteError: no such column: plays`. Part A' of #160 guarantees such an error now reaches
 * the operator at all. This class is the difference between it reading as a column name and reading
 * as an instruction.
 *
 * It is a distinct class rather than a message because two other places must recognize it: the
 * `create: true` exemption in `openDb` below (or `tn db migrate` could not open the very database
 * it exists to repair), and `writeRequestLogRow`'s catch (or one fault prints two diagnostics).
 */
export class DatabaseBehindMigrationsError extends Error {}

/**
 * How many migrations on disk this database has not applied. `0` means current.
 *
 * **Deliberately built on the same single-watermark rule `applyMigrations` uses** — one
 * `MAX(created_at)` read compared against each `migration.folderMillis`, never a per-hash set
 * difference. That is not a stylistic choice: a checker with its own notion of "current" would
 * eventually disagree with the migrator, and a preflight that refuses a database `tn db migrate`
 * considers finished is worse than no preflight at all.
 *
 * `test/db-migration-drift.test.ts` holds that in two tests, and it takes two: its PARITY test
 * walks every prefix state, 0 applied through N, asserting this count equals the number of
 * migrations `applyMigrations` then actually applies — but every prefix state has
 * `COUNT(*) === (migrations at or below the watermark)`, so that walk alone passes just as happily
 * for a checker built on `total - COUNT(*)` (verified by mutation, not assumed). The second test
 * supplies the state that separates them — a journal carrying a duplicate row, which is not a clean
 * prefix — and it is the one that fails if this rule is ever replaced by a row count.
 *
 * A database with no `__drizzle_migrations` table at all reads as fully behind rather than
 * throwing: that is the honest answer for a file nothing has bootstrapped, and it keeps this
 * function safe to call on any open handle.
 */
export function migrationStatus(
  sqlite: Database.Database,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): { pending: number; total: number } {
  const migrations = readMigrationFiles({ migrationsFolder });
  const total = migrations.length;
  const journalExists = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`)
    .get();
  if (journalExists === undefined) return { pending: total, total };

  const watermark = sqlite
    .prepare(
      `SELECT created_at AS createdAt FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { createdAt: unknown } | undefined;
  if (watermark === undefined) return { pending: total, total };

  return {
    pending: migrations.filter((m) => Number(watermark.createdAt) < m.folderMillis).length,
    total,
  };
}

/**
 * `migrationStatus`'s pending count alone. **No production caller** — `openDb` below needs the
 * total for its message and calls `migrationStatus` directly; this is the accessor
 * `test/db-migration-drift.test.ts` asserts through, kept because the count is the property those
 * tests are about and threading `.pending` through every assertion reads worse than naming it once.
 */
export function pendingMigrationCount(
  sqlite: Database.Database,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): number {
  return migrationStatus(sqlite, migrationsFolder).pending;
}

/**
 * Why did an open of `path` fail — because there was nothing there to open, or for some other
 * reason? Returns the `open(2)` errno, or `null` when the file opens fine (so SQLite objected to
 * its CONTENT, not its reachability).
 *
 * Asked ONLY after a database open has already failed, purely to shape the error message. It never
 * decides whether to proceed, so it is not a check-then-act guard — `fileMustExist` at `open(2)` is
 * what enforces.
 *
 * **This predicate answers "is there anything to open", and deliberately does NOT try to answer
 * "will `tn db migrate` fix it".** That distinction is the whole design, and it was reached by
 * getting it wrong twice under adversarial review of PR #116:
 *
 *   | state                       | SQLite          | existsSync | open(2) | lstat  | migrate fixes it? |
 *   |-----------------------------|-----------------|------------|---------|--------|-------------------|
 *   | file absent                 | SQLITE_CANTOPEN | false      | ENOENT  | ENOENT | yes               |
 *   | parent directory absent     | SQLITE_CANTOPEN | false      | ENOENT  | ENOENT | yes               |
 *   | parent is a REGULAR FILE    | SQLITE_CANTOPEN | false      | ENOTDIR | ENOTDIR| no                |
 *   | parent not traversable      | SQLITE_CANTOPEN | false      | EACCES  | EACCES | no                |
 *   | DANGLING SYMLINK at leaf    | SQLITE_CANTOPEN | false      | ENOENT  | ok     | no                |
 *   | dangling symlink ANCESTOR   | SQLITE_CANTOPEN | false      | ENOENT  | ENOENT | no                |
 *   | symlink -> absent, dir ok   | SQLITE_CANTOPEN | false      | ENOENT  | ok     | yes               |
 *
 * All measured, none assumed. Read the last column against the two before it: **no single-call
 * predicate matches it.** `existsSync` misses four rows. `open(2)` errno misses the two dangling-
 * symlink rows (the Codex finding that killed revision two). `lstat` fixes the leaf-symlink row but
 * breaks the last one — a legitimate symlink to a database that simply has not been created yet —
 * and still misses the ancestor row. Each revision was locally justified and none converged, which
 * is the signature of a predicate being asked the wrong question.
 *
 * So the question changed instead. The remedy in the message below is offered **conditionally**
 * ("if it has not been created yet"), never promised, and the message carries the observed errno.
 * That claim is true on every row above, including the ones this predicate classifies loosely — the
 * operator is told what was seen and what to try, not what will work. A predicate that only has to
 * report an observation cannot leak the way one that has to prove a future outcome does.
 */
function openFailureCode(path: string): string | null {
  try {
    closeSync(openSync(path, "r"));
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
  }
}

/**
 * `attempts` × `delayMs` is 5s deliberately — the same budget as better-sqlite3's default
 * `busy_timeout`, which bounds the OTHER wait a concurrent bootstrap can encounter (`BEGIN IMMEDIATE`
 * in `applyMigrations`). One bootstrap should not have two different patiences.
 */
const WAL_CONVERSION_ATTEMPTS = 250;
const WAL_CONVERSION_DELAY_MS = 20;

/**
 * Blocks the thread for `ms`. `Atomics.wait` rather than a spin on `Date.now()`: better-sqlite3 is
 * synchronous top to bottom, so there is no async point to yield at, and a spin would burn a core
 * for the whole wait. Node permits `Atomics.wait` on the main thread (browsers do not).
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Issue #117, mechanism 2. `PRAGMA journal_mode = WAL` is **not** covered by SQLite's busy handler:
 * converting a database's journal mode needs a brief exclusive lock, and when it cannot get one
 * SQLite returns `SQLITE_BUSY` immediately instead of waiting out `busy_timeout`. Two `tn db migrate`
 * processes bootstrapping the same new database therefore collide *here*, in `openDb`, before the
 * migrator is reached at all — which is why `applyMigrations`' `BEGIN IMMEDIATE` cannot fix this half
 * on its own. It accounted for 5 of 11 measured failures.
 *
 * **The contended window is only the conversion itself**, and that bound is measured rather than
 * argued: on a database that is ALREADY `wal`, the pragma is a no-op needing no lock and succeeds
 * even while another connection holds an open write transaction. `tn db migrate` converts at
 * bootstrap, so in the normal flow every later `openDb` — all ~30 call sites — meets a converted
 * database and cannot contend. `test/db-migrate-serialization.test.ts` pins that, so a later change
 * cannot widen the window silently.
 *
 * Stated that way on purpose, because the tighter phrasing was **false in this repo**: an earlier
 * draft said the retry is "reached only on the first open of a brand-new file". Any database `tn` has
 * not yet converted enters this loop — including one built by an external tool, and including the
 * delete-mode fixtures the legacy-upgrade tests construct with a bare `new Database(path)`
 * (`test/db-teams-url-unique-upgrade.test.ts`), which `runMigrations` then converts. Entering the loop
 * is harmless and normal; what is bounded is *contention*, which needs two converters at once.
 *
 * Reading the mode before setting it is what implements that bound: the early return is the
 * already-`wal` case, not an optimisation.
 *
 * `attempts` and `delayMs` are parameters solely so the exhaustion case can be exercised in
 * milliseconds instead of five seconds — the same kind of narrow, test-facing seam as
 * `OpenDbOptions.verbose` above, and no PRODUCTION caller passes either — the tests do, which is
 * what they are for. Exported for the same reason
 * `losslessPath` and `UNRENDERABLE` below are: the contended cases can be set up directly here and
 * only awkwardly through `openDb`.
 *
 * What this deliberately does NOT do: check the mode the pragma RETURNS. SQLite can in principle
 * report the unchanged mode rather than raising, and a database that silently stayed in `delete`
 * mode would slip through. That is exactly today's behaviour — the pre-#117 code discarded the
 * pragma's return value too — and no test in this repo can reach it, so guarding it would add a
 * branch nothing can kill (`rules/testing.md`). The scope here is the SQLITE_BUSY collision that was
 * measured, not every way a conversion could disappoint.
 */
export function enableWal(
  sqlite: Database.Database,
  attempts: number = WAL_CONVERSION_ATTEMPTS,
  delayMs: number = WAL_CONVERSION_DELAY_MS,
): void {
  for (let attempt = 1; ; attempt++) {
    if (sqlite.pragma("journal_mode", { simple: true }) === "wal") return;
    try {
      sqlite.pragma("journal_mode = WAL");
      return;
    } catch (err) {
      // `startsWith`, not `!== "SQLITE_BUSY"` — SQLite defines SQLITE_BUSY as a FAMILY
      // (`SQLITE_BUSY_SNAPSHOT`, `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_TIMEOUT`) and better-sqlite3
      // surfaces the EXTENDED name on `.code`, verified rather than assumed: a write on a stale WAL
      // read snapshot reports `SQLITE_BUSY_SNAPSHOT`, not `SQLITE_BUSY`. Matching the base code alone
      // would classify a recovery-time busy as "not contention" and fail fast — reinstating exactly
      // the symptom this retry exists to remove, on the rarer path where it is hardest to diagnose.
      // Derived from the family rather than enumerating the one member that happened to be measured.
      const code = (err as NodeJS.ErrnoException).code;
      if (code?.startsWith("SQLITE_BUSY") !== true || attempt >= attempts) throw err;
    }
    sleepSync(delayMs);
  }
}

export function openDb(path: string = dbPath(), options: OpenDbOptions = {}) {
  if (options.create === true) {
    mkdirSync(dirname(path), { recursive: true });
  }
  let sqlite: Database.Database;
  try {
    sqlite =
      options.verbose !== undefined
        ? new Database(path, { verbose: options.verbose, fileMustExist: options.create !== true })
        : new Database(path, { fileMustExist: options.create !== true });
  } catch (err) {
    const code = options.create === true ? null : openFailureCode(path);
    if (code === "ENOENT") {
      // Conditional, never a promise — see `openFailureCode`. "if it has not been created yet"
      // stays true even on the paths this cannot tell apart (a dangling symlink reads as ENOENT
      // exactly like a database that simply has not been bootstrapped), so the operator is told
      // what was observed and what to try, not what will work.
      throw new MissingDatabaseError(
        `cannot open database at ${resolve(path)} (ENOENT: nothing to open) — ` +
          `if it has not been created yet, run \`tn db migrate\``,
      );
    }
    throw err;
  }
  // Everything from here to the `return` runs with a handle NOBODY ELSE HOLDS YET, so every escape
  // from this block has to close it — contractor review of f1242fd, finding 1. Part D's refusal
  // closed explicitly and the branch where the preflight ITSELF throws did not, which leaks a
  // connection per failed open; in `tn mcp serve` (long-lived, `logMcpTool` re-throws, the next
  // request opens again) that is one descriptor per failed call, forever. The whole block is
  // wrapped rather than that one branch patched, because the class is older than part D:
  // `enableWal` and the `foreign_keys` pragma could always throw here (a corrupt file reaches
  // both), and each was leaking the same way before this issue existed.
  try {
    enableWal(sqlite);
    sqlite.pragma("foreign_keys = ON");
    // #160 part D: refuse a database older than the code about to query it, BEFORE the first query
    // turns that into `SqliteError: no such column: <whatever the newest migration added>`.
    //
    // The exemption is `create === true`, which is exactly and only `runMigrations` (see
    // `OpenDbOptions.create` above — every other one of the ~30 call sites inherits the `false`
    // default). Any other spelling would lock `tn db migrate` out of the one database it exists to
    // repair; keying off the bit that already means "I am the bootstrapper" adds no new concept.
    if (options.create !== true) {
      // One read of the migration folder, not two — the first revision re-read it inside the
      // failure branch to recover `total`.
      const { pending, total } = migrationStatus(sqlite);
      if (pending > 0) {
        throw new DatabaseBehindMigrationsError(
          `database at ${resolve(path)} is at ${total - pending} of ${total} migrations — ` +
            "run `tn db migrate`",
        );
      }
    }
  } catch (err) {
    // The close is itself guarded, and that is not belt-and-braces: `applyMigrations` below carries
    // a recorded finding about exactly this shape — an unconditional cleanup call in a catch threw
    // and REPLACED the real failure, so the operator debugged the masking error instead. Cleanup
    // failure is not news; the error that got us here is.
    try {
      sqlite.close();
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err;
  }
  return { sqlite, db: drizzle(sqlite) };
}

// Issue #46: a pre-existing database holding a duplicate `teams.tennisrecord_url` pair (the exact
// damage #46 fixes) makes migration 0009's `CREATE UNIQUE INDEX` fail with a bare "UNIQUE
// constraint failed: teams.tennisrecord_url" — legible to nobody who hasn't read this migration.
// Shipping no dedupe DML for that pair is a deliberate choice (a same-URL rename collision is a
// merge decision, out of bounds per spec § Ingestion, same as `upsertTeam`'s own
// `AmbiguousIdentityError`), so THIS message is the whole mitigation: it names the cause, the
// database that failed, and the runbook — docs/runbooks/db-migration-recovery.md — rather than
// silently leaving `tn db migrate` broken.
//
// Issue #56: it deliberately does NOT emit the recovery COMMAND, though it used to. A
// copy-pasteable `mv` here means this module permanently owns a shell-quoting surface, a
// filesystem-race surface (picking an untaken backup name), an encoding surface, and a platform
// surface — and it produced a defect in six of the eleven adversarial review rounds on PR #52.
// The runbook already carries the command in markdown, where no sanitizer eats it and no encoding
// question arises. A diagnosis plus a link is the smaller thing to own and the same thing to read.
const TEAMS_URL_UNIQUE_FAILURE = /UNIQUE constraint failed: teams\.tennisrecord_url/;

/**
 * The characters a database path cannot carry through to a human, from TWO independent mechanisms:
 *
 *   - `\p{Cc}` / `\p{Cf}` / U+2028 / U+2029 — `sanitizeValue` replaces these with a space before any
 *     summary line is printed (`src/sanitize.ts`).
 *   - `\p{Cs}` (lone UTF-16 surrogates) — `sanitizeValue` leaves these ALONE, but Node's UTF-8
 *     encoder destroys them at output time: `"x\uD800y"` is written as the bytes `78 ef bf bd 79`,
 *     i.e. U+FFFD (verified, not assumed).
 *
 * Both mechanisms end the same way — the reader is shown a path that does not name the real file —
 * so both belong in one predicate. Deriving the branch from `sanitizeValue` alone was necessary but
 * NOT sufficient, which is what Codex round 7 caught: a surrogate path skipped the fail-safe and got
 * a `mv` command naming a U+FFFD sibling.
 *
 * That command is gone (#56), which changes what this predicate is FOR without retiring it. It no
 * longer decides whether to withhold something executable; it decides whether the path can be shown
 * literally or has to be escaped and labelled as escaped. The failure it prevents is unchanged and
 * still the whole point — telling a human to go look at a file that is not the one that failed.
 *
 * Reachability, checked rather than argued: a lone surrogate CANNOT arrive through `TN_DB_PATH`,
 * because an environment variable is decoded from UTF-8 bytes and that round trip already replaces
 * it. The only route is a direct `runMigrations("...\uD800...")` call from JS. Handled anyway — the
 * cost is one character class, and a guard that is correct only for the inputs someone thought of is
 * the shape this repo keeps re-learning.
 */
// Exported ONLY so the character classes can be unit-tested directly. A lone surrogate cannot
// exist as a real filename on any platform — every OS stores path bytes, and encoding one to UTF-8
// already replaces it with U+FFFD — so an end-to-end test of that case necessarily depends on how
// a given filesystem resolves the two names. The first attempt did exactly that and passed on
// macOS while failing on Linux CI (`runMigrations` simply never threw there). The portable form is
// to exercise the pure functions directly and leave the end-to-end coverage to inputs that CAN be
// real filenames, which the newline case already is.
export const UNRENDERABLE_CLASS = "[\\p{Cc}\\p{Cf}\\p{Cs}\\u2028\\u2029]";
export const UNRENDERABLE = new RegExp(UNRENDERABLE_CLASS, "u");

/**
 * Render a path so it survives every mechanism above **losslessly** — each unrenderable character
 * becomes `\u{XXXX}`, leaving output built only from backslashes, braces and hex.
 *
 * `JSON.stringify` is NOT sufficient and that is why this exists (Codex round 6): it escapes the C0
 * controls but leaves DEL, the C1 block, every `\p{Cf}` format control, U+2028/U+2029 AND lone
 * surrogates literal — precisely the characters destroyed downstream. `src/cli/emit.ts` already
 * documents this same `JSON.stringify` shortfall for its own payload.
 *
 * Backslashes are escaped FIRST, which is what makes the mapping injective: a path legitimately
 * containing the text `\u{2028}` renders as `\\u{2028}` and so cannot be confused with an escape
 * this function produced. Same ordering argument, for the same reason, as `quoteSummaryValue`'s.
 */
export function losslessPath(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(
      new RegExp(UNRENDERABLE_CLASS, "gu"),
      (ch) => `\\u{${(ch.codePointAt(0) as number).toString(16).toUpperCase()}}`,
    );
}

/**
 * Collects every `message` down an error's `.cause` chain so `TEAMS_URL_UNIQUE_FAILURE` can be
 * matched against all of them at once.
 *
 * **Why a chain and not just `err.message` — re-derived for #117, because the original reason
 * expired.** This walk was written when `runMigrations` called drizzle's `migrate()`, which wrapped
 * every failed statement in a `DrizzleError` whose own message was the generic
 * `Failed to run the query '<sql>'`, putting the real better-sqlite3 text ("UNIQUE constraint failed:
 * …") one level down on `.cause`. Matching the top level alone would have missed it. `applyMigrations`
 * above no longer wraps: `sqlite.exec()` throws better-sqlite3's `SqliteError` directly, so the text
 * this function is looking for is now at the TOP of the chain and a one-level read would find it.
 *
 * The walk stays anyway, and the reason is a live one rather than inertia: it is what makes the match
 * independent of **who** throws. Node's own `Error.cause` is used widely, better-sqlite3 is free to
 * start wrapping, and the legacy-upgrade tests build databases through drizzle's `migrate()` directly
 * (`test/helpers/legacy-migrations.ts`), so a `DrizzleError` chain is still constructible in this
 * repo. A one-level read would be correct today and quietly wrong the first time any of those
 * changes. `test/db-teams-url-unique-upgrade.test.ts` asserts the resulting message by exact
 * equality, so the match itself is pinned either way.
 *
 * Written as a walk, not as `err instanceof Error ? … : String(err)` guards, for a testing reason
 * (`rules/testing.md`: never keep a branch no test can kill). Those guards cannot fail in this
 * codebase — a migration statement's throw is always an `Error` — so no fixture distinguishes them,
 * and an unkillable branch reads as coverage to every later reader. The loop condition has no such
 * problem: it is exercised in both directions on every call (true for the thrown error, false at the
 * end of the chain), so a mutation to it is caught. A non-`Error` throw yields `""` here, which
 * matches no pattern and so falls through to the `throw err` below — the original is re-thrown
 * untouched, which is what the discarded `String(err)` branch was for.
 *
 * That argument is unchanged by the `errorMessage()` call below, which answers a DIFFERENT
 * question (#64). The walk decides what to do with a non-`Error` THROW; `errorMessage` decides what
 * to do with a non-string `message` on an object that IS an `Error`. `Array.prototype.join` calls
 * `ToString` on every element, so a hostile `message` made this function throw from inside
 * `runMigrations`'s catch and replace the real migration error with an unrelated one. No unkillable
 * branch is added here — the conditional lives in `src/error-message.ts`, where
 * `test/error-message.test.ts` kills both of its directions.
 */
function messageChain(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    messages.push(errorMessage(current));
    current = current.cause;
  }
  return messages.join("\n");
}

/**
 * Byte-for-byte drizzle's own bookkeeping DDL (`sqlite-core/dialect.js`), tabs included, so a
 * database bootstrapped by `tn` is indistinguishable in `sqlite_master` from one bootstrapped by
 * drizzle's `migrate()`. SQLite stores a CREATE statement's text verbatim from the `CREATE` keyword
 * on, so the interior whitespace is part of what a comparison sees — the first draft used backticks
 * and a single line, which produced a functionally identical table whose stored DDL differed. Pinned
 * by `test/db-migrate-serialization.test.ts`'s equivalence case, which asserts every `sqlite_master`
 * row matches drizzle's exactly.
 */
const DRIZZLE_MIGRATIONS_TABLE_DDL =
  'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (\n' +
  "\t\t\t\tid SERIAL PRIMARY KEY,\n" +
  "\t\t\t\thash text NOT NULL,\n" +
  "\t\t\t\tcreated_at numeric\n" +
  "\t\t\t)";

/**
 * Issue #117, mechanism 1 — the reason this repo applies migrations itself instead of calling
 * drizzle's `migrate()`.
 *
 * drizzle-orm 0.45.2's `SQLiteSyncDialect.migrate` runs the bookkeeping `CREATE TABLE IF NOT EXISTS`
 * and the journal read `SELECT … ORDER BY created_at DESC LIMIT 1` in **autocommit**, and only then
 * issues a **deferred** `BEGIN`. The decision of what to apply is therefore made outside the
 * transaction that applies it, and a deferred `BEGIN` takes no write lock until its first write — so
 * two processes bootstrapping one new database both read an empty journal, the first commits every
 * migration, and the second replays `0000` onto tables that now exist and fails on
 * `CREATE TABLE availability`. Reproduced: 6 of 11 measured failures took this path (the other 5 were
 * `enableWal` above). SQLite's busy timeout does not help — nothing here is waiting on a lock; the
 * read is simply stale.
 *
 * `BEGIN IMMEDIATE` takes the write lock **up front**, so the journal read below happens under it and
 * nothing can commit between the read and the writes it decides on. A second process blocks at the
 * `BEGIN IMMEDIATE` — which, unlike the journal-mode pragma, *is* covered by the busy handler — then
 * reads the journal the first process just wrote and correctly applies nothing.
 *
 * **Within better-sqlite3's 5s `busy_timeout`, and not beyond it.** Said that way because the
 * unqualified version was wrong: if the first process's transaction outlasts that budget — a large
 * database where migration 0009's unique-index build is slow — the second gets `SQLITE_BUSY` and
 * `tn db migrate` reports `database is locked` while the first goes on to commit. That is the
 * ORIGINAL symptom of this issue, reproduced by a different cause, and no timeout value removes it;
 * it only moves the threshold. It is accepted rather than solved: the failure is now a true statement
 * about what happened ("database is locked", after actually waiting) instead of the false one it used
 * to be ("table availability already exists"), and it needs a migration slower than every one on
 * record. Recorded as a known limitation on PR #120 rather than hidden behind a bigger constant.
 *
 * **Everything else is drizzle's semantics, deliberately unchanged** — same bookkeeping table, same
 * single pre-loop **timestamp watermark** (`Number(watermark) < folderMillis`, evaluated against one
 * read rather than a running maximum), same `INSERT ("hash", "created_at")`, same statement split via
 * `readMigrationFiles`. That watermark rule is what
 * `docs/runbooks/db-migration-recovery.md` documents as the recovery procedure's premise, and what an
 * existing database's journal already encodes; changing it here would silently re-apply or silently
 * skip migrations on every database in existence. The equivalence is asserted rather than asserted
 * *about*: `test/db-migrate-serialization.test.ts` migrates one database with each implementation and
 * compares `sqlite_master` and `__drizzle_migrations` row for row, which is also what fails loudly if
 * a future drizzle-orm upgrade changes the format underneath this copy.
 *
 * `BEGIN IMMEDIATE` sits OUTSIDE the `try`, so reaching the catch means the transaction opened. That
 * is necessary but **not sufficient** for an unconditional `ROLLBACK`, which an earlier revision of
 * this comment got wrong — it claimed SQLite's automatic-rollback classes (`SQLITE_FULL`,
 * `SQLITE_IOERR`, `SQLITE_NOMEM`, `SQLITE_BUSY`, an explicit `ON CONFLICT ROLLBACK`) were
 * "unreachable here" and that a guard would be a branch no test could kill. The independent Reviewer
 * refuted it with a trace, and running the trace confirmed it: cap a database with
 * `PRAGMA max_page_count`, and a migration statement raises `SQLITE_FULL` with `inTransaction`
 * already `false` — after which a bare `ROLLBACK` throws *"cannot rollback - no transaction is
 * active"* and **replaces** the real "database or disk is full". The masking error is the one the
 * operator would have had to debug.
 *
 * So the guard is real, and it is killable — `test/db-migrate-serialization.test.ts` kills it with
 * exactly that trace. Worth recording why the wrong version was persuasive: the reasoning about
 * constraint failures aborting the statement rather than the transaction is *correct*, and it covers
 * the only failure this change had actually produced. It was an argument from the reachable set
 * someone had thought of, presented as a property of the code.
 */
export function applyMigrations(
  sqlite: Database.Database,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): void {
  // Read the files BEFORE taking the lock: this is filesystem I/O with its own failure mode ("Can't
  // find meta/_journal.json"), and there is no reason for it to happen inside a transaction or to
  // leave one open if it throws.
  const migrations = readMigrationFiles({ migrationsFolder });

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(DRIZZLE_MIGRATIONS_TABLE_DDL);
    const watermark = sqlite
      .prepare(`SELECT created_at AS createdAt FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`)
      .get() as { createdAt: unknown } | undefined;
    const record = sqlite.prepare(
      `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`,
    );
    for (const migration of migrations) {
      if (watermark === undefined || Number(watermark.createdAt) < migration.folderMillis) {
        // `prepare().run()`, the SAME primitive drizzle uses — deliberately, and this was `exec` in
        // the first revision. `exec` runs EVERY statement in the string it is given; `prepare`
        // rejects a multi-statement one outright ("The supplied SQL string contains more than one
        // statement"). Since a `--> statement-breakpoint` chunk is meant to be exactly one statement,
        // that rejection is a guard, and `exec` silently discarded it: a hand-authored migration —
        // and this repo hand-authors migration DML, in `0001` and `0010` — that forgot a breakpoint
        // would have run both halves and recorded the migration as applied. Measured on the
        // Reviewer's own trace: `exec` ran `CREATE TABLE audit …; DROP TABLE teams;` and the table
        // was gone, where `prepare` refuses. Swapping a loud failure for a silent one is the trade
        // this repo least wants, and matching drizzle here costs nothing.
        for (const statement of migration.sql) sqlite.prepare(statement).run();
        record.run(migration.hash, migration.folderMillis);
      }
    }
    sqlite.exec("COMMIT");
  } catch (err) {
    // Conditional, because SQLite may already have rolled back — see the doc above. Rolling back
    // when there is no transaction throws, and that throw would leave the catch propagating the
    // WRONG error.
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    throw err;
  }
}

/**
 * `options.verbose` is the SAME observation seam `openDb` already documents (issue #32, ask #4),
 * forwarded one level so a test can see the statement SEQUENCE this function issues rather than only
 * its end state. Issue #117 needs exactly that: the defect it fixes is an ORDERING one — the
 * migration journal being read before the transaction that acts on it — and ordering is invisible in
 * a finished database, which is why the pre-fix behavior looked correct to every existing test.
 * `test/db-migrate-serialization.test.ts` asserts the order through this parameter, deterministically,
 * instead of racing two processes and hoping.
 */
export function runMigrations(
  path: string = dbPath(),
  options: Pick<OpenDbOptions, "verbose"> = {},
): void {
  // The ONLY caller that opts into `create: true` — bootstrapping a fresh database (or
  // continuing to migrate an existing one) is exactly this function's job. Every other one of the
  // ~30 `openDb()` call sites inherits the new `create: false` default (issue #111).
  const { db, sqlite } = openDb(path, { ...options, create: true });
  try {
    try {
      applyMigrations(sqlite);
    } catch (err) {
      const chain = messageChain(err);
      if (TEAMS_URL_UNIQUE_FAILURE.test(chain)) {
        // ABSOLUTE, always: the reader is not necessarily standing in the directory the run used,
        // so a relative path names a file they cannot find. (This used to carry a second reason —
        // an absolute path can never be parsed as an OPTION — which mattered only while a shell
        // command was being emitted, and retired with it in #56. The reason above did not.)
        const source = resolve(path);
        // How the database is named. A path that survives every transform between here and the
        // reader is shown literally; one that does not is escaped and SAID to be escaped, so the
        // reader knows the odd-looking text is a rendering rather than the filename.
        //
        // The predicate is `UNRENDERABLE`, which is `sanitizeValue`'s class PLUS lone surrogates.
        // Deriving it from `sanitizeValue` alone read better and was wrong (Codex round 7): the
        // sanitizer is one of TWO mechanisms that corrupt a path on the way out, and the other —
        // Node's UTF-8 encoder turning a lone surrogate into U+FFFD — leaves no trace in the
        // sanitizer's class. "Match what module X strips" is the right instinct only when X is the
        // ONLY thing between here and the reader.
        //
        // Both branches once differed by more than this: the renderable one carried a
        // copy-pasteable `mv`, and the escaped one withheld it because any rendering of such a path
        // would name a DIFFERENT file — pasting it would move an unrelated database aside while the
        // real one still failed to migrate (Codex round 5, rated high). #56 removed the command
        // from both, so the difference that remains is purely how the path is written.
        const where = UNRENDERABLE.test(source)
          ? `at ${losslessPath(source)} (path escaped — it contains characters that cannot be shown literally)`
          : `(${source})`;

        // SINGLE LINE, no newlines — a hard requirement of the consumer, not a style choice.
        // `tn db migrate` renders this through `emitSummary`'s one-line `key=value` summary, whose
        // `quoteSummaryValue` -> `sanitizeValue` replaces every control character (newlines
        // included) with a space. A multi-line message therefore does not survive: it collapses
        // into one long run of prose, which is precisely what a human staring at a failed migration
        // cannot use.
        //
        // This is a MERGE-BORN defect neither side had alone, and it is why it is called out here:
        // this message was first written against `console.error`, which passed newlines through,
        // while #44/PR #51 concurrently moved `db migrate` onto `emitSummary`. Both changes were
        // green in isolation. Keep the message single-line; the long form lives in
        // docs/runbooks/db-migration-recovery.md, which is markdown and has room for it.
        //
        // The path is interpolated INTO a sentence, never appended after one. An earlier form
        // sliced a trailing space off a fixed prefix and stuck `(${source})` on the end, which
        // RENDERED as "...cannot apply.(/path)." — the database orphaned after a full stop. Eight
        // static review rounds passed over that; it only shows when the message is actually
        // printed, which is why every run touching this line renders it end-to-end through
        // `tn db migrate` against a seeded duplicate-pair database rather than reading the source.
        throw new Error(
          "UNIQUE constraint failed: teams.tennisrecord_url — this database " +
            `${where} has two team rows sharing one tennisrecord_url (issue #46), so migration ` +
            "0009's unique index cannot apply. Recovery moves this database aside rather than " +
            "deleting it, but read the runbook FIRST: captain notes and availability exist ONLY " +
            "in this file and must be exported from it before you re-pull. " +
            "docs/runbooks/db-migration-recovery.md",
        );
      }
      throw err;
    }
    // Issue #32: keys every row `migrate()` didn't (a fresh DB has none to backfill; an existing
    // DB upgrading past migration 0004 does). JS-side, idempotent — see backfillNameKeys's doc.
    backfillNameKeys(db);
    // Issue #130: corrects every row a pre-fix pull already wrote with a raw, unmapped gender
    // label. Run after the name-key backfill above on the same "every migrate call, idempotent"
    // reasoning — see backfillGenders's own doc for why its scope is every NON-NULL row, not only
    // unfilled ones.
    backfillGenders(db);
  } finally {
    sqlite.close();
  }
}
