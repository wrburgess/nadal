import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards ARCHITECTURE.md against the one rot mode a reader cannot detect by reading: a path the
// document names that no longer exists. Nothing else in the repo reads that file — `LINK_CHECKED` in
// scripts/parity_check.rb is a hand-maintained enumeration of BUNDLE-owned paths (deliberately not a
// glob, so vendoring never reddens a host's own docs), and every nadal-authored doc sits outside it.
//
// WHAT THIS CHECK HOLDS FOR, STATED NARROWLY (rules/testing.md: never let a check's comment claim
// coverage the code does not enforce). It asserts that each repo path the document names — in an
// inline code span, or as a Markdown link target — RESOLVES ON DISK. It does NOT verify that any
// claim made ABOUT that path is true, that the map is complete, that a newly added src/ directory was
// given a row, or that the prose matches the code. Those stay unenforced, and ARCHITECTURE.md says so
// itself rather than letting this green imply otherwise.

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

const REPO_PATH = new RegExp(`^(?:${REPO_ROOTS.join("|")})/\\S*$`);

// Inline code spans. `[^`\n]+` keeps a span on one line, so an unclosed backtick cannot run to the end
// of the file and swallow the document.
//
// No capture group, and the delimiters are sliced off the whole match instead. A capture group would
// type as `string | undefined` under this repo's strict index access, and the only ways to satisfy
// that are a non-null assertion or an `undefined` guard — and the guard would be a branch no fixture
// can reach, since the group always participates whenever the pattern matches at all
// (rules/testing.md: never keep a branch in new code that no test can kill).
const INLINE_SPAN = /`[^`\n]+`/g;

// Markdown link and image targets: the `](target` of `[text](target)` and `![alt](target)`. Scanned
// because a link target is a reference to a path exactly as much as a code span is, and a document
// that links a deleted module is wrong in precisely the way this check exists to catch. Stops at
// whitespace so a link title (`[t](path "title")`) is not swallowed. `m[0]` is typed `string`, so
// slicing the leading `](` off it avoids the capture-group typing problem described above.
const LINK_TARGET = /\]\([^)\s]+/g;

// Reference-style link definitions — `[label]: src/foo.ts` on its own line. A separate construct from
// the inline form above and just as much a link target (Reviewer finding 2 on PR #103, round 2: §7
// said "as a link target" while the code saw only the inline spelling, so a reference definition
// naming a deleted module passed silently).
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*\S+/gm;

// A fence opens a code block; its contents are an ILLUSTRATION — a sample tree, a transcript — and
// are not claims about this repo's layout.
//
// ` {0,3}`, NOT `[ \t]*` (Reviewer finding 1 on PR #103, round 2 — and the same correction a Reviewer
// made to `test/cli-grammar-parity.test.ts` on PR #84, for the same CommonMark reason). A fence may be
// indented up to three spaces; at four it is an indented code block and not a fence at all. Accepting
// unlimited indentation made a four-space-indented fence open a block and strip its contents — which
// silently contradicted this file's own "indented blocks are not stripped" rule and turned a dead path
// green. Tabs are excluded for the same reason: a leading tab is indentation, not a fence.
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/;

// Punctuation a path may be wrapped in when it sits inside a prose-bearing code span. Stripped from
// both ends before the repo-root test, which closes BOTH directions of Reviewer finding 3 on PR #103,
// round 2: `` `(src/does-not-exist.ts)` `` used to fail the root test and pass SILENTLY, while
// `` `src/cli/router.ts, and then…` `` used to yield `src/cli/router.ts,` and redden a legitimate span.
// A trailing `/` is deliberately not stripped — that is how every directory in the document is written.
const TRIM_LEADING = /^[([{'"]+/;
const TRIM_TRAILING = /[),;:.\]}'"]+$/;

// Recognises a code block by Markdown's actual fence rule rather than by one spelling: three OR MORE
// backticks or tildes, closed by a fence of the same character and at least the same length, or by
// end of file. A line-oriented scan rather than a regex, because the regex form needs a backreference
// under /m to compare opening and closing fences, and the readable version of that is this loop.
//
// INDENTED (four-space) CODE BLOCKS ARE DELIBERATELY NOT STRIPPED, and that is a real limit, not an
// omission. ARCHITECTURE.md indents list continuations by four spaces (§5 items 10-12), so treating
// indentation as code would silently drop real prose from the scan — trading a VISIBLE false red (an
// illustrative path in an indented block reddens the suite) for a SILENT false green (a real path in
// an indented continuation goes unchecked). Between those two, the visible failure is the safe one.
//
// WHERE THIS STOPS, DELIBERATELY. This is a heuristic scanner over a document whose conventions it
// also constrains — it is NOT a Markdown parser, and no Markdown parser is in this repo's
// dependencies (adding one for a doc test is scope issue #101 excludes). Constructs it does not model
// — a fence inside a block quote or after a list marker, a closing fence carrying trailing text, a
// destination containing balanced parentheses, a `#fragment` or percent-encoding in a destination —
// all fail in the SAME direction: the illustration leaks into the scan and the suite goes RED. That is
// the designed direction. Every input found to fail SILENT has been closed (the fence indent bound
// above, reference-style definitions, and punctuation-wrapped tokens); the visible residue is bounded
// by policy rather than by chasing CommonMark, because each round of chasing it moved the defect one
// construct sideways rather than closing the class.
function stripCodeBlocks(markdown: string): string {
  const kept: string[] = [];
  let openFence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fence = FENCE.exec(line)?.[0].trim() ?? null;
    if (openFence === null) {
      if (fence === null) kept.push(line);
      else openFence = fence;
      continue;
    }
    // Inside a block: drop every line, and close on a fence of the same character that is at least as
    // long as the one that opened it (Markdown's rule — a longer fence closes, a shorter one does not,
    // which is what lets a block quote a shorter fence verbatim).
    if (fence !== null && fence[0] === openFence[0] && fence.length >= openFence.length) {
      openFence = null;
    }
  }
  // An unclosed fence leaves `openFence` set and its lines already dropped — the block simply runs to
  // end of file, which is what Markdown does with it too.
  return kept.join("\n");
}

// Pure over its input, so the tests below can feed it synthetic markdown. That is what makes the
// vacuity and self-falsification cases provable rather than assertions that would also hold over an
// empty parse (rules/testing.md: never let a fixture satisfy a loop's exit condition before the case
// under test is reached).
function extractRepoPaths(markdown: string): string[] {
  const prose = stripCodeBlocks(markdown);
  const found = new Set<string>();
  for (const [delimited] of prose.matchAll(INLINE_SPAN)) {
    // Split on whitespace rather than testing the span whole: a span that names two paths, or a path
    // alongside prose, names those paths just as much as a single-path span does, and testing the
    // whole span would silently extract neither.
    for (const token of delimited.slice(1, -1).split(/\s+/)) {
      const path = token.replace(TRIM_LEADING, "").replace(TRIM_TRAILING, "");
      if (REPO_PATH.test(path)) found.add(path);
    }
  }
  for (const [target] of prose.matchAll(LINK_TARGET)) {
    const path = target.slice(2);
    if (REPO_PATH.test(path)) found.add(path);
  }
  for (const [definition] of prose.matchAll(LINK_DEFINITION)) {
    const path = definition.slice(definition.indexOf("]:") + 2).trim();
    if (REPO_PATH.test(path)) found.add(path);
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
//
// CASE SENSITIVITY IS THE FILESYSTEM'S, NOT THIS CHECK'S. On macOS's default case-insensitive volume
// `existsSync("src/CLI/router.ts")` returns true, so a mis-cased path passes a local run and reddens
// only on Linux CI (.github/workflows/ci.yml runs `npm run test:coverage`). CI is therefore the
// authority on casing, not the developer's green — stated rather than fixed, because a case-exact walk
// would add real code to catch what the machine that actually gates the merge already catches.
function missingPaths(paths: string[]): string[] {
  return paths.filter((p) => !existsSync(p));
}

const DOC = "ARCHITECTURE.md";

// The floor exists because "names only repo paths that resolve on disk" asserts over a list: if a
// rewrite stopped using inline code spans for paths, that list would be empty and the assertion would
// hold over nothing — green, and checking nothing. The number is a floor on a document that names
// every src/ directory plus its per-table owners, not a target; it only has to be high enough that an
// accidental extraction failure cannot clear it. It is expressly NOT a completeness check: an
// extractor that silently kept any 25 real paths would still clear it.
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

  it("extracts every path in a span that names more than one", () => {
    // Reviewer finding 1 on PR #103. Testing the span as a whole made this span match nothing, so a
    // dead path sitting beside a live one was silently unchecked while the suite stayed green — the
    // failure direction that matters, because nobody sees it.
    const fixture = "Related: `src/cli/router.ts and src/does-not-exist.ts`.";
    expect(extractRepoPaths(fixture)).toEqual(["src/cli/router.ts", "src/does-not-exist.ts"]);
  });

  it("extracts a Markdown link target", () => {
    // The other half of Reviewer finding 1: `[obsolete](src/does-not-exist.ts)` escaped entirely.
    // ARCHITECTURE.md uses no links today, so this guards the edit that introduces the first one.
    expect(extractRepoPaths("See [obsolete](src/does-not-exist.ts).")).toEqual([
      "src/does-not-exist.ts",
    ]);
    expect(extractRepoPaths('See [g](docs/cli/GRAMMAR.md "the grammar").')).toEqual([
      "docs/cli/GRAMMAR.md",
    ]);
  });

  it("ignores code spans that are not repo paths", () => {
    const fixture = [
      "Run `tn player pull` with `--json`, honouring `TN_DB_PATH`,",
      "and it prints `status=ok`. The type is `Db`, the table is `court_matches`.",
    ].join("\n");
    expect(extractRepoPaths(fixture)).toEqual([]);
  });

  it("ignores paths inside a fenced block, whichever fence spelling opened it", () => {
    // Reviewer finding 2 on PR #103: only paired triple-backtick fences were recognised, so a tilde
    // fence, a longer fence, or an unclosed one leaked its illustration into the scan and reddened the
    // suite over a path that was never a claim.
    const cases: Record<string, string> = {
      backtick: ["Real: `src/db/schema.ts`.", "```", "`src/not-a-real-path.ts`", "```"].join("\n"),
      tilde: ["Real: `src/db/schema.ts`.", "~~~text", "`src/not-a-real-path.ts`", "~~~"].join("\n"),
      // A four-backtick fence whose body CONTAINS a triple-backtick line. Round 2 pointed out that a
      // balanced ````…```` fixture does not distinguish the implementations, because the old
      // non-greedy /```[\s\S]*?```/ happens to strip that too. An interior ``` is what actually
      // separates "closes on a fence of the same char and >= length" from "closes on the next ```".
      longer: [
        "Real: `src/db/schema.ts`.",
        "````",
        "```",
        "`src/not-a-real-path.ts`",
        "```",
        "````",
      ].join("\n"),
      unclosed: ["Real: `src/db/schema.ts`.", "```", "`src/not-a-real-path.ts`"].join("\n"),
      indentedThree: [
        "Real: `src/db/schema.ts`.",
        "   ```",
        "`src/not-a-real-path.ts`",
        "   ```",
      ].join("\n"),
    };
    for (const [spelling, fixture] of Object.entries(cases)) {
      expect(extractRepoPaths(fixture), `fence spelling: ${spelling}`).toEqual([
        "src/db/schema.ts",
      ]);
    }
  });

  it("does NOT let a four-space-indented fence open a code block", () => {
    // Reviewer finding 1 on PR #103, round 2 — the dangerous direction. `[ \t]*` before the fence let
    // an indented fence open a block and strip its contents, so a dead path went green while this
    // file's own policy said indented blocks are never stripped. CommonMark bounds a fence at three
    // spaces; at four it is an indented code block. The path must therefore be SEEN here (and redden),
    // not silently swallowed.
    const fixture = ["    ```", "`src/does-not-exist.ts`", "    ```"].join("\n");
    expect(extractRepoPaths(fixture)).toEqual(["src/does-not-exist.ts"]);
  });

  it("extracts a reference-style link definition", () => {
    // Reviewer finding 2 on PR #103, round 2 — also silent. `[label]: path` is a link target that the
    // inline `](…)` scan cannot see.
    expect(extractRepoPaths("[obsolete]: src/does-not-exist.ts")).toEqual([
      "src/does-not-exist.ts",
    ]);
    expect(extractRepoPaths("[g]: docs/cli/GRAMMAR.md")).toEqual(["docs/cli/GRAMMAR.md"]);
  });

  it("strips punctuation wrapping a path inside a prose-bearing span", () => {
    // Reviewer finding 3 on PR #103, round 2 — both directions in one fix. The parenthesised form was
    // the silent one: it failed the repo-root test and vanished.
    expect(extractRepoPaths("See `(src/does-not-exist.ts)`.")).toEqual(["src/does-not-exist.ts"]);
    expect(extractRepoPaths("See `src/cli/router.ts, and then continue`.")).toEqual([
      "src/cli/router.ts",
    ]);
    // A trailing slash is a directory, not punctuation, and must survive the trim.
    expect(extractRepoPaths("The layer is `src/query/`.")).toEqual(["src/query/"]);
  });

  it("does NOT treat four-space indentation as a code block", () => {
    // Deliberate, and the reason is asymmetric risk — see stripCodeBlocks. ARCHITECTURE.md indents
    // list continuations by four spaces, so stripping them would silently drop real paths from the
    // scan. Pinned so the choice survives a later "but indented blocks are code too" edit.
    expect(extractRepoPaths("1. A point\n    continued, naming `src/db/schema.ts`.")).toEqual([
      "src/db/schema.ts",
    ]);
  });

  it("ignores gitignored runtime roots, which are absent on a fresh clone", () => {
    const fixture = [
      "Captures land in `raw/tennisrecord/`, dossiers in `reports/`,",
      "the database in `data/nadal.db`, photos in `scorecard-photos/`.",
    ].join("\n");
    expect(extractRepoPaths(fixture)).toEqual([]);
  });
});
