import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #173. A test cleaned up more than it created — `rmSync(resolve("raw"), { recursive: true })` to
// dispose of two files — and running the declared quality gate in a used checkout therefore deleted
// the operator's whole `raw/` archive, and `reports/` alongside it. Both are gitignored, so git
// could not restore them and nothing warned. CI never noticed: a fresh clone's copies are empty.
//
// This guard exists so the class cannot come back, and it is DERIVED rather than enumerated. The
// protected names are read from `.gitignore` itself — the repository's own declaration of which
// directories hold operator data rather than source — so a directory added there is covered on the
// next run without anyone remembering to extend a list here.
//
// What it flags is narrower than "names a protected directory", and the narrowing is the whole
// design. The hazard is a removal ANCHORED AT THE PACKAGE ROOT: `resolve("raw")` is the operator's
// real archive, while `join(repoDir, "reports")` over a `mkdtemp` repo is a correct teardown this
// suite performs deliberately. The first draft of this guard tested for the name anywhere in the
// call and reported both, plus a comment quoting the old code — three false positives, which is how
// a guard trains its readers to ignore it.

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

/**
 * The gitignored directory names, read from `.gitignore`. Only plain directory entries qualify: a
 * line ending in `/` with no glob character. A pattern is skipped rather than approximated — this
 * guard reports what it can prove — and the parse is asserted non-empty below so a silently empty
 * result fails instead of passing vacuously.
 */
export function protectedDirectories(gitignore: string): string[] {
  return gitignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
    .filter((line) => line.endsWith("/") && !/[*?![\]]/.test(line))
    .map((line) => line.replace(/\/+$/, ""))
    .filter((name) => name !== "");
}

/**
 * `source` with line and block comments removed.
 *
 * Required, not cosmetic: this file and `test/ingest-archive.test.ts` both QUOTE the destructive
 * teardown in prose so the next reader knows what shipped, and a scanner that reads comments
 * reports those quotations as live code. String literals are left intact — the planted-defect cases
 * below are strings, and they must still be reachable by the scanner that they exist to exercise.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The first argument of every `rmSync(` call in `source` — the removal target, without the options
 * object.
 *
 * Scans with a paren/brace depth counter rather than a regex. An argument list routinely nests
 * (`rmSync(join(a, b), { recursive: true })`) and a non-greedy `\(.*?\)` stops at the first inner
 * `)`, reporting a truncated target that no longer contains the path. `docs/findings.md` records
 * what regex-parsing a nested grammar has already cost this repository.
 */
export function removalTargets(source: string): string[] {
  const targets: string[] = [];
  const needle = "rmSync(";
  let index = source.indexOf(needle);

  while (index !== -1) {
    const open = index + needle.length - 1;
    let depth = 0;
    let firstComma = -1;
    let cursor = open;

    for (; cursor < source.length; cursor++) {
      const ch = source[cursor];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      } else if (ch === "," && depth === 1 && firstComma === -1) firstComma = cursor;
    }

    const end = firstComma === -1 ? cursor : firstComma;
    targets.push(source.slice(open + 1, end).trim());
    index = source.indexOf(needle, cursor);
  }

  return targets;
}

/**
 * The protected directories a removal target names **anchored at the package root** — the only
 * shape that reaches the operator's real data.
 *
 * Two anchors qualify: `resolve("<name>")`, which is package-root-relative because the suite's cwd
 * is the package root, and a bare `"<name>"` target for the same reason. A target rooted at a
 * variable (`join(repoDir, "reports")`) does not qualify: its base is whatever that variable holds,
 * which throughout this suite is a `mkdtemp` directory.
 *
 * Names are compared by exact equality, never containment — `"tn-reports-cmd-"` is a `mkdtemp`
 * prefix, not the `reports/` directory, and a containment test would flag every correct temp
 * teardown in the repository.
 */
export function packageRootAnchoredNames(target: string, protectedNames: string[]): string[] {
  const anchored = new Set<string>();

  for (const match of target.matchAll(/\bresolve\(\s*(["'`])([^"'`]+)\1\s*\)/g)) {
    const name = match[2];
    if (name !== undefined) anchored.add(name);
  }

  const bare = /^(["'`])([^"'`]+)\1$/.exec(target);
  const bareName = bare?.[2];
  if (bareName !== undefined) anchored.add(bareName);

  return protectedNames.filter((name) => anchored.has(name));
}

function testSources(): { file: string; source: string }[] {
  const dir = join(PACKAGE_ROOT, "test");
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => ({ file: join("test", entry), source: readFileSync(join(dir, entry), "utf8") }));
}

describe("no test removes a directory the repository declares as operator data (#173)", () => {
  const protectedNames = protectedDirectories(readFileSync(join(PACKAGE_ROOT, ".gitignore"), "utf8"));

  it("reads the protected set from .gitignore, and that set is not empty", () => {
    expect(protectedNames.length).toBeGreaterThan(0);
    expect(protectedNames).toContain("raw");
    expect(protectedNames).toContain("reports");
  });

  it("finds removal calls to inspect, so the sweep below is not passing vacuously", () => {
    const total = testSources().reduce((sum, { source }) => sum + removalTargets(stripComments(source)).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("PLANTED DEFECT: the exact teardown that destroyed raw/ is reported", () => {
    // The scanner is shown the defect it exists to catch, in the shape it actually shipped in.
    // A guard that has only ever seen clean input is an assertion, not a check.
    const planted = 'afterEach(() => {\n  rmSync(resolve("raw"), { recursive: true, force: true });\n});';
    const targets = removalTargets(stripComments(planted));

    expect(targets).toEqual(['resolve("raw")']);
    expect(packageRootAnchoredNames(targets[0] ?? "", protectedNames)).toEqual(["raw"]);
  });

  it("PLANTED DEFECT: a nested target is read whole, not truncated at the first paren", () => {
    const planted = 'rmSync(join(resolve("reports"), "team-x"), { recursive: true, force: true });';
    const targets = removalTargets(stripComments(planted));

    expect(targets).toEqual(['join(resolve("reports"), "team-x")']);
    expect(packageRootAnchoredNames(targets[0] ?? "", protectedNames)).toEqual(["reports"]);
  });

  it("PLANTED DEFECT: a bare relative target is reported too", () => {
    const targets = removalTargets(stripComments('rmSync("reports", { recursive: true });'));
    expect(targets).toEqual(['"reports"']);
    expect(packageRootAnchoredNames(targets[0] ?? "", protectedNames)).toEqual(["reports"]);
  });

  it("does not flag a temp-directory teardown that merely mentions a protected name", () => {
    // Both shapes below are correct and deliberate in this suite, and both were false positives of
    // this guard's first draft.
    expect(packageRootAnchoredNames("reportsDir", protectedNames)).toEqual([]);
    expect(packageRootAnchoredNames('join(repoRoot, "reports", "team-a")', protectedNames)).toEqual([]);
    expect(packageRootAnchoredNames('"tn-reports-cmd-"', protectedNames)).toEqual([]);
  });

  it("does not read a commented-out teardown as live code", () => {
    const quoted = '// the old cleanup was rmSync(resolve("raw"), { recursive: true, force: true })\nconst x = 1;';
    expect(removalTargets(stripComments(quoted))).toEqual([]);
  });

  it("no test file in the suite removes a package-root-anchored protected directory", () => {
    const offenders: string[] = [];

    for (const { file, source } of testSources()) {
      if (file.endsWith("no-test-deletes-operator-data.test.ts")) continue; // holds the planted defects above
      for (const target of removalTargets(stripComments(source))) {
        for (const name of packageRootAnchoredNames(target, protectedNames)) {
          offenders.push(`${file}: rmSync(${target}) removes the gitignored "${name}/"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
