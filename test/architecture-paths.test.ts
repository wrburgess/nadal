import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards ARCHITECTURE.md against the one rot mode a reader cannot detect by reading: a path the
// document names that no longer exists. Nothing else in the repo reads that file — `LINK_CHECKED` in
// scripts/parity_check.rb is a hand-maintained enumeration of BUNDLE-owned paths (deliberately not a
// glob, so vendoring never reddens a host's own docs), and every nadal-authored doc sits outside it.
//
// WHAT THIS CHECK HOLDS FOR, STATED NARROWLY (rules/testing.md: never let a check's comment claim
// coverage the code does not enforce). It asserts that every token in the document SHAPED LIKE a repo
// path resolves on disk. It does NOT verify that any claim made ABOUT that path is true, that the map
// is complete, that a newly added src/ directory was given a row, or that the prose matches the code.
// Those stay unenforced, and ARCHITECTURE.md says so itself rather than letting this green imply
// otherwise.
//
// WHY IT SCANS THE WHOLE DOCUMENT INSTEAD OF PARSING MARKDOWN (PR #103, four review rounds, two HC
// decisions). Earlier revisions enumerated the markup constructs a path can sit inside — inline code
// spans, then inline links, then reference definitions, then a detector for "is there a link at all".
// Each round the Reviewer produced one more valid spelling that escaped: a destination with balanced
// parentheses, percent-encoding, an angle-bracket destination, a reference definition inside a block
// quote, an escaped `]` in a label. That set is CommonMark's and it is open; this repo does not own it
// and no Markdown parser is in its dependencies.
//
// So the predicate is inverted. The closed set is the set of PATH SHAPES — `REPO_ROOTS` below, which
// this repo owns and this file defines — and the scan splits on markup delimiters rather than
// interpreting them. Where a path sits stops mattering: a path in a link destination, a block quote, a
// table cell, a bold run, or bare prose is found the same way. Measured against the real document when
// this landed: 73 paths, zero false reds.
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

// Markdown delimiters that can abut a path: code-span backticks, quotes, link brackets and
// parentheses, angle-bracket destinations, emphasis asterisks, table pipes. SPLIT on them — never
// interpret them — which is the whole reason this scan is markup-independent. `.` `,` `;` `:` are
// absent deliberately: they occur inside real filenames, so they are trimmed from the END only.
const DELIMITER = /[\s`"'()[\]<>*|]+/;

// Sentence punctuation trailing a path (`…see src/db/client.ts.`). Trimmed from the end only, so a
// filename's own dots survive. A trailing `/` is NOT trimmed — that is how every directory in the
// document is written.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

// A fence opens a code block; its contents are an ILLUSTRATION — a sample tree, a transcript — and are
// not claims about this repo's layout.
//
// ` {0,3}`, NOT `[ \t]*` (Reviewer finding, PR #103 round 2 — and the same correction a Reviewer made
// to test/cli-grammar-parity.test.ts on PR #84, for the same CommonMark reason). A fence may be
// indented up to three spaces; at four it is an indented code block and not a fence at all. Accepting
// unlimited indentation made a four-space-indented fence open a block and strip its contents — which
// silently contradicted the policy stated in stripCodeBlocks and turned a dead path green.
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/;

// Recognises a code block by Markdown's actual fence rule rather than by one spelling: three OR MORE
// backticks or tildes, closed by a fence of the same character and at least the same length, or by end
// of file. A line-oriented scan rather than a regex, because the regex form needs a backreference
// under /m to compare opening and closing fences, and the readable version of that is this loop.
//
// INDENTED (four-space) CODE BLOCKS ARE DELIBERATELY NOT STRIPPED, and that is a real limit, not an
// omission. ARCHITECTURE.md indents list continuations by four spaces (§5), so treating indentation as
// code would silently drop real prose from the scan — trading a VISIBLE false red (an illustrative path
// in an indented block reddens the suite) for a SILENT false green (a real path in an indented
// continuation goes unchecked). Between those two, the visible failure is the safe one.
//
// THE STOPPING RULE IS THE FAILURE DIRECTION, NOT A CONSTRUCT LIST. Fences this does not model — one
// inside a block quote, or after a list marker — leak their illustration into the scan and go RED,
// which someone sees and fixes. Nothing known fails silent. That asymmetry is the bound; chasing
// CommonMark instead moved the defect one construct sideways per round for four rounds.
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
  const found = new Set<string>();
  for (const token of stripCodeBlocks(markdown).split(DELIMITER)) {
    const path = token.replace(TRAILING_PUNCTUATION, "");
    if (REPO_PATH.test(path)) found.add(path);
  }
  // Deduped, so a path named in five sections is reported once rather than five times.
  return [...found].sort();
}

// The single predicate. "names only repo paths that resolve on disk" runs it over the real document,
// and "reports a named path that does not exist" runs it over a fixture with a known-absent path — the
// same function both times, which is what proves the first of those is capable of failing at all.
//
// NOTE: a `#anchor` suffix is deliberately NOT stripped, so `src/query/derive.ts#L422` fails to resolve
// and reddens. Issue #101 constrains the document to "directory and file level, not line level", and
// this is the only mechanical expression of that constraint. (A `:422` suffix is caught by the same
// rule — the trailing-punctuation trim removes a bare final colon, never a colon followed by digits.)
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
// rewrite broke extraction, that list would be empty and the assertion would hold over nothing —
// green, and checking nothing. The number is a floor on a document that names every src/ directory
// plus its per-table owners, not a target. It is expressly NOT a completeness check: an extractor that
// silently kept any 25 real paths would still clear it.
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

  it("finds a path whatever markup surrounds it", () => {
    // The point of the whole design, and the regression suite for four rounds of review. Every row is
    // a spelling that escaped some earlier markup-enumerating revision of this guard; the scan is now
    // markup-independent, so each is found the same way.
    const spellings: Record<string, string> = {
      "code span": "The router is `src/does-not-exist.ts`.",
      "bare prose": "The router is src/does-not-exist.ts today.",
      "inline link": "See [router](src/does-not-exist.ts).",
      "inline link with title": 'See [r](src/does-not-exist.ts "the router").',
      "reference definition": "[router]: src/does-not-exist.ts",
      "reference def in a block quote": "> [router]: src/does-not-exist.ts",
      "reference def, escaped ] in label": "[r\\]]: src/does-not-exist.ts",
      "angle-bracket destination": "[router]: <src/does-not-exist.ts>",
      "bold": "The router is **src/does-not-exist.ts**.",
      "table cell": "| Router | `src/does-not-exist.ts` | yes |",
      "trailing sentence period": "It lives in src/does-not-exist.ts.",
      "fence inside a list item": "- ```\n  `src/does-not-exist.ts`",
      "fence inside a block quote": "> ```\n> `src/does-not-exist.ts`",
      "four-space-indented fence": "    ```\n`src/does-not-exist.ts`\n    ```",
    };
    for (const [markup, fixture] of Object.entries(spellings)) {
      expect(extractRepoPaths(fixture), `markup: ${markup}`).toEqual(["src/does-not-exist.ts"]);
    }
  });

  it("extracts every path in a span that names more than one", () => {
    expect(extractRepoPaths("Related: `src/cli/router.ts and src/does-not-exist.ts`.")).toEqual([
      "src/cli/router.ts",
      "src/does-not-exist.ts",
    ]);
  });

  it("resolves a documented directory, not only a file", () => {
    // `src/query/` is written with its trailing slash throughout the document. existsSync is true for
    // a directory, and the trailing slash must survive the punctuation trim.
    expect(extractRepoPaths("The read layer is `src/query/`.")).toEqual(["src/query/"]);
    expect(missingPaths(["src/query/"])).toEqual([]);
  });

  it("reports a named path that does not exist", () => {
    const paths = extractRepoPaths("The heuristic lives in `src/does-not-exist.ts`.");
    expect(paths).toEqual(["src/does-not-exist.ts"]);
    expect(missingPaths(paths)).toEqual(["src/does-not-exist.ts"]);
  });

  it("ignores tokens that are not repo paths", () => {
    const fixture = [
      "Run `tn player pull` with `--json`, honouring `TN_DB_PATH`,",
      "and it prints `status=ok`. The type is `Db`, the table is `court_matches`.",
      "See https://example.test/src/not-a-repo-path.ts and data/nadal.db too.",
    ].join("\n");
    expect(extractRepoPaths(fixture)).toEqual([]);
  });

  it("ignores paths inside a fenced block, whichever fence spelling opened it", () => {
    const cases: Record<string, string> = {
      backtick: ["Real: `src/db/schema.ts`.", "```", "`src/not-a-real-path.ts`", "```"].join("\n"),
      tilde: ["Real: `src/db/schema.ts`.", "~~~text", "`src/not-a-real-path.ts`", "~~~"].join("\n"),
      // A four-backtick fence whose body CONTAINS a triple-backtick line. A balanced ````…```` fixture
      // does not distinguish the implementations, because a non-greedy /```[\s\S]*?```/ strips that
      // too. An interior ``` is what separates "closes on a fence of the same char and >= length" from
      // "closes on the next ```".
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

  it("reddens a line-level reference, which the document is not allowed to use", () => {
    // Issue #101 constrains references to directory and file level. A `#L` anchor survives the trim,
    // fails to resolve, and reddens — the only mechanical expression of that constraint.
    expect(missingPaths(extractRepoPaths("`src/query/derive.ts#L422`"))).toEqual([
      "src/query/derive.ts#L422",
    ]);
  });
});
