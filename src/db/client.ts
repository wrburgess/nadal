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
// damage #46 fixes) makes migration 0009's `CREATE UNIQUE INDEX` fail with a bare "UNIQUE
// constraint failed: teams.tennisrecord_url" — legible to nobody who hasn't read this migration.
// Shipping no dedupe DML for that pair is a deliberate choice (a same-URL rename collision is a
// merge decision, out of bounds per spec § Ingestion, same as `upsertTeam`'s own
// `AmbiguousIdentityError`), so THIS message is the whole mitigation: it names the cause and the
// one-line recovery rather than silently leaving `tn db migrate` broken. See
// docs/runbooks/db-migration-recovery.md for the full runbook this line is drawn from.
const TEAMS_URL_UNIQUE_FAILURE = /UNIQUE constraint failed: teams\.tennisrecord_url/;

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
 * the database to a FIXED `<path>.pre-0009.bak`, which meant a SECOND failure overwrote the FIRST
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
  const preferred = `${dbPath}.pre-0009.bak`;
  return existsSync(preferred) ? `${dbPath}.pre-0009.${Date.now()}.bak` : preferred;
}

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
        // ABSOLUTE, always. Two reasons, and the second is the load-bearing one:
        //   1. the reader may not be in the directory the run used, so a relative path in a
        //      copy-pasteable recovery command is a trap;
        //   2. an absolute path cannot begin with `-`, so it can never be parsed as an OPTION —
        //      which closes the dash-prefixed-`TN_DB_PATH` hazard structurally rather than relying
        //      on the `--` terminator alone (Codex round 3; see the note on `--` below).
        const source = resolve(path);
        // SINGLE LINE, no newlines — a hard requirement of the consumer, not a style choice.
        // `tn db migrate` renders this through `emitSummary`'s one-line `key=value` summary, whose
        // `quoteSummaryValue` -> `sanitizeValue` replaces every control character (newlines
        // included) with a space. A multi-line message therefore does not survive: it collapses
        // into one long run of prose with the recovery command buried mid-paragraph, which is
        // precisely what a human staring at a failed migration cannot use.
        //
        // This is a MERGE-BORN defect neither side had alone, and it is why it is called out here:
        // this message was first written against `console.error`, which passed newlines through,
        // while #44/PR #51 concurrently moved `db migrate` onto `emitSummary`. Both changes were
        // green in isolation. Keep the message single-line; the long-form version lives in
        // docs/runbooks/db-migration-recovery.md, which is markdown and has room for it.
        // Built as a function of the path rather than concatenated around it. The earlier form
         // sliced a trailing space off a fixed prefix and appended `(${source})`, which RENDERED as
         // "...cannot apply.(/path)." — the database orphaned after a full stop. Eight static review
         // rounds passed over that; it only shows when the message is actually printed, which is why
         // this run renders it end-to-end through `tn db migrate` rather than reading the source.
        const cause = (where: string) =>
          "UNIQUE constraint failed: teams.tennisrecord_url — this database " +
          `${where} has two team rows sharing one tennisrecord_url (issue #46), so migration ` +
          "0009's unique index cannot apply.";
        const DATA_AT_RISK =
          " Captain notes and availability exist ONLY in this file, so extract them from the " +
          "backup first: docs/runbooks/db-migration-recovery.md";

        // A path that cannot be reproduced faithfully in the one-line summary gets NO
        // copy-pasteable command. Emitting an `mv` for one is worse than emitting none: the
        // rendered command names a normalized sibling path, and if THAT file exists, pasting it
        // moves an unrelated database aside while the real one still fails to migrate. Codex round
        // 5 refuted the earlier "this is pre-existing" position on exactly that point, and
        // correctly — main's success-path `path=` field is merely lossy to LOOK at, whereas an
        // executable recovery turns the same loss into a destructive action on the wrong file.
        // Display-loss and wrong-action are not the same severity, so this fails safe.
        //
        // The predicate is `UNRENDERABLE`, which is `sanitizeValue`'s class PLUS lone surrogates.
        // Deriving it from `sanitizeValue` alone read better and was wrong (Codex round 7): the
        // sanitizer is one of TWO mechanisms that corrupt a path on the way out, and the other —
        // Node's UTF-8 encoder turning a lone surrogate into U+FFFD — leaves no trace in the
        // sanitizer's class. "Match what module X strips" is the right instinct only when X is the
        // ONLY thing between here and the reader.
        if (UNRENDERABLE.test(source)) {
          throw new Error(
            `${cause(`at ${losslessPath(source)} (path escaped — it contains characters that cannot be shown literally)`)}` +
              " No copy-pasteable command is offered for it: any rendering of that path would name a " +
              "DIFFERENT file. Move the database aside yourself and re-run `tn db migrate`." +
              DATA_AT_RISK,
          );
        }

        throw new Error(
          `${cause(`(${source})`)} Recover (non-destructive, moves the file aside): ` +
            `mv -i -- ${shellQuote(source)} ${shellQuote(untakenBackupPath(source))} && tn db migrate ` +
            `— then re-pull.${DATA_AT_RISK}`,
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
