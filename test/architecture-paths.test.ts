import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards ARCHITECTURE.md against the one rot mode a reader cannot detect by reading: a path the
// document names that no longer exists. Nothing else in the repo reads that file — `LINK_CHECKED` in
// scripts/parity_check.rb is a hand-maintained enumeration of BUNDLE-owned paths (deliberately not a
// glob, so vendoring never reddens a host's own docs), and every nadal-authored doc sits outside it.
//
// WHAT THIS CHECK HOLDS FOR, STATED NARROWLY (rules/testing.md: never let a check's comment claim
// coverage the code does not enforce). It asserts that each repo path the document names in an inline
// code span RESOLVES ON DISK. It does NOT verify that any claim made ABOUT that path is true, that the
// map is complete, that a newly added src/ directory was given a row, or that the prose matches the
// code. Those stay unenforced, and ARCHITECTURE.md says so itself rather than letting this green imply
// otherwise.

// The repo-owned roots a documented path may start with. Deliberately EXCLUDES the runtime roots
// `data/`, `raw/`, `reports/` and `scorecard-photos/` — all four are gitignored, so they are absent on
// a fresh clone and in CI. The document must be free to name `raw/tennisrecord/…` when describing where
// captures land without that turning a checkout red.
const REPO_ROOTS = [
  "src",
  "test",
  "docs",
  "scripts",
  "bin",
  "drizzle",
  "rules",
  "skills",
  "\\.github",
] as const;

const PATH_SPAN = new RegExp(`^(?:${REPO_ROOTS.join("|")})/\\S*$`);

// A fenced block is an ILLUSTRATION — a shell transcript, a sample tree — and its contents are not
// claims about this repo's layout. Stripped before scanning, the same distinction
// scripts/parity_check.rb draws with strip_code. Non-greedy so consecutive fences do not swallow the
// prose between them.
const FENCED_BLOCK = /```[\s\S]*?```/g;

// Inline code spans only. `[^`\n]+` keeps a span on one line, so an unclosed backtick cannot run to
// the end of the file and swallow the document.
//
// No capture group, and the backticks are sliced off the whole match instead. A capture group would
// type as `string | undefined` under this repo's strict index access, and the only ways to satisfy
// that are a non-null assertion or an `undefined` guard — and the guard would be a branch no fixture
// can reach, since group 1 always participates whenever this pattern matches at all
// (rules/testing.md: never keep a branch in new code that no test can kill). Slicing has neither
// problem: the delimiters are one character each by construction.
const INLINE_SPAN = /`[^`\n]+`/g;

// Pure over its input, so the tests below can feed it synthetic markdown. That is what makes the
// vacuity and self-falsification cases provable rather than assertions that would also hold over an
// empty parse (rules/testing.md: never let a fixture satisfy a loop's exit condition before the case
// under test is reached).
function extractRepoPaths(markdown: string): string[] {
  const prose = markdown.replace(FENCED_BLOCK, "");
  const found = new Set<string>();
  for (const [delimited] of prose.matchAll(INLINE_SPAN)) {
    const span = delimited.slice(1, -1);
    if (PATH_SPAN.test(span)) found.add(span);
  }
  // Deduped, so a path named in five sections is reported once rather than five times.
  return [...found].sort();
}

// The single predicate. "names only repo paths that resolve on disk" runs it over the real document,
// and "reports a named path that does not exist" runs it over a fixture with a known-absent path — the
// same function both times, which is what proves the first of those is capable of failing at all.
//
// NOTE: a `:line` or `#anchor` suffix is deliberately NOT stripped, so `src/query/derive.ts:422` fails
// to resolve and reddens. That is not an oversight — issue #101 constrains the document to "directory
// and file level, not line level", and this is the only mechanical expression of that constraint.
function missingPaths(paths: string[]): string[] {
  return paths.filter((p) => !existsSync(p));
}

const DOC = "ARCHITECTURE.md";

// The floor exists because "names only repo paths that resolve on disk" asserts over a list: if a
// rewrite stopped using inline code spans for paths, that list would be empty and the assertion would
// hold over nothing — green, and checking nothing. The
// number is a floor on a document that names every src/ directory plus its per-table owners, not a
// target; it only has to be high enough that an accidental extraction failure cannot clear it.
const MINIMUM_DOCUMENTED_PATHS = 25;

describe("ARCHITECTURE.md path liveness", () => {
  it("exists at the repo root", () => {
    expect(existsSync(DOC), `${DOC} is missing from the repo root`).toBe(true);
  });

  it("names at least the expected number of repo paths, so the resolution check is not vacuous", () => {
    const paths = extractRepoPaths(readFileSync(DOC, "utf8"));
    expect(paths.length).toBeGreaterThanOrEqual(MINIMUM_DOCUMENTED_PATHS);
  });

  it("names only repo paths that resolve on disk", () => {
    const paths = extractRepoPaths(readFileSync(DOC, "utf8"));
    expect(missingPaths(paths)).toEqual([]);
  });

  it("resolves a documented directory, not only a file", () => {
    // `src/query/` is written with its trailing slash throughout the document; existsSync is true for
    // a directory, and pinning it here stops a later "tighten this to files only" edit from silently
    // reddening every directory row.
    expect(extractRepoPaths("The read layer is `src/query/`.")).toEqual(["src/query/"]);
    expect(missingPaths(["src/query/"])).toEqual([]);
  });

  it("reports a named path that does not exist", () => {
    const fixture = "The heuristic lives in `src/does-not-exist.ts`.";
    const paths = extractRepoPaths(fixture);
    expect(paths).toEqual(["src/does-not-exist.ts"]);
    expect(missingPaths(paths)).toEqual(["src/does-not-exist.ts"]);
  });

  it("ignores code spans that are not repo paths", () => {
    const fixture = [
      "Run `tn player pull` with `--json`, honouring `TN_DB_PATH`,",
      "and it prints `status=ok`. The type is `Db`, the table is `court_matches`.",
    ].join("\n");
    expect(extractRepoPaths(fixture)).toEqual([]);
  });

  it("ignores paths inside a fenced block", () => {
    const fixture = ["Real: `src/db/schema.ts`.", "```", "src/not-a-real-path.ts", "```"].join("\n");
    expect(extractRepoPaths(fixture)).toEqual(["src/db/schema.ts"]);
  });

  it("ignores gitignored runtime roots, which are absent on a fresh clone", () => {
    const fixture = [
      "Captures land in `raw/tennisrecord/`, dossiers in `reports/`,",
      "the database in `data/nadal.db`, photos in `scorecard-photos/`.",
    ].join("\n");
    expect(extractRepoPaths(fixture)).toEqual([]);
  });
});
