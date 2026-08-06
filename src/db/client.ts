import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../error-message.js";
import { repoDefault } from "../fs/package-root.js";
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

// drizzle-orm's migrator resolves `migrationsFolder` with plain `fs` calls against
// `process.cwd()` — it does no path resolution of its own. Anchor to this module's own
// location (repo root, two levels up from src/db/) so `tn db migrate` finds the migrations
// regardless of the caller's working directory.
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
 * behavior. When that open fails, `isAbsentPath` below decides — by errno, never by `existsSync` —
 * whether "missing database" is actually the right thing to tell the operator.
 */
export class MissingDatabaseError extends Error {}

/**
 * Is `path` absent, as opposed to present-but-unopenable? Asked ONLY after an open has already
 * failed, purely to pick the error message — it never decides whether to proceed, so it is not a
 * check-then-act guard (`fileMustExist` at `open(2)` is what actually enforces).
 *
 * It has to ask via errno, and `existsSync` is not good enough — this was a Codex adversarial
 * review finding on PR #116, and the reviewer's own recommended fix does not work either.
 * Measured, not assumed:
 *
 *   | state                        | better-sqlite3 error | existsSync | open(2) errno |
 *   |------------------------------|----------------------|------------|---------------|
 *   | file absent                  | SQLITE_CANTOPEN      | false      | ENOENT        |
 *   | parent directory absent      | SQLITE_CANTOPEN      | false      | ENOENT        |
 *   | parent is a REGULAR FILE     | SQLITE_CANTOPEN      | false      | ENOTDIR       |
 *   | parent not traversable       | SQLITE_CANTOPEN      | false      | EACCES        |
 *
 * So SQLite flattens all four to one code (which is why "classify by the SQLite error code" cannot
 * work), and `existsSync` answers `false` for all four (which is why the previous version told an
 * operator with a misconfigured `TN_DB_PATH` to run `tn db migrate` — advice that cannot repair
 * ENOTDIR or EACCES — while `writeRequestLogRow`'s `MissingDatabaseError` carve-out silently
 * discarded the genuine storage failure). Only the raw `open(2)` errno separates them.
 *
 * A successful open means the file is there and readable, so whatever SQLite objected to (a corrupt
 * or non-database file) is NOT absence: return false and let the original error through.
 */
function isAbsentPath(path: string): boolean {
  try {
    closeSync(openSync(path, "r"));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
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
    if (options.create !== true && isAbsentPath(path)) {
      throw new MissingDatabaseError(
        `no database at ${resolve(path)} — run \`tn db migrate\` to create it`,
      );
    }
    throw err;
  }
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
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

export function runMigrations(path: string = dbPath()): void {
  // The ONLY caller that opts into `create: true` — bootstrapping a fresh database (or
  // continuing to migrate an existing one) is exactly this function's job. Every other one of the
  // ~30 `openDb()` call sites inherits the new `create: false` default (issue #111).
  const { db, sqlite } = openDb(path, { create: true });
  try {
    try {
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
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
  } finally {
    sqlite.close();
  }
}
