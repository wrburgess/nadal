import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertOutputPathSafe, OutputPathError } from "../src/fs/output-root.js";

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

    it("a root outside any git repository at all still works — nothing is tracked because there is no git here", () => {
      const root = mkdtempSync(join(tmpdir(), "tn-no-git-"));
      try {
        const candidate = join(root, "team-x", "index.html");
        expect(() => assertOutputPathSafe(candidate, root, "reports")).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
