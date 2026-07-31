import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { losslessPath, runMigrations, UNRENDERABLE } from "../src/db/client.js";
import { sanitizeValue } from "../src/sanitize.js";
import { buildLegacyMigrationsFolder } from "./helpers/legacy-migrations.js";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
}

/**
 * The WHOLE message `runMigrations` must throw for a duplicate-URL failure, authored here
 * independently of `src/db/client.ts` rather than imported from it — importing the builder would
 * make the assertion compare the code to itself.
 *
 * `where` is how the database is named: `(<abs path>)` when the path can be shown literally, or
 * `at <escaped> (path escaped — …)` when it cannot.
 *
 * Asserting **exact equality** rather than a list of forbidden substrings is the #56 invariant's
 * only sound form, and it took two adversarial rounds to accept that. A blacklist establishes that
 * specific things are absent; the property actually needed is that the message contains **no
 * executable instruction at all**, which is a statement about everything NOT on the list. Two
 * counterexamples proved the gap rather than argued it — `cp -n <src> <src>.backup` slipped a
 * named-verb list, and then `node -e "…renameSync…" <src>` slipped the same list *plus* a
 * structural "the path occurs exactly once" check, since it names the database only once (Codex
 * adversarial review of #56, rated high). Equality inverts the quantifier: nothing can be added to
 * this message without reddening, so the next escape nobody has thought of is caught too.
 */
function expectedDuplicateUrlMessage(where: string): string {
  return (
    "UNIQUE constraint failed: teams.tennisrecord_url — this database " +
    `${where} has two team rows sharing one tennisrecord_url (issue #46), so migration ` +
    "0009's unique index cannot apply. Recovery moves this database aside rather than " +
    "deleting it, but read the runbook FIRST: captain notes and availability exist ONLY " +
    "in this file and must be exported from it before you re-pull. " +
    "docs/runbooks/db-migration-recovery.md"
  );
}

/**
 * Issue #46, Task 5: a pre-existing database holding a duplicate `tennisrecord_url` pair (the
 * exact damage #46 fixes) makes migration 0009's `CREATE UNIQUE INDEX` fail. This models "a real
 * database that was created and used before this PR's partial-unique-index migration existed" the
 * same way `test/db-membership-unique-upgrade.test.ts` does for the membership index, via
 * `buildLegacyMigrationsFolder` (migrations 0000-0008, i.e. everything before #46's migration —
 * which renumbered from 0006 to 0009 when #49 landed three migrations on `main` mid-review;
 * `docs/findings.md` records that collision hazard and why the resolution is to regenerate
 * rather than hand-edit a snapshot).
 */
describe("upgrading an existing v5 database with duplicate tennisrecord_url rows (#46)", () => {
  it("runMigrations throws a legible error naming teams.tennisrecord_url and the recovery, not a bare UNIQUE constraint message", () => {
    const dbPath = freshDbPath();
    const legacyDir = buildLegacyMigrationsFolder(8);
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: legacyDir });
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A', 'https://tr/team?a')`,
      );
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A 4.0', 'https://tr/team?a')`,
      );
    } finally {
      sqlite.close();
    }

    let caught: unknown;
    try {
      runMigrations(dbPath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/teams\.tennisrecord_url/);
    // The legibility fix — not a bare passthrough of SQLite's own message.
    expect(message).not.toBe("UNIQUE constraint failed: teams.tennisrecord_url");
    // The recovery. Issue #56 retired the emitted `mv` command, so the runbook LINK is what "and
    // the recovery" means in this title now — it is the only thing the message hands the reader.
    expect(message).toContain("docs/runbooks/db-migration-recovery.md");
  });

  // Codex adversarial review, rated CRITICAL. `runMigrations(path)` takes the database path — it is
  // routinely NOT the default (every test here, and any run with TN_DB_PATH set) — but the first
  // draft of the recovery hardcoded `rm data/nadal.db`. Following that instruction would delete a
  // DIFFERENT, unrelated database and leave the failing one untouched: a destructive command aimed
  // at the wrong file.
  //
  // Issue #56 then retired the emitted command ALTOGETHER. That single line produced a defect in six
  // of the eleven review rounds on PR #52 — wrong file, clobbered backup, BSD `mv`, control
  // characters, lossy escaping, lone surrogates — and the runbook already carries the command in
  // markdown, where no sanitizer eats it and no encoding question arises. So this test inverted: it
  // no longer pins the SHAPE of a command, it pins that there is NO command. What round 1 was
  // actually about survives untouched — name the database that ACTUALLY failed, and never tell
  // anyone to delete it.
  it("REGRESSION: the recovery names the ACTUAL failing database and emits no command at all", () => {
    const dbPath = freshDbPath();
    expect(dbPath).not.toContain("data/nadal.db"); // the premise of this test
    const legacyDir = buildLegacyMigrationsFolder(8);
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: legacyDir });
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A', 'https://tr/team?a')`,
      );
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A 4.0', 'https://tr/team?a')`,
      );
    } finally {
      sqlite.close();
    }

    let caught: unknown;
    try {
      runMigrations(dbPath);
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;

    // No executable recovery — the #56 invariant, and the one a future author is most likely to
    // erode. Held by EXACT EQUALITY against an independently-authored expected message, which is
    // the only form that can carry the claim in this test's title: see
    // `expectedDuplicateUrlMessage`'s doc for the two counterexamples that killed the blacklist
    // this replaced. Nothing can be added to the message without reddening this line.
    expect(message).toBe(expectedDuplicateUrlMessage(`(${dbPath})`));

    // Everything below is IMPLIED by that equality and cannot independently fail today. They are
    // kept deliberately, and the reason is the one case equality does not cover: a future author
    // legitimately rewording the prose updates the expected string, and equality then re-passes on
    // whatever they wrote. These three survive that edit, so they are what still holds the round-1
    // finding (name the database that ACTUALLY failed, never the default) and the merge-born
    // single-line requirement after the string has moved on. Stated rather than left to be
    // rediscovered as redundancy.
    expect(message).toContain(dbPath);
    expect(message).not.toContain("data/nadal.db");
    expect(message).toContain("docs/runbooks/db-migration-recovery.md");
    // MERGE-BORN regression, caught integrating #44/PR #51. `tn db migrate` renders this message
    // through `emitSummary`'s one-line `key=value` summary, and `sanitizeValue` turns every control
    // character into a space — so a multi-line message silently collapses into one run of prose
    // with the `mv` command buried mid-paragraph. The message must be single-line BY CONSTRUCTION.
    // Guarded here (the message itself) and end-to-end in test/cli-db-migrate-command.test.ts (the
    // rendered CLI line), because this defect lives in the seam between them and neither side had
    // it alone.
    // The predicate is sanitizeValue's OWN character class, not a hand-listed subset: \p{Cc} +
    // \p{Cf} + U+2028/U+2029 (src/sanitize.ts). A narrower list here would claim "single-line" while
    // missing DEL, the C1 block and every format control — a check whose comment outruns what it
    // enforces, which rules/testing.md names as worse than no check. Codex round 4 caught exactly
    // that in the first draft of this assertion.
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
  });

  // Codex round 2, rated HIGH — its regression test was DELETED by #56 rather than retargeted, and
  // the argument is recorded here so the next author does not have to reconstruct it from history.
  //
  // The finding: the round-1 fix replaced `rm` with a bare `mv` to a FIXED `<path>.pre-0009.bak`, so
  // a SECOND migration failure overwrote the FIRST backup — silently destroying the captain notes
  // and availability the very same message promised were safe. It was closed by construction
  // (`untakenBackupPath` picked a name only after checking what was on disk, with `mv -i` covering
  // the residual TOCTOU) and pinned by a test that seeded a backup and asserted the emitted command
  // never named it.
  //
  // #56 removed the emitted command, and `untakenBackupPath` with it. There is no backup NAME in the
  // message any more, so the failure mode is not merely untested — it is UNCONSTRUCTABLE: no input
  // can satisfy the test's own premise. `rules/testing.md` forbids keeping a check no fixture can
  // distinguish, and a test asserting the absence of something that cannot exist is exactly that
  // check wearing a test's clothes. The surviving guard is strictly stronger: the no-command-at-all
  // assertion above rejects `.bak` outright, so it fails on any attempt to reintroduce a backup
  // path, not merely on one that collides.

  // Codex round 3 recommended emitting absolute paths so neither argument can begin with `-`.
  // Adopted — it closed the dash-prefixed-path class structurally instead of relying on `--`.
  //
  // The command it was recommended for is gone (#56), but the finding's OTHER half is not, and that
  // is why this test survives while round 2's did not: a reader acting on this message is not
  // necessarily standing in the directory the run used, so a relative path is a trap whether it sits
  // inside a command or in prose. The `-`-prefix half died with the command; this half did not.
  //
  // (The round-3 finding this came attached to — that BSD `mv` on macOS rejects `--` — was DISPUTED
  // and not accepted; see the PR thread. `mv -i -- -db -db.bak` exits 0 on this host. The `mv:
  // illegal option -- -` text that finding cited comes from `mv --version`, which BSD `mv` has no
  // flag for; its wording merely reads as though the terminator were rejected.)
  it("REGRESSION: the message names an ABSOLUTE path even when given a relative one", () => {
    const dbPath = freshDbPath();
    const legacyDir = buildLegacyMigrationsFolder(8);
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: legacyDir });
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A', 'https://tr/team?a')`,
      );
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A 4.0', 'https://tr/team?a')`,
      );
    } finally {
      sqlite.close();
    }

    // Address the very same file by a RELATIVE path, without chdir-ing into the repo or writing
    // anything into it: `resolve(cwd, relative(cwd, p))` is exactly `p`.
    const relativePath = relative(process.cwd(), dbPath);
    expect(relativePath).not.toBe(dbPath); // the premise of this test
    expect(isAbsolute(relativePath)).toBe(false);

    let caught: unknown;
    try {
      runMigrations(relativePath);
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;

    // The path the message names is the absolute one, not the relative one it was called with.
    expect(message).toContain(dbPath);
    expect(message).not.toContain(relativePath);
  });

  // Codex round 5, rated HIGH — and it REFUTED the round-4 dispute rather than repeating it, with
  // the distinguishing case: main's success-path `path=` field is merely lossy to LOOK at, whereas
  // an executable recovery turns that same loss into a DESTRUCTIVE ACTION ON THE WRONG FILE. With
  // TN_DB_PATH holding a legal control-character pathname, `sanitizeValue` renders the newline as a
  // space, so a printed `mv` would name the space-normalized sibling; if that file exists, pasting
  // the command moves an UNRELATED database aside while the real one still fails to migrate.
  //
  // #56 removed the command from BOTH branches, which retires the destructive half of that finding
  // outright. What remains — and what this test now covers — is the display half the same round
  // established: the message must name the real database, so a path that cannot be shown literally
  // is rendered losslessly rather than being allowed to normalize into a DIFFERENT file's name.
  // That is the whole remaining job of the `UNRENDERABLE` branch, and it is still a real, killable
  // difference from the literal rendering the other branch produces.
  it("REGRESSION: renders an unrenderable database path losslessly, never as a different file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const dbPath = join(dir, "we\nird.db"); // a legal POSIX filename containing a newline
    const legacyDir = buildLegacyMigrationsFolder(8);
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: legacyDir });
      sqlite.exec(`INSERT INTO teams (name, tennisrecord_url) VALUES ('A', 'https://tr/t?a')`);
      sqlite.exec(`INSERT INTO teams (name, tennisrecord_url) VALUES ('A 4.0', 'https://tr/t?a')`);
    } finally {
      sqlite.close();
    }
    // The space-normalized sibling — the file a naive rendering would have named (and, before #56,
    // the file a pasted `mv` would have moved). It is deliberately NOT created on disk: nothing on
    // this path touches the filesystem, so a seeded file plus an "it is still intact" assertion
    // would assert something no code path could ever change.
    const sibling = join(dir, "we ird.db");

    let caught: unknown;
    try {
      runMigrations(dbPath);
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;

    // The ESCAPED branch gets the same exact-equality treatment as the literal one, and for the
    // same reason: a blacklist cannot establish that no executable instruction is present. The
    // expected escape is authored here (`\n` -> `\u{A}`) rather than by calling `losslessPath`, so
    // this compares the code to a hand-written expectation instead of to itself.
    const escaped = dbPath.replace(String.fromCharCode(10), "\\u{A}");
    expect(message).toBe(
      expectedDuplicateUrlMessage(
        `at ${escaped} (path escaped — it contains characters that cannot be shown literally)`,
      ),
    );

    // Implied by the equality above, kept for the same reason as in the literal-branch test: these
    // are what still holds if the prose is reworded and the expected string moves with it.
    expect(message).not.toMatch(/\bmv\b/);
    // The message never names the space-normalized sibling — the whole point of this branch.
    expect(message).not.toContain(sibling);
    expect(message).toContain(escaped);
    expect(sanitizeValue(message)).toBe(message);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    // The runbook link survives this branch too — a reader whose path cannot be shown literally
    // needs the recovery MORE than one whose path can, not less.
    expect(message).toContain("docs/runbooks/db-migration-recovery.md");
  });

  // Codex round 6, rated HIGH. The round-5 fail-safe rendered the path with `JSON.stringify`, which
  // escapes the C0 controls but leaves DEL, the C1 block, every \p{Cf} format control and
  // U+2028/U+2029 LITERAL — and `sanitizeValue` replaces exactly those downstream. So a path
  // containing U+2028 or RIGHT-TO-LEFT OVERRIDE reached the reader neither losslessly nor
  // control-free, while the message claimed both: a comment outrunning what the code enforced,
  // which is the shape this repo keeps re-learning. `src/cli/emit.ts` had already documented this
  // exact `JSON.stringify` shortfall for its own payload.
  //
  // `losslessPath` escapes every character in sanitizeValue's OWN class, so these two cases — one
  // Zl-adjacent (U+2028), one Cf (RLO) — must round-trip through the whole CLI render intact.
  it.each([
    { label: "U+2028 LINE SEPARATOR", ch: "\u2028", escaped: "\\u{2028}" },
    { label: "U+202E RIGHT-TO-LEFT OVERRIDE (Cf)", ch: "\u202E", escaped: "\\u{202E}" },
  ])("REGRESSION: renders a path containing $label losslessly and control-free", ({ ch, escaped }) => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const dbPath = join(dir, `we${ch}ird.db`);
    const legacyDir = buildLegacyMigrationsFolder(8);
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: legacyDir });
      sqlite.exec(`INSERT INTO teams (name, tennisrecord_url) VALUES ('A', 'https://tr/t?a')`);
      sqlite.exec(`INSERT INTO teams (name, tennisrecord_url) VALUES ('A 4.0', 'https://tr/t?a')`);
    } finally {
      sqlite.close();
    }

    let caught: unknown;
    try {
      runMigrations(dbPath);
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;

    // FULL-MESSAGE equality here too, not just "contains the escape". Codex round 2 (rated high)
    // pointed out that these cases asserted strictly less than the newline case one test up, so for
    // every character class except newline the no-command invariant rested on a single
    // `not.toMatch(/\\bmv\\b/)`. The escaped BRANCH was already pinned by the newline case's
    // equality, so this is defense in depth rather than a live hole — but "one character class
    // happens to carry the strong assertion for all of them" is not a property worth resting on,
    // and equality costs one line here.
    expect(message).toBe(
      expectedDuplicateUrlMessage(
        `at ${dbPath.replace(ch, escaped)} (path escaped — it contains characters that cannot be shown literally)`,
      ),
    );

    // Implied by the equality above; kept because they survive a deliberate prose rewording.
    // Lossless: the exact code point is recoverable from the escape...
    expect(message).toContain(escaped);
    // ...and survives sanitizeValue untouched, which is the whole point (JSON.stringify did not).
    expect(sanitizeValue(message)).toBe(message);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    // Still fails safe: no command that could name the wrong file.
    expect(message).not.toMatch(/\bmv\b/);
  });

  // Codex round 7, rated HIGH. `losslessPath` escaped Cc/Cf/U+2028/U+2029 but left a LONE UTF-16
  // SURROGATE literal — and `sanitizeValue` leaves those alone too, so a surrogate path skipped the
  // fail-safe entirely and got an `mv` command. Node's UTF-8 encoder then writes it as U+FFFD
  // ("x\uD800y" emits bytes 78 ef bf bd 79), so that command named a REPLACEMENT-CHARACTER sibling
  // rather than the real database. Two mechanisms corrupt a path on the way out; deriving the guard
  // from the sanitizer alone only ever covered one of them.
  //
  // Tested against the PURE functions rather than end-to-end, and that is a correctness requirement
  // rather than a shortcut: a lone surrogate cannot exist as a real filename on ANY platform, since
  // every OS stores path bytes and encoding one to UTF-8 already replaces it with U+FFFD. The first
  // draft of this test seeded the U+FFFD file and called with the surrogate string, which passed on
  // macOS and FAILED ON LINUX CI (`runMigrations` never threw there) — a test asserting a
  // filesystem's name-resolution coincidence, not this module's behavior. The end-to-end fail-safe
  // is covered above by the newline case, which IS a legal filename everywhere.
  describe("lone surrogates (#46, Codex round 7)", () => {
    const lone = String.fromCharCode(0xd800);

    it("REGRESSION: are treated as unrenderable, so the caller fails safe", () => {
      expect(UNRENDERABLE.test(`/tmp/we${lone}ird.db`)).toBe(true);
      // The premise the finding turned on: the sanitizer alone does NOT catch this, so a
      // sanitizer-derived predicate let it through.
      expect(sanitizeValue(`/tmp/we${lone}ird.db`)).toBe(`/tmp/we${lone}ird.db`);
    });

    it("REGRESSION: are rendered losslessly, and the rendering is itself renderable", () => {
      const rendered = losslessPath(`/tmp/we${lone}ird.db`);
      expect(rendered).toBe("/tmp/we\\u{D800}ird.db");
      expect(UNRENDERABLE.test(rendered)).toBe(false);
      expect(sanitizeValue(rendered)).toBe(rendered);
    });

    it("escapes backslashes first, so the mapping is injective", () => {
      // A path legitimately containing the TEXT of an escape must not collide with a produced one.
      expect(losslessPath("/tmp/a\\u{D800}b.db")).toBe("/tmp/a\\\\u{D800}b.db");
      expect(losslessPath(`/tmp/a${lone}b.db`)).toBe("/tmp/a\\u{D800}b.db");
      expect(losslessPath("/tmp/a\\u{D800}b.db")).not.toBe(losslessPath(`/tmp/a${lone}b.db`));
    });
  });

  it("the same legacy database WITHOUT duplicates upgrades cleanly and the index exists", () => {
    const dbPath = freshDbPath();
    const legacyDir = buildLegacyMigrationsFolder(8);
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: legacyDir });
      sqlite.exec(
        `INSERT INTO teams (name, tennisrecord_url) VALUES ('Springfield A', 'https://tr/team?a')`,
      );
    } finally {
      sqlite.close();
    }

    expect(() => runMigrations(dbPath)).not.toThrow();

    const after = new Database(dbPath);
    try {
      const indexes = after
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='teams'`)
        .all() as Array<{ name: string }>;
      expect(indexes.some((i) => i.name === "teams_tennisrecord_url_unique")).toBe(true);
    } finally {
      after.close();
    }
  });
});
