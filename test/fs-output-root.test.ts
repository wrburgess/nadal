import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fsModule from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOutputPathSafe,
  openNewOutputFileSafely,
  overwriteOutputFile,
  OutputPathError,
  writeNewOutputFile,
} from "../src/fs/output-root.js";

// `spawnSync`/`writeFileSync`/`renameSync` are all named ESM exports, and Node's built-in module
// namespaces are not configurable — `vi.spyOn` cannot redefine a property on either directly
// (Vitest throws "Module namespace is not configurable in ESM"). The supported way to observe (or,
// for a handful of atomicity tests below, selectively fail) an unmodified built-in's calls is a
// partial `vi.mock` that CALLS THROUGH to the real implementation by default (`vi.fn(actual.fn)`
// wraps it rather than replacing its behavior) — so every OTHER test in this file, and every OTHER
// call these two functions make, is completely unaffected; only a test that explicitly arms
// `mockImplementationOnce` on one of them observes different behavior, and only for its one call.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    writeSync: vi.fn(actual.writeSync),
    closeSync: vi.fn(actual.closeSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

// This module is the generalized form of the guard `src/ingest/archive.ts` used to hand-roll for
// `raw/` alone (five Codex adversarial-review rounds on PR #31 hardened it). `permittedDir` is now
// a parameter rather than a single hardcoded name, so these tests exercise that parameterization
// directly with "reports" as the caller's permitted directory — the shape `src/report/write.ts`
// will use next — rather than only ever re-testing "raw" through `src/ingest/archive.ts`'s own
// suite (which stays untouched as the extraction's regression anchor).

describe("assertOutputPathSafe", () => {
  describe("the permitted directory is a real parameter, not a second hardcoded exception", () => {
    afterEach(() => {
      rmSync(resolve("reports"), { recursive: true, force: true });
    });

    it("accepts the repo's own gitignored reports/ as the root when \"reports\" is permitted", () => {
      const root = resolve("reports");
      const candidate = join(root, "team-x", "index.html");
      expect(() => assertOutputPathSafe(candidate, root, "reports")).not.toThrow();
    });

    it("refuses src as a root even though it is in-repo, when \"reports\" is permitted", () => {
      const root = resolve("src");
      const candidate = join(root, "leak.html");
      expect(() => assertOutputPathSafe(candidate, root, "reports")).toThrow(OutputPathError);
    });

    // REGRESSION guard for the extraction itself: if `permittedDir` were silently ignored in favor
    // of a leftover hardcoded "raw" exception, this would wrongly pass. `raw/` is a real in-repo
    // directory (another caller's permitted root) that must NOT be treated as safe here.
    it("refuses raw/ as a root when \"reports\" is the caller's permitted dir", () => {
      const root = resolve("raw");
      const candidate = join(root, "leak.html");
      expect(() => assertOutputPathSafe(candidate, root, "reports")).toThrow(OutputPathError);
    });
  });

  it("refuses a symlinked component inside an otherwise-valid root", () => {
    const root = mkdtempSync(join(tmpdir(), "tn-out-root-"));
    symlinkSync(resolve("src"), join(root, "linked"), "dir");

    expect(() => assertOutputPathSafe(join(root, "linked", "leak.html"), root, "reports")).toThrow(
      OutputPathError,
    );
    expect(existsSync(join(resolve("src"), "leak.html"))).toBe(false);
  });

  it("refuses a root whose realpath lands inside the repo tree, even though it is lexically outside it", () => {
    const link = join(mkdtempSync(join(tmpdir(), "tn-out-link-")), "root-link");
    symlinkSync(resolve("src"), link, "dir");

    // Lexically `link` is outside the repo and every leaf is "inside root" — it must still fail,
    // because the link's REAL target resolves into the tracked working tree.
    expect(() => assertOutputPathSafe(join(link, "leak.html"), link, "reports")).toThrow(OutputPathError);
  });

  it("still allows a root that is a symlink to a directory OUTSIDE the repo", () => {
    const target = mkdtempSync(join(tmpdir(), "tn-out-real-"));
    const link = join(mkdtempSync(join(tmpdir(), "tn-out-link-")), "root-link");
    symlinkSync(target, link, "dir");

    expect(() => assertOutputPathSafe(join(link, "ok.html"), link, "reports")).not.toThrow();
  });

  it("refuses a `..` traversal out of the root", () => {
    const root = mkdtempSync(join(tmpdir(), "tn-out-root-"));
    const escaped = join(root, "..", "escaped.html");
    expect(() => assertOutputPathSafe(escaped, root, "reports")).toThrow(OutputPathError);
  });

  // Codex adversarial review, PR #31 round 3: every test above passes an ALREADY-RESOLVED absolute
  // root. `TN_RAW_PATH`/a future `TN_REPORTS_PATH` unset resolves instead to a bare repo-relative
  // string ("raw"/"reports") — the exact shape that let the un-generalized guard ship throwing on
  // every call under its own documented default, because every test of it set the env var to a
  // temp dir instead. This exercises that shape directly against the generic guard.
  describe("the documented-default shape (a bare repo-relative root string, mirroring an unset env var)", () => {
    afterEach(() => {
      rmSync(resolve("reports"), { recursive: true, force: true });
    });

    it("REGRESSION: allows a bare repo-relative root equal to the permitted dir", () => {
      mkdirSync(resolve("reports"), { recursive: true });
      expect(() => assertOutputPathSafe(join("reports", "team-x", "index.html"), "reports", "reports")).not.toThrow();
    });

    it("REGRESSION: allows the bare repo-relative root even before it exists on disk (first run)", () => {
      // No mkdirSync here: the root legitimately does not exist yet before the first write, and
      // `realpathOfNearestExisting` must walk up to an existing ancestor rather than throwing.
      expect(() =>
        assertOutputPathSafe(join("reports", "team-x", "index.html"), "reports", "reports"),
      ).not.toThrow();
    });
  });

  // REGRESSION (Codex adversarial review, PR #38, Finding 1 [critical]). The in-repo exception
  // above ("<repo>/<permittedDir> is safe because .gitignore covers it") only holds for files git
  // does not already know about. `.gitignore` has NO effect on a path git is already tracking — if
  // someone once ran `git add -f reports/team-a/index.html`, that path stays tracked forever
  // regardless of .gitignore, and this guard would happily wave a rewrite of it through, producing a
  // TRACKED change containing real people's names, ages and ratings in a PUBLIC repo. That is
  // exactly the publication this whole module exists to prevent. The fix asks git itself (not
  // .gitignore, which cannot answer this) whether the destination is currently tracked, and refuses
  // if so — checked generically against whatever git work tree (if any) the destination lives in, not
  // hardcoded to this package's own repo, so the guard can be exercised here against an isolated temp
  // repo rather than mutating this real repository's index.
  describe("the in-repo exception does not cover a path git already tracks (git add -f survives .gitignore)", () => {
    let repoDir: string;

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true });
    });

    function initTrackedFile(relativePath: string): { repoRoot: string; absolutePath: string } {
      repoDir = mkdtempSync(join(tmpdir(), "tn-git-track-"));
      execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
      const absolutePath = join(repoDir, relativePath);
      mkdirSync(resolve(absolutePath, ".."), { recursive: true });
      writeFileSync(absolutePath, "<html>already tracked</html>");
      // `-f` mirrors the exact failure mode: force-adding past whatever .gitignore says, which is
      // the only way a file under a gitignored directory ends up tracked in the first place.
      execFileSync("git", ["add", "-f", "--", absolutePath], { cwd: repoDir, stdio: "ignore" });
      return { repoRoot: repoDir, absolutePath };
    }

    it("refuses a destination git is currently tracking, even though it sits under the permitted directory", () => {
      const { repoRoot, absolutePath } = initTrackedFile(join("reports", "team-a", "index.html"));
      expect(() =>
        assertOutputPathSafe(absolutePath, join(repoRoot, "reports"), "reports"),
      ).toThrow(OutputPathError);
    });

    it("an untracked path in the very same directory still writes fine", () => {
      const { repoRoot, absolutePath } = initTrackedFile(join("reports", "team-a", "index.html"));
      const untracked = join(repoRoot, "reports", "team-a", "index.md");
      writeFileSync(untracked, "not tracked");
      expect(() =>
        assertOutputPathSafe(absolutePath, join(repoRoot, "reports"), "reports"),
      ).toThrow(OutputPathError);
      expect(() =>
        assertOutputPathSafe(untracked, join(repoRoot, "reports"), "reports"),
      ).not.toThrow();
    });

    // REGRESSION (self-review, PR #38 round 2). "untracked" is decided by matching git's OWN error
    // text, and that text is TRANSLATED when git is built with NLS and the environment asks for
    // another language: under a French locale the same failure reads "erreur : le spécificateur de
    // chemin '…' ne correspond à aucun fichier connu de git". An unmatched message resolves to
    // "indeterminate", and the caller fails CLOSED — so before the locale was pinned this refused
    // every capture and every dossier write on any machine not running in English, while every test
    // passed on one that is. Same shape as the PR #31 round-3 defect: a privacy control that
    // refuses everything is indistinguishable from one that works until someone runs it.
    //
    // LANGUAGE is set as well as LC_ALL because LANGUAGE overrides LC_ALL for message translation
    // specifically — pinning only LC_ALL would leave the hole open for anyone who sets it.
    it("still resolves 'untracked' when the ambient locale would translate git's error message", () => {
      const { repoRoot } = initTrackedFile(join("reports", "team-a", "index.html"));
      const untracked = join(repoRoot, "reports", "team-a", "index.md");
      const priorLcAll = process.env.LC_ALL;
      const priorLanguage = process.env.LANGUAGE;
      process.env.LC_ALL = "fr_FR.UTF-8";
      process.env.LANGUAGE = "fr";
      try {
        expect(() =>
          assertOutputPathSafe(untracked, join(repoRoot, "reports"), "reports"),
        ).not.toThrow();
      } finally {
        if (priorLcAll === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = priorLcAll;
        if (priorLanguage === undefined) delete process.env.LANGUAGE;
        else process.env.LANGUAGE = priorLanguage;
      }
    });

    it("a root outside any git repository at all still works — nothing is tracked because there is no git here", () => {
      const root = mkdtempSync(join(tmpdir(), "tn-no-git-"));
      try {
        const candidate = join(root, "team-x", "index.html");
        expect(() => assertOutputPathSafe(candidate, root, "reports")).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // REGRESSION (Codex adversarial review, PR #38 round 2, Finding 1 [critical]). The round-1 fix
    // above asked git whether the destination is tracked, but ran `git` with the destination's OWN
    // (about-to-be-created) directory as `cwd` — and a fresh write's parent directory is routinely
    // absent from disk (that is the entire point of a "first write" case, tested right above this
    // one). `execFileSync` throws ENOENT for a nonexistent `cwd`, and the old code's `catch` treated
    // ANY thrown error, including this one, as "untracked" — so the exact case this guard exists to
    // catch (a force-added tracked file) bypasses it completely the moment its directory is missing
    // from disk, which is the normal state for a build about to recreate it. Fail-open here is not
    // defensible: an invocation error is indistinguishable from exactly the state being guarded
    // against, so git must be invoked from a directory that is GUARANTEED to exist (the discovered
    // git work-tree root, not the destination's own directory) and any invocation problem must be
    // treated as indeterminate -> refuse, never as "untracked".
    it("REGRESSION (round 2): refuses a tracked file even though its parent directory no longer exists on disk", () => {
      const { repoRoot, absolutePath } = initTrackedFile(join("reports", "team-a", "index.html"));
      // The file AND its parent directory are both gone from disk, but the path is still tracked in
      // git's index — exactly the state a build script hits when it is about to recreate a
      // directory that was deleted (or never checked out) without `git rm`ing the tracked file first.
      rmSync(join(repoRoot, "reports", "team-a"), { recursive: true, force: true });
      expect(existsSync(dirname(absolutePath))).toBe(false);
      expect(() =>
        assertOutputPathSafe(absolutePath, join(repoRoot, "reports"), "reports"),
      ).toThrow(OutputPathError);
    });

    // Companion to the above: the fix must not turn EVERY missing-parent-directory write into a
    // refusal — only ones git actually confirms are tracked. An untracked destination whose parent
    // directory does not exist yet (the ordinary first-write case, just inside a real git repo this
    // time rather than the module's own PACKAGE_ROOT-anchored fixture above) must still succeed.
    it("a legitimate first-ever write into a not-yet-existing directory inside an untracked root still succeeds", () => {
      repoDir = mkdtempSync(join(tmpdir(), "tn-git-track-"));
      execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
      const root = join(repoDir, "reports");
      const candidate = join(root, "brand-new-team", "index.html");
      expect(existsSync(dirname(candidate))).toBe(false);
      expect(() => assertOutputPathSafe(candidate, root, "reports")).not.toThrow();
    });

    // REGRESSION (Codex adversarial review, PR #38 round 2, Finding 1 [critical]). A spawn failure
    // (git missing from PATH) is one of the "anything else" outcomes the reviewer named as
    // indeterminate: it must never be read as "untracked" for a path that IS inside a git work tree,
    // because that is indistinguishable from the exact case being guarded against.
    it("REGRESSION (round 2): refuses when git itself cannot be invoked, rather than treating the spawn failure as untracked", () => {
      repoDir = mkdtempSync(join(tmpdir(), "tn-git-track-"));
      execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
      const root = join(repoDir, "reports");
      mkdirSync(join(root, "team-b"), { recursive: true });
      const candidate = join(root, "team-b", "index.html");
      writeFileSync(candidate, "not tracked, but git can't be asked right now");

      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        expect(() => assertOutputPathSafe(candidate, root, "reports")).toThrow(OutputPathError);
      } finally {
        process.env.PATH = originalPath;
      }
    });

    // REGRESSION (Codex adversarial review, PR #38 round 2, Finding 1 [critical]). `isGitTracked`
    // has THREE outcomes, not two: exit 0 (tracked), exit 1 with git's own "did not match any file"
    // text (untracked), and everything else (indeterminate -> refuse). The two tests above cover a
    // spawn failure; this one exercises the THIRD shape distinctly — git successfully runs but exits
    // with a DIFFERENT nonzero status and a DIFFERENT stderr message than the documented "untracked"
    // one (here: a malformed `.git` file makes git itself fail with "fatal: invalid gitfile format",
    // exit 128) — so the final fallback branch is reached by an actual git invocation, not merely a
    // spawn error, and still refuses rather than silently reading "nonzero exit" as "untracked".
    it("REGRESSION (round 2): refuses when git runs but fails with neither a tracked exit nor its documented untracked message", () => {
      repoDir = mkdtempSync(join(tmpdir(), "tn-git-track-"));
      // A `.git` FILE (not a directory) makes `findGitWorkTreeRoot`'s plain existence check see a
      // work tree here, but its contents are not the `gitdir: <path>` pointer format a linked
      // worktree's `.git` file actually has — so git itself refuses to use it, distinctly from
      // "path not found in the index".
      writeFileSync(join(repoDir, ".git"), "not a real gitdir pointer\n");
      const root = join(repoDir, "reports");
      mkdirSync(join(root, "team-c"), { recursive: true });
      const candidate = join(root, "team-c", "index.html");
      writeFileSync(candidate, "not tracked, but git can't even start here");

      expect(() => assertOutputPathSafe(candidate, root, "reports")).toThrow(OutputPathError);
    });
  });

  // REGRESSION (Codex adversarial review, PR #38 round 3, Finding 1 [critical]). The round-2 fix
  // above asks git whether `resolvedPath` is tracked, but the child process it spawns inherits
  // `process.env` wholesale except for `LC_ALL`/`LANGUAGE` — so every `GIT_*` repository-selection
  // variable in the AMBIENT environment (`GIT_INDEX_FILE`, `GIT_DIR`, `GIT_WORK_TREE`,
  // `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_*`, …) rides
  // along and can silently redirect which repository/index git actually answers `ls-files` against —
  // a DIFFERENT one than the `cwd` the guard deliberately chose (`findGitWorkTreeRoot`'s discovered
  // work-tree root). The reviewer's exact reproducer: `GIT_INDEX_FILE` pointed at a nonexistent index
  // makes `git ls-files --error-unmatch` report a genuinely tracked absolute path as "did not match
  // any file(s) known to git" — the literal text `isGitTracked` reads as "untracked" — because git
  // consulted the bogus (empty) index instead of the repository's real one.
  describe("the child git environment must not inherit repository-selection variables (round 3, Finding 1 [critical])", () => {
    let repoDir: string;
    let bogusIndexDir: string;

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(bogusIndexDir, { recursive: true, force: true });
      delete process.env.GIT_INDEX_FILE;
    });

    it("REGRESSION: refuses a destination git already tracks even when GIT_INDEX_FILE points at a nonexistent index", () => {
      repoDir = mkdtempSync(join(tmpdir(), "tn-git-track-"));
      execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
      const absolutePath = join(repoDir, "reports", "team-a", "index.html");
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, "<html>already tracked</html>");
      execFileSync("git", ["add", "-f", "--", absolutePath], { cwd: repoDir, stdio: "ignore" });

      bogusIndexDir = mkdtempSync(join(tmpdir(), "tn-bogus-index-"));
      // The bogus index file is deliberately never created — git treats a missing GIT_INDEX_FILE as
      // an empty index, which is exactly the reviewer's reproducer: a genuinely tracked path answers
      // "did not match any file(s) known to git" against that empty index.
      process.env.GIT_INDEX_FILE = join(bogusIndexDir, "does-not-exist.index");

      expect(() =>
        assertOutputPathSafe(absolutePath, join(repoDir, "reports"), "reports"),
      ).toThrow(OutputPathError);
    });
  });

  // REGRESSION (Codex adversarial review, PR #38 round 3, Finding 4 [medium]). The round-2 locale
  // test (below, in this same file historically) set `LC_ALL`/`LANGUAGE` to French and asserted
  // ACCEPTANCE — but that passes on any machine without a French git message catalog installed, and
  // would keep passing even with the `LC_ALL: "C"` pin removed entirely, because git would then just
  // emit its (untranslated, English) message anyway on a machine that has no French catalog. That is
  // a false green in exactly the shape `rules/testing.md` warns against: the assertion never actually
  // observes the mechanism under test. This test instead spies on `spawnSync` itself and asserts on
  // the literal child environment `isGitTracked` constructs — the ONLY way to fail deterministically,
  // on any machine, if the pin (or the round-3 GIT_* stripping) is ever reverted.
  describe("the exact child environment isGitTracked constructs (round 3, Finding 4 [medium])", () => {
    let repoDir: string;

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it("REGRESSION: pins LC_ALL=C and LANGUAGE='', and strips every ambient GIT_* variable, from the spawned git's env", () => {
      repoDir = mkdtempSync(join(tmpdir(), "tn-git-track-"));
      execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
      const root = join(repoDir, "reports");
      mkdirSync(join(root, "team-a"), { recursive: true });
      const candidate = join(root, "team-a", "index.html");
      writeFileSync(candidate, "not tracked");

      const priorGitDir = process.env.GIT_DIR;
      const priorGitWorkTree = process.env.GIT_WORK_TREE;
      process.env.GIT_DIR = "/some/other/repo/.git";
      process.env.GIT_WORK_TREE = "/some/other/repo";

      const spawnSpy = vi.mocked(childProcess.spawnSync);
      spawnSpy.mockClear();
      try {
        // The candidate is genuinely untracked, so a CORRECT child env (ambient GIT_DIR/GIT_WORK_TREE
        // stripped, the real work-tree root used instead) must let this through without throwing. We
        // still capture and assert on the exact env below regardless of outcome, so this test's
        // primary failure mode when the fix is reverted is the ENV assertions, not this one — but a
        // fully-working fix must also not regress the ordinary "untracked" path into a refusal.
        let thrown: unknown;
        try {
          assertOutputPathSafe(candidate, root, "reports");
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeUndefined();

        expect(spawnSpy).toHaveBeenCalled();
        const call = spawnSpy.mock.calls.find(([cmd]) => cmd === "git");
        expect(call).toBeDefined();
        const options = call![2] as { env?: NodeJS.ProcessEnv };
        expect(options?.env?.LC_ALL).toBe("C");
        expect(options?.env?.LANGUAGE).toBe("");
        const gitVarKeys = Object.keys(options?.env ?? {}).filter((k) => k.startsWith("GIT_"));
        expect(gitVarKeys).toEqual([]);
      } finally {
        if (priorGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = priorGitDir;
        if (priorGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = priorGitWorkTree;
      }
    });
  });
});

// REGRESSION (Codex adversarial review, PR #38 round 3, Finding 2 [high]). The previous
// `overwriteOutputFile` unlinked whatever already existed at `path` and only THEN created the
// replacement (`writeFileSync(path, content, { flag: "wx" })`) — so a failure in that window (disk
// full, a permission change mid-batch, anything that makes the create fail) deleted a previously
// GOOD dossier and put nothing back in its place. `writeSectionalsDossiers`'s own doc comment
// promised "a refusal leaves nothing on disk", which was true for a VALIDATION refusal (everything
// above is checked before any byte is written) but was never true for a failure DURING the write
// step itself — this describe block is about that second, narrower, but still real window.
describe("overwriteOutputFile never has a window where the destination is missing (round 3, Finding 2 [high])", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.mocked(fsModule.writeFileSync).mockClear();
    vi.mocked(fsModule.renameSync).mockClear();
    vi.mocked(fsModule.lstatSync).mockClear();
  });

  it("REGRESSION: a failure while writing the replacement content must not delete the existing good file", () => {
    dir = mkdtempSync(join(tmpdir(), "tn-atomic-write-"));
    const path = join(dir, "index.html");
    writeFileSync(path, "GOOD EXISTING CONTENT", "utf8");

    // Simulate the exact failure class the finding names — disk full, permissions changed mid-batch
    // — by making the NEXT write throw, whatever path it targets.
    vi.mocked(fsModule.writeFileSync).mockImplementationOnce(() => {
      throw new Error("simulated write failure (disk full)");
    });

    expect(() => overwriteOutputFile(path, "NEW CONTENT")).toThrow();
    // The old implementation unlinked `path` BEFORE attempting this write, so this assertion is
    // exactly what distinguishes "destructive window closed" from "destructive window still open".
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("GOOD EXISTING CONTENT");
  });

  it("REGRESSION: a failure while writing the replacement content must not leave a stray temp file behind", () => {
    dir = mkdtempSync(join(tmpdir(), "tn-atomic-write-"));
    const path = join(dir, "index.html");
    writeFileSync(path, "GOOD EXISTING CONTENT", "utf8");

    vi.mocked(fsModule.writeFileSync).mockImplementationOnce(() => {
      throw new Error("simulated write failure (disk full)");
    });

    expect(() => overwriteOutputFile(path, "NEW CONTENT")).toThrow();
    // Nothing else should be sitting in the directory afterward — no half-named temp file cruft.
    expect(readdirSync(dir)).toEqual([basename(path)]);
  });

  // REGRESSION (Codex adversarial review, PR #38 round 4). The test above throws BEFORE the temp
  // file is ever created, so it passes whether or not the cleanup path covers a write that FAILS
  // PARTWAY. `writeFileSync` is not all-or-nothing: ENOSPC/EIO/a quota can leave a truncated temp
  // behind. This simulates exactly that — create the file, then throw — which is unreachable by the
  // throw-immediately mock, and is red when the write sits outside the cleanup-protected block.
  it("REGRESSION: a write that CREATES the temp file and then fails must still clean it up", () => {
    dir = mkdtempSync(join(tmpdir(), "tn-atomic-write-"));
    const path = join(dir, "index.html");
    writeFileSync(path, "GOOD EXISTING CONTENT", "utf8");

    vi.mocked(fsModule.writeFileSync).mockImplementationOnce(((target: string) => {
      // Land a real, partially-written file at the temp path first — the state a torn write leaves
      // behind. `openSync`/`writeSync`/`closeSync` are not mocked in this file, so this creates the
      // debris for real rather than simulating its existence.
      const fd = fsModule.openSync(target, "wx");
      fsModule.writeSync(fd, "PARTIAL");
      fsModule.closeSync(fd);
      throw new Error("simulated torn write (ENOSPC after create)");
    }) as unknown as typeof fsModule.writeFileSync);

    expect(() => overwriteOutputFile(path, "NEW CONTENT")).toThrow();
    expect(readdirSync(dir)).toEqual([basename(path)]);
    expect(readFileSync(path, "utf8")).toBe("GOOD EXISTING CONTENT");
  });

  it("REGRESSION: a failure during the final atomic rename must also leave the existing good file untouched, with no temp cruft", () => {
    dir = mkdtempSync(join(tmpdir(), "tn-atomic-write-"));
    const path = join(dir, "index.html");
    writeFileSync(path, "GOOD EXISTING CONTENT", "utf8");

    // This time the CONTENT write succeeds (to a temp file); only the final rename-into-place fails
    // — a distinct failure point from the test above, and the one an atomic-rename implementation
    // introduces that a naive unlink-then-create implementation never had to handle.
    vi.mocked(fsModule.renameSync).mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });

    expect(() => overwriteOutputFile(path, "NEW CONTENT")).toThrow();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("GOOD EXISTING CONTENT");
    expect(readdirSync(dir)).toEqual([basename(path)]);
  });

  it("a normal (non-failing) call still replaces the destination's content, atomicity aside", () => {
    dir = mkdtempSync(join(tmpdir(), "tn-atomic-write-"));
    const path = join(dir, "index.html");
    writeFileSync(path, "OLD CONTENT", "utf8");

    expect(() => overwriteOutputFile(path, "REPLACED CONTENT")).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe("REPLACED CONTENT");
    expect(readdirSync(dir)).toEqual([basename(path)]);
  });

  // REGRESSION (Codex adversarial review, PR #38 round 3, Finding 2 [high]). The fix's own
  // instructions call for a SECOND no-follow check "close to the rename" — not just the one at the
  // very top of the function — because writing the temp file's full content is not instantaneous, so
  // a symlink could in principle be planted at `path` in that window. Without a dedicated test that
  // forces exactly that window to matter, this second check is a branch no test can kill (see
  // `rules/testing.md`'s anti-pattern of the same name): every other test's symlink is already in
  // place before `overwriteOutputFile` is ever called, so it is caught by the FIRST check and never
  // exercises the second one at all. This test uses `lstatSync`'s own mock (default: real
  // pass-through) to answer the SECOND call for `path` with "this is a symlink" — simulating a
  // symlink that appeared in the window between the first check and the rename — and asserts the
  // rename is refused rather than blindly executed over it.
  it("REGRESSION: the SECOND no-follow check (immediately before the rename) actually refuses when it fires — not dead code", async () => {
    dir = mkdtempSync(join(tmpdir(), "tn-atomic-write-"));
    const path = join(dir, "index.html");
    writeFileSync(path, "GOOD EXISTING CONTENT", "utf8");
    const escapeTarget = mkdtempSync(join(tmpdir(), "tn-escape-"));
    const linkTarget = join(escapeTarget, "leaked.html");

    const { lstatSync: realLstatSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    let callsForPath = 0;
    vi.mocked(fsModule.lstatSync).mockImplementation((target, opts) => {
      if (target === path) {
        callsForPath += 1;
        // First call (the check at the very top of `overwriteOutputFile`, before the temp file is
        // even written) must see the real, plain file — otherwise the function would refuse before
        // ever reaching the temp-write/rename path this test means to exercise.
        if (callsForPath === 1) return realLstatSync(target, opts as never);
        // Second call (immediately before the rename): report a symlink now sits at `path`, as if
        // one had been planted in the window since the first check.
        return { isSymbolicLink: () => true } as ReturnType<typeof realLstatSync>;
      }
      return realLstatSync(target, opts as never);
    });

    try {
      expect(() => overwriteOutputFile(path, "NEW CONTENT")).toThrow(OutputPathError);
      // The rename must never have been attempted at all, and the original content must survive.
      expect(vi.mocked(fsModule.renameSync)).not.toHaveBeenCalled();
      expect(readFileSync(path, "utf8")).toBe("GOOD EXISTING CONTENT");
      expect(existsSync(linkTarget)).toBe(false);
      // No stray temp file left behind by the aborted attempt either.
      expect(readdirSync(dir)).toEqual([basename(path)]);
    } finally {
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });

  // REGRESSION (#33). The rename-time directory re-verification added beside the second
  // `assertLeafWritable` above: `renameSync` is a path operation with no `renameat`, so — exactly
  // like `writeFileSync` before it — it re-resolves `dir` from a bare string rather than trusting
  // anything already proven. Without a dedicated test forcing this window to matter, the check is a
  // branch no test can kill (every OTHER test's directory is untouched throughout the call), same
  // shape as the "SECOND no-follow check" regression directly above. This test swaps `dir` itself for
  // a symlink to somewhere else in the window between the temp-file write and the rename, and asserts
  // the rename is refused rather than carried out through a directory that is no longer the one this
  // call started in.
  it("REGRESSION: the rename-time directory re-verification refuses when the directory is swapped for a symlink during the write — not dead code", async () => {
    dir = mkdtempSync(join(tmpdir(), "tn-atomic-write-"));
    const path = join(dir, "index.html");
    const escapeTarget = mkdtempSync(join(tmpdir(), "tn-escape-dir-"));

    const { writeFileSync: realWriteFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fsModule.writeFileSync).mockImplementationOnce(((target: string, content: string, opts: unknown) => {
      const result = realWriteFileSync(target, content, opts as never);
      // The temp file's content write is not instantaneous, and `renameSync` re-resolves `dir` from
      // scratch just like `writeFileSync` did — so replacing `dir` with a symlink RIGHT NOW, after
      // the write and before the rename, reproduces the exact window the new check exists to close.
      rmSync(dir, { recursive: true, force: true });
      symlinkSync(escapeTarget, dir, "dir");
      return result;
    }) as unknown as typeof fsModule.writeFileSync);

    try {
      expect(() => overwriteOutputFile(path, "NEW CONTENT")).toThrow(OutputPathError);
      expect(vi.mocked(fsModule.renameSync)).not.toHaveBeenCalled();
      // Nothing must have landed where the symlink pointed.
      expect(readdirSync(escapeTarget)).toEqual([]);
    } finally {
      // `dir` is now a symlink; remove the link itself rather than recursing through its target.
      rmSync(dir, { force: true });
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
});

// REGRESSION (#33). `openNewOutputFileSafely`/`writeNewOutputFile` are the fd-anchored write
// primitives `src/ingest/archive.ts` now routes through: open the real, validated destination FIRST,
// then trust it only once TWO independent post-open checks both agree it is safe — see
// `openNewOutputFileSafely`'s own doc comment in `src/fs/output-root.ts` for why neither check alone
// is sufficient. Each branch below is killed by its OWN test, not asserted to cover several, per
// `rules/testing.md`.
describe("openNewOutputFileSafely / writeNewOutputFile (#33 fd-anchored write)", () => {
  afterEach(() => {
    vi.mocked(fsModule.openSync).mockClear();
    vi.mocked(fsModule.writeSync).mockClear();
    vi.mocked(fsModule.closeSync).mockClear();
    vi.mocked(fsModule.unlinkSync).mockClear();
  });

  // Isolates the COMPONENT-WALK check from the root-containment check (`isWithin(realRootNow,
  // realDirNow)`): the symlink planted after the open points to a DECOY directory INSIDE the same
  // root, not outside it. `isWithin` alone would happily accept that — the real resolved directory
  // genuinely sits under the real root — so this scenario can only be refused by the component walk
  // itself noticing that a SYMLINK sits where a plain directory should be, regardless of where it
  // points. A test whose symlink points outside the root would still pass if this check were deleted
  // entirely, since the root-containment check would catch it too; this is the one that proves the
  // component walk is doing independent work, not merely reproducing the other check.
  it("REGRESSION: refuses when a directory component is swapped for a symlink between the open and the post-open verification, even when the symlink points INSIDE the root", async () => {
    const root = mkdtempSync(join(tmpdir(), "tn-fd-root-"));
    try {
      const subDir = join(root, "team-x");
      mkdirSync(subDir, { recursive: true });
      const candidate = join(subDir, "index.html");
      const decoyDir = join(root, "decoy");
      mkdirSync(decoyDir, { recursive: true });

      const { openSync: realOpenSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(fsModule.openSync).mockImplementationOnce(((target: string, flags: string) => {
        const fd = realOpenSync(target, flags);
        // Swap AFTER the open has already succeeded, BEFORE `openNewOutputFileSafely`'s own
        // post-open verification gets to run — reproducing "the component walk alone is
        // check-then-use" for the open step specifically. The symlink's target (`decoyDir`) is
        // deliberately INSIDE `root`, so only the component walk — not the root-containment check —
        // can catch this.
        const swappedDir = dirname(target);
        rmSync(swappedDir, { recursive: true, force: true });
        symlinkSync(decoyDir, swappedDir, "dir");
        return fd;
      }) as unknown as typeof fsModule.openSync);

      expect(() => openNewOutputFileSafely(root, candidate, "reports")).toThrow(OutputPathError);
      // Nothing the (now-cleaned-up) open created may have leaked into the decoy directory either.
      expect(readdirSync(decoyDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Isolates the ROOT-CONTAINMENT check (`isWithin(realRootNow, realDirNow)`) from BOTH checks
  // above: `root` itself is a symlink (legitimate — a root pointing at an external disk is allowed
  // by this module by design) that gets REPOINTED, after the open, to a sibling directory. Nothing
  // under the ORIGINAL root is touched or deleted, so no directory component the walk visits is
  // itself a symlink and nothing is missing on disk — `assertNoSymlinkComponents` has nothing to
  // catch here. Only re-resolving the root fresh and confirming the (unmoved, still-real) directory
  // is still nested inside it catches this: the file the fd was opened against now sits OUTSIDE the
  // root the symlink currently names.
  it("REGRESSION: refuses when the root symlink itself is repointed to a sibling directory after the open, leaving every component clean", async () => {
    const linkParent = mkdtempSync(join(tmpdir(), "tn-fd-link-parent-"));
    const root1 = mkdtempSync(join(tmpdir(), "tn-fd-root1-"));
    const root2 = mkdtempSync(join(tmpdir(), "tn-fd-root2-"));
    const rootLink = join(linkParent, "root-link");
    symlinkSync(root1, rootLink, "dir");
    try {
      const subDir = join(rootLink, "team-w");
      mkdirSync(subDir, { recursive: true });
      const candidate = join(subDir, "index.html");

      const { openSync: realOpenSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(fsModule.openSync).mockImplementationOnce(((target: string, flags: string) => {
        const fd = realOpenSync(target, flags);
        // Repoint the ROOT symlink itself to `root2` — `root1` and everything under it, including
        // the file the fd was just opened against, is left completely untouched.
        unlinkSync(rootLink);
        symlinkSync(root2, rootLink, "dir");
        return fd;
      }) as unknown as typeof fsModule.openSync);

      expect(() => openNewOutputFileSafely(rootLink, candidate, "reports")).toThrow(OutputPathError);
      // Nothing may have leaked into root2, the root the symlink was repointed to.
      expect(readdirSync(root2)).toEqual([]);
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(root1, { recursive: true, force: true });
      rmSync(root2, { recursive: true, force: true });
    }
  });

  // Isolates the INODE comparison from the component walk: every directory component stays a real,
  // untouched directory for the whole test — only the LEAF is swapped, for a DIFFERENT file at the
  // exact same path — so this test can only pass if the fstat/lstat comparison itself does the work.
  // This is what proves the inode check is not redundant with the component walk (plan requirement).
  it("REGRESSION: refuses independently when the fd's inode no longer matches the path, with every directory component clean the whole time", async () => {
    const root = mkdtempSync(join(tmpdir(), "tn-fd-root-"));
    try {
      const subDir = join(root, "team-y");
      mkdirSync(subDir, { recursive: true });
      const candidate = join(subDir, "index.html");

      const { openSync: realOpenSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(fsModule.openSync).mockImplementationOnce(((target: string, flags: string) => {
        const fd = realOpenSync(target, flags);
        // Unlink what the fd points to and put a DIFFERENT file at the exact same path. No directory
        // component is ever touched — only the leaf's identity changes underneath the open fd.
        unlinkSync(target);
        writeFileSync(target, "a different file entirely", "utf8");
        return fd;
      }) as unknown as typeof fsModule.openSync);

      expect(() => openNewOutputFileSafely(root, candidate, "reports")).toThrow(OutputPathError);
      // The swapped-in file must be gone too — best-effort cleanup removes whatever now sits at the
      // leaf, not just the (already-unlinked) file the fd was originally opened against.
      expect(existsSync(candidate)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A refusal must leave nothing behind at all: not a partial file, not orphaned temp debris. This
  // exercises `writeNewOutputFile`'s OWN cleanup — distinct from `openNewOutputFileSafely`'s
  // verification-failure cleanup above — for a failure that happens AFTER a successful, verified
  // open, during the write itself.
  it("REGRESSION: a write that fails after a successful, verified open leaves no partial file or debris behind", () => {
    const root = mkdtempSync(join(tmpdir(), "tn-fd-root-"));
    try {
      const subDir = join(root, "team-z");
      mkdirSync(subDir, { recursive: true });
      const candidate = join(subDir, "index.html");

      vi.mocked(fsModule.writeSync).mockImplementationOnce(() => {
        throw new Error("simulated write failure (disk full)");
      });

      expect(() => writeNewOutputFile(root, candidate, "reports", "content that must not survive")).toThrow(
        "simulated write failure (disk full)",
      );
      expect(existsSync(candidate)).toBe(false);
      expect(readdirSync(subDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a normal call opens, verifies, writes, and returns the real path written", () => {
    const root = mkdtempSync(join(tmpdir(), "tn-fd-root-"));
    try {
      const subDir = join(root, "team-normal");
      mkdirSync(subDir, { recursive: true });
      const candidate = join(subDir, "index.html");

      const realPath = writeNewOutputFile(root, candidate, "reports", "hello");

      expect(readFileSync(realPath, "utf8")).toBe("hello");
      expect(existsSync(candidate)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Both doc comments above (`openNewOutputFileSafely`, `writeNewOutputFile`) promise that a cleanup
  // failure never masks the ORIGINAL error — mirroring `overwriteOutputFile`'s established shape.
  // That promise is untested unless something forces the cleanup itself to fail; these two tests do,
  // for both `openNewOutputFileSafely`'s own verification-failure cleanup and `writeNewOutputFile`'s
  // separate write-failure cleanup.
  it("REGRESSION: openNewOutputFileSafely surfaces the ORIGINAL verification error even when its own cleanup (close AND unlink) also fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "tn-fd-root-"));
    const decoyDir = mkdtempSync(join(tmpdir(), "tn-fd-decoy-"));
    try {
      const subDir = join(root, "team-cleanup");
      mkdirSync(subDir, { recursive: true });
      const candidate = join(subDir, "index.html");

      const { openSync: realOpenSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(fsModule.openSync).mockImplementationOnce(((target: string, flags: string) => {
        const fd = realOpenSync(target, flags);
        const swappedDir = dirname(target);
        rmSync(swappedDir, { recursive: true, force: true });
        symlinkSync(decoyDir, swappedDir, "dir");
        return fd;
      }) as unknown as typeof fsModule.openSync);
      vi.mocked(fsModule.closeSync).mockImplementationOnce(() => {
        throw new Error("simulated EBADF (cleanup close failure)");
      });
      vi.mocked(fsModule.unlinkSync).mockImplementationOnce(() => {
        throw new Error("simulated cleanup unlink failure");
      });

      let thrown: unknown;
      try {
        openNewOutputFileSafely(root, candidate, "reports");
      } catch (err) {
        thrown = err;
      }
      // The ORIGINAL verification error (component-swap refusal) must be what surfaces — neither
      // cleanup failure above may mask it.
      expect(thrown).toBeInstanceOf(OutputPathError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  it("REGRESSION: writeNewOutputFile surfaces the ORIGINAL write error even when its own cleanup (close AND unlink) also fails", () => {
    const root = mkdtempSync(join(tmpdir(), "tn-fd-root-"));
    try {
      const subDir = join(root, "team-cleanup2");
      mkdirSync(subDir, { recursive: true });
      const candidate = join(subDir, "index.html");

      vi.mocked(fsModule.writeSync).mockImplementationOnce(() => {
        throw new Error("simulated write failure (disk full)");
      });
      vi.mocked(fsModule.closeSync).mockImplementationOnce(() => {
        throw new Error("simulated EBADF (cleanup close failure)");
      });
      vi.mocked(fsModule.unlinkSync).mockImplementationOnce(() => {
        throw new Error("simulated cleanup unlink failure");
      });

      expect(() => writeNewOutputFile(root, candidate, "reports", "content")).toThrow(
        "simulated write failure (disk full)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `fs.writeSync` issues ONE `write(2)` and returns how many bytes it actually wrote — it does not
  // retry the remainder the way `writeFileSync` does internally. A SHORT write is rare for a regular
  // file but permitted, and a single unchecked `writeSync` would swallow one silently: the file would
  // be truncated while the open, both post-open verifications, and the close all still reported
  // success — a corrupted privacy artifact indistinguishable from a good one. This test forces the
  // short write so the retry loop is a branch a test can actually kill, rather than one asserted to
  // be correct by reading it (`rules/testing.md` → never keep a branch no test can kill).
  it("REGRESSION: a SHORT write is retried to completion rather than silently truncating the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "tn-fd-root-"));
    const { writeSync: realWriteSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    try {
      const subDir = join(root, "team-short-write");
      mkdirSync(subDir, { recursive: true });
      const candidate = join(subDir, "index.html");
      const content = "SENSITIVE CAPTURE BODY THAT MUST NOT BE TRUNCATED";

      // Exactly one short write: the first call commits 5 bytes and reports 5, so the loop must come
      // back for the remaining bytes. Without the loop the file ends up 5 bytes long.
      vi.mocked(fsModule.writeSync).mockImplementationOnce(((fd: number, buffer: Buffer) =>
        realWriteSync(fd, buffer, 0, 5)) as unknown as typeof fsModule.writeSync);

      writeNewOutputFile(root, candidate, "reports", content);

      expect(readFileSync(candidate, "utf8")).toBe(content);
      expect(vi.mocked(fsModule.writeSync).mock.calls.length).toBeGreaterThan(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
