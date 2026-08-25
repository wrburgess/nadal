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
 * Every `rmSync(` offset in `source`, tagged with whether its own line reads as a comment.
 *
 * A SECOND, structurally different derivation of "is this occurrence commented out" — it looks at
 * the shape of the line (`//` or `*` after trimming) and never at the stripping regexes above. That
 * independence is the point: `stripComments` cannot lex JavaScript, so a `//` or a `/*` inside a
 * string literal would make it swallow live code, and a check built from the same regex could not
 * see that happen. The suite-wide test below asserts the two agree, so the day a fixture string
 * eats a real removal call, this file goes red instead of going quiet.
 */
export function removalLines(source: string): { offset: number; commentedByShape: boolean }[] {
  const lines = source.split("\n");
  const found: { offset: number; commentedByShape: boolean }[] = [];
  for (const match of source.matchAll(/rmSync\(/g)) {
    const offset = match.index;
    const lineNo = source.slice(0, offset).split("\n").length - 1;
    const trimmed = (lines[lineNo] ?? "").trim();
    // LINE SHAPE ONLY — deliberately NOT "is there a // earlier on this line", which is the exact
    // test `stripComments` performs. An earlier draft included that clause and the two derivations
    // then shared one blind spot: for `const p = "a//b"; rmSync(...)` both call it a comment, so
    // they agree precisely in the case the agreement test exists to catch. Two paths that share a
    // wrong assumption return the same wrong answer, which is why `verify.py`'s check 0 tests the
    // convention against `winner_side` rather than against a second reading of the score.
    found.push({ offset, commentedByShape: trimmed.startsWith("//") || trimmed.startsWith("*") });
  }
  return found;
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
 * The first argument of a `resolve(...)`/`join(...)` argument list, split at the top level so a
 * nested call arrives whole rather than truncated at its first comma.
 */
function firstArgument(argumentList: string): string {
  let depth = 0;
  for (let i = 0; i < argumentList.length; i++) {
    const ch = argumentList[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) return argumentList.slice(0, i).trim();
  }
  return argumentList.trim();
}

/** Base expressions that resolve to this checkout. */
const PACKAGE_ROOT_ANCHORS = ["process.cwd()", "import.meta.dirname", "__dirname", "PACKAGE_ROOT"];

/**
 * Whether a removal target is rooted at this checkout — the property that decides whether it can
 * reach operator data, replacing the first draft's list of accepted spellings.
 *
 * Contractor review, PR #174, guard-completeness lens [must-fix]: matching only `resolve("raw")`
 * and a bare `"raw"` was fail-open, because `resolve(".", "raw")` and `join(process.cwd(), "raw")`
 * delete the same data and both passed. What actually separates a dangerous removal from a safe one
 * is the SHAPE OF ITS BASE — a cwd/package-root anchor reaches operator data, a variable holding a
 * `mkdtemp` path does not — so that is what is tested now.
 *
 * Anchored: a bare string literal (cwd-relative); `resolve(…)`/`join(…)` whose first argument is a
 * string literal or a package-root expression; or either wrapping a nested call that is anchored.
 * Not anchored: a bare identifier, or a call rooted at one (`join(repoDir, "reports")`).
 */
export function anchoredAtPackageRoot(target: string): boolean {
  const trimmed = target.trim();
  const isStringLiteral = (text: string) => /^(["'`])[^"'`]*\1$/.test(text);

  const call = /^(?:resolve|join)\(([\s\S]*)\)$/.exec(trimmed);
  if (call === null) return isStringLiteral(trimmed);

  const base = firstArgument(call[1] ?? "");
  if (isStringLiteral(base)) return true;
  if (PACKAGE_ROOT_ANCHORS.includes(base)) return true;
  if (/^(?:resolve|join)\(/.test(base)) return anchoredAtPackageRoot(base);
  return false;
}

/**
 * The protected directories a removal target names AND is anchored at the package root by.
 *
 * Names are compared by exact equality, never containment — `"tn-reports-cmd-"` is a `mkdtemp`
 * prefix, not the `reports/` directory, and a containment test would flag every correct temp
 * teardown in the repository.
 */
export function packageRootAnchoredNames(target: string, protectedNames: string[]): string[] {
  const literals = new Set<string>();
  for (const match of target.matchAll(/["'`]([^"'`]*)["'`]/g)) {
    const value = match[1];
    if (value !== undefined) literals.add(value);
  }

  const named = protectedNames.filter((name) => literals.has(name));
  if (named.length === 0) return [];
  return anchoredAtPackageRoot(target) ? named : [];
}

function testSources(): { file: string; source: string }[] {
  // BOTH runners the gate declares: `test/**` under vitest (`npm test`) and `tools/**` under
  // `node:test` (`npm run test:tools`). Contractor review, PR #174, claim-vs-code lens [must-fix]:
  // the first draft scanned only `test/**` while its title claimed "no test file in the suite",
  // leaving a destructive teardown under `tools/` unguarded and the claim overstated.
  const sources: { file: string; source: string }[] = [];
  for (const root of ["test", "tools"]) {
    const dir = join(PACKAGE_ROOT, root);
    for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!entry.endsWith(".test.ts")) continue;
      sources.push({ file: join(root, entry), source: readFileSync(join(dir, entry), "utf8") });
    }
  }
  return sources;
}

const SELF = "no-test-deletes-operator-data.test.ts";

describe("no test removes a directory the repository declares as operator data (#173)", () => {
  const protectedNames = protectedDirectories(readFileSync(join(PACKAGE_ROOT, ".gitignore"), "utf8"));

  it("reads the protected set from .gitignore, and that set is not empty", () => {
    expect(protectedNames.length).toBeGreaterThan(0);
    expect(protectedNames).toContain("raw");
    expect(protectedNames).toContain("reports");
  });

  it("scans both gate runners' test files, and finds removal calls in each", () => {
    const files = testSources();
    expect(files.some((f) => f.file.startsWith("test/"))).toBe(true);
    expect(files.some((f) => f.file.startsWith("tools/"))).toBe(true);
    expect(files.reduce((sum, { source }) => sum + removalTargets(stripComments(source)).length, 0)).toBeGreaterThan(0);
  });

  it("PLANTED DEFECT: the exact teardown that destroyed raw/ is reported", () => {
    // The scanner is shown the defect it exists to catch, in the shape it actually shipped in.
    // A guard that has only ever seen clean input is an assertion, not a check.
    const planted = 'afterEach(() => {\n  rmSync(resolve("raw"), { recursive: true, force: true });\n});';
    const targets = removalTargets(stripComments(planted));

    expect(targets).toEqual(['resolve("raw")']);
    expect(packageRootAnchoredNames(targets[0] ?? "", protectedNames)).toEqual(["raw"]);
  });

  it("PLANTED DEFECT: the equivalent spellings the first draft let through", () => {
    // Contractor review, PR #174, guard-completeness lens [must-fix] — each deletes the same data.
    expect(packageRootAnchoredNames('resolve(".", "raw")', protectedNames)).toEqual(["raw"]);
    expect(packageRootAnchoredNames('join(process.cwd(), "raw")', protectedNames)).toEqual(["raw"]);
    expect(packageRootAnchoredNames('resolve(import.meta.dirname, "..", "reports")', protectedNames)).toEqual([
      "reports",
    ]);
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

  it("stripComments never eats a removal call that is not visibly a comment", () => {
    // The hazard: `stripComments` is regex-based and cannot lex JavaScript, so a `//` or `/*`
    // inside a string literal (a URL, an inline CSS fixture) could make it swallow live code and
    // silently shrink the sweep below. `removalLines` decides the same question from line shape
    // alone, so the two disagree exactly when that happens.
    //
    // This file itself is excluded: it deliberately holds adversarial fixtures — including a string
    // that stripComments DOES eat — as the planted defect below.
    const eaten: string[] = [];

    for (const { file, source } of testSources()) {
      if (file.endsWith(SELF)) continue;
      const lost =
        (source.match(/rmSync\(/g) ?? []).length - (stripComments(source).match(/rmSync\(/g) ?? []).length;
      const commented = removalLines(source).filter((c) => c.commentedByShape).length;
      if (lost !== commented) {
        eaten.push(`${file}: stripping removed ${lost} rmSync( calls, ${commented} read as comments by shape`);
      }
    }

    expect(eaten).toEqual([]);
  });

  it("PLANTED DEFECT: the two derivations disagree when a string literal hides a //", () => {
    // The case the check above exists to catch, constructed rather than described. `stripComments`
    // sees `//b"; rmSync(...)` and eats to end of line; line shape correctly says this is code.
    // The disagreement is what makes the hazard detectable instead of silent.
    const planted = 'const p = "a//b"; rmSync(resolve("raw"), { recursive: true });';

    const lost = (planted.match(/rmSync\(/g) ?? []).length - (stripComments(planted).match(/rmSync\(/g) ?? []).length;
    const commented = removalLines(planted).filter((c) => c.commentedByShape).length;

    expect(lost).toBe(1); // stripComments loses it
    expect(commented).toBe(0); // line shape knows it is code
    expect(lost).not.toBe(commented); // therefore the suite-wide check above would report it
  });

  it("no test file under either gate runner removes a package-root-anchored protected directory", () => {
    const offenders: string[] = [];

    for (const { file, source } of testSources()) {
      if (file.endsWith(SELF)) continue; // holds the planted defects above
      for (const target of removalTargets(stripComments(source))) {
        for (const name of packageRootAnchoredNames(target, protectedNames)) {
          offenders.push(`${file}: rmSync(${target}) removes the gitignored "${name}/"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
