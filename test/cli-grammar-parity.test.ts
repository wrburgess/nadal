import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../src/cli/router.js";
import { emitSummary } from "../src/cli/emit.js";

type GrammarRow = { noun: string; verb: string; summary: string };

// [a-z0-9-]+ (not [a-z]+): a noun/verb spelling containing a digit or hyphen (e.g. a future
// `tn db backup-all`) must still be captured — with the narrower [a-z]+ pattern such a row simply
// never matches, so the "every GRAMMAR.md row is a registered command" direction below passes
// vacuously (0 rows checked) instead of actually verifying it.
//
// ` {0,3}` before the pipe, not `^\|` (Reviewer finding 1 on PR #84): CommonMark/GFM allow a table
// row to be indented up to three spaces, so `  | `tn db migrate` | … |` RENDERS as a real command
// row while a column-0-anchored pattern skips it — a duplicate the reader sees and the guard does
// not. Four spaces is an indented code block and is correctly not a row, which is why the bound is
// 3 rather than `\s*`.
// Still `^`-anchored — the relaxation is from "column 0" to "columns 0-3", NOT to "anywhere on the
// line". Dropping the anchor would let a pipe inside a prose sentence match and register a command.
const ROW_PATTERN = /^ {0,3}\|\s*`tn ([a-z0-9-]+) ([a-z0-9-]+)[^`]*`\s*\|\s*([^|]+?)\s*\|/;
const TABLE_LINE = /^ {0,3}\|/;

// Pure over its input so a test can feed it synthetic markdown — which is what makes the
// duplicate-row guard below provably non-vacuous rather than a check that would also pass on an
// empty parse (rules/testing.md: "never let a fixture satisfy a loop's exit condition before the
// case under test is reached").
//
// Scoped to the FIRST contiguous table block after the heading, not to every line after it (the
// other half of Reviewer finding 1). Splitting on `## Commands` and scanning to end-of-file means
// any later table — an examples table, a future `## Exit codes` table — is read as command-registry
// content, and the bijection assertion below turns that misreading into a failure. Stopping at the
// first non-table line bounds the parse to the one table this file is about.
//
// ACCEPTED RESIDUAL (#85, Reviewer finding 5 on PR #84): `md.split("## Commands")` matches the
// first TEXT occurrence, not an ATX heading. Prose containing the literal `## Commands` (say, in
// backticks) followed by a byte-for-byte decoy copy of the command table redirects the parse to the
// decoy, and a duplicate row added to the REAL table below is then invisible to every assertion in
// this file. Reaching it takes all three of those author actions at once; the threat model here is
// an accidental double row, which the guard does catch. Not patched: this parser hit the
// escalate-on-recurrence bound (three review rounds, three new parse defects), so the durable fix
// is removing the parser — generating the table from `COMMANDS` — which awaits triage as a
// findings-log idea, not another regex.
function parseGrammarRows(md: string): GrammarRow[] {
  const section = md.split("## Commands")[1] ?? "";
  const rows: GrammarRow[] = [];
  let inTable = false;
  for (const line of section.split("\n")) {
    const isTableLine = TABLE_LINE.test(line);
    if (!isTableLine) {
      if (inTable) break; // the Commands table has ended; everything after it is prose
      continue; // still in the blank lines between the heading and the table
    }
    inTable = true;
    const m = ROW_PATTERN.exec(line);
    if (m) rows.push({ noun: m[1]!, verb: m[2]!, summary: m[3]! });
  }
  return rows;
}

function grammarRows(): GrammarRow[] {
  return parseGrammarRows(readFileSync("docs/cli/GRAMMAR.md", "utf8"));
}

function key(nounOrRow: { noun: string; verb: string }): string {
  return `${nounOrRow.noun} ${nounOrRow.verb}`;
}

function duplicateKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return [...dupes].sort();
}

describe("grammar parity", () => {
  it("every registered command appears in GRAMMAR.md", () => {
    const keys = grammarRows().map(key);
    for (const c of COMMANDS) {
      expect(keys, `tn ${key(c)} missing from GRAMMAR.md`).toContain(key(c));
    }
  });

  it("every GRAMMAR.md row is a registered command", () => {
    const registeredKeys = new Set(COMMANDS.map(key));
    for (const row of grammarRows()) {
      expect(registeredKeys, `GRAMMAR.md row "tn ${key(row)}" not implemented`).toContain(key(row));
    }
  });

  it("every registered command's summary matches its GRAMMAR.md row (registry -> doc)", () => {
    // Editing a command's summary (e.g. to "Delete all data") without touching GRAMMAR.md must
    // fail CI — the noun/verb-only checks above stay green for that edit, since they never look
    // past the backtick-quoted `tn <noun> <verb>` cell.
    const docSummaryByKey = new Map(grammarRows().map((r) => [key(r), r.summary]));
    for (const c of COMMANDS) {
      expect(
        docSummaryByKey.get(key(c)),
        `tn ${key(c)}'s summary "${c.summary}" does not match its GRAMMAR.md row`,
      ).toBe(c.summary);
    }
  });

  it("every GRAMMAR.md row's summary matches its registered command (doc -> registry)", () => {
    const registrySummaryByKey = new Map(COMMANDS.map((c) => [key(c), c.summary]));
    for (const row of grammarRows()) {
      expect(
        registrySummaryByKey.get(key(row)),
        `GRAMMAR.md row "tn ${key(row)}"'s summary "${row.summary}" does not match the registered command's summary`,
      ).toBe(row.summary);
    }
  });

  // #64 (docs/findings.md, deferred Codex round-1 finding on PR #20). The four tests above are two
  // CONTAINMENTS, and a duplicate satisfies a containment by construction: `Set.has` and
  // `Map.get` both collapse a repeated key, so a second identical `| `tn db migrate` | … |` row
  // passes every one of them — silently contradicting GRAMMAR.md's own opening line, "one spelling
  // per operation".
  //
  // The structural statement, and the one this asserts, is that the doc rows and the registry are
  // in BIJECTION: no duplicate on either side, and the same members. Enumerating a third
  // containment check would have been the same shape of guard a third time; deriving it from the
  // structure is what closes the class (docs/findings.md class C5).
  //
  // The registry half is new coverage the finding did not ask for and that falls straight out of
  // that framing: `COMMANDS` is a plain array with no uniqueness constraint, so two entries sharing
  // a noun/verb are possible TODAY — `dispatch`'s `.find()` would silently shadow the second and
  // `helpText()` would print the pair twice. Same invariant, other side of the seam.
  it("GRAMMAR.md and the registry are in bijection — no duplicate row, no duplicate registration", () => {
    const docKeys = grammarRows().map(key);
    const registryKeys = COMMANDS.map(key);

    expect(duplicateKeys(docKeys), "GRAMMAR.md lists a command more than once").toEqual([]);
    expect(duplicateKeys(registryKeys), "COMMANDS registers a command more than once").toEqual([]);
    expect([...docKeys].sort()).toEqual([...registryKeys].sort());
  });

  it("the duplicate check is not vacuous — it reports a duplicate in synthetic markdown", () => {
    // Without this, `duplicateKeys(...) === []` above would pass just as happily if the parser
    // stopped matching rows altogether (a changed table format, a renamed "## Commands" heading) —
    // zero rows have zero duplicates. Feeding a known-duplicate document proves the guard can fail,
    // which is the only thing that makes its passing mean anything.
    const synthetic = [
      "## Commands",
      "",
      "| Command | Summary |",
      "|---------|---------|",
      "| `tn db migrate` | Apply pending schema migrations |",
      "| `tn team show` | Show a team's roster and match record |",
      "| `tn db migrate` | Apply pending schema migrations |",
      "",
    ].join("\n");

    const rows = parseGrammarRows(synthetic);
    expect(rows).toHaveLength(3);
    expect(duplicateKeys(rows.map(key))).toEqual(["db migrate"]);
  });

  // Reviewer finding 1 on PR #84, both halves. The bijection assertion above derives from
  // structure, but only over what the PARSER sees — so a duplicate the parser skips is a duplicate
  // the guard cannot report, and the structural framing buys nothing. These two fixtures are the
  // parser's own guard.
  it("counts an INDENTED duplicate row — Markdown allows 0-3 spaces before a table pipe", () => {
    // The Reviewer's trace. `  | `tn db migrate` | … |` renders as a second command row and
    // contradicts GRAMMAR.md's "one spelling per operation", but the column-0-anchored pattern
    // skipped it and the duplicate assertion passed.
    const synthetic = [
      "## Commands",
      "",
      "| Command | Summary |",
      "|---------|---------|",
      "| `tn db migrate` | Apply pending schema migrations |",
      "  | `tn db migrate` | Apply pending schema migrations |",
      "",
    ].join("\n");

    expect(parseGrammarRows(synthetic)).toHaveLength(2);
    expect(duplicateKeys(parseGrammarRows(synthetic).map(key))).toEqual(["db migrate"]);
  });

  it("stops at the end of the Commands table — a later table is not command-registry content", () => {
    // The other half. Splitting on `## Commands` and scanning to end-of-file reads any later table
    // as command rows; combined with the new sorted-key equality, a future examples table would
    // fail the bijection for a reason that has nothing to do with the registry. Four leading
    // spaces is an indented code block, not a table row, and is asserted as excluded too — that is
    // the boundary that makes `{0,3}` a rule rather than a guess.
    const synthetic = [
      "## Commands",
      "",
      "| Command | Summary |",
      "|---------|---------|",
      "| `tn db migrate` | Apply pending schema migrations |",
      "",
      "Some prose about exit codes follows, and then an unrelated table:",
      "",
      "| Example | Meaning |",
      "|---------|---------|",
      "| `tn team pull` | not a registry row — this table is illustrative |",
      "",
      "    | `tn mcp serve` | four spaces: an indented code block, not a table row |",
      "",
    ].join("\n");

    expect(parseGrammarRows(synthetic).map(key)).toEqual(["db migrate"]);
  });

  // #64 finding `:33`: GRAMMAR.md's summary-line paragraph asserted that EVERY value field is
  // double-quoted, while the example on its own line showed `status=ok` bare and numeric counts
  // (`roster=18`) are bare too. The paragraph is now scoped to string values — and this is what
  // stops it drifting again. A doc claim with no enforcer is exactly how `:33` came to exist; the
  // fix is not a more careful sentence, it is a sentence something can falsify.
  it("GRAMMAR.md's worked summary-line example is the line emitSummary actually renders", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      emitSummary("team pull", "ok", [
        ["team", "Norbury"],
        ["roster", 18],
        ["matches", 10],
        ["archived", "raw/tennisrecord/x.html"],
      ]);
      const rendered = String(logSpy.mock.calls[0]?.[0]);
      // Sanity: the renderer really does produce the bare/quoted mix the doc now describes, so a
      // change to emitSummary reddens here rather than silently rewriting what the doc must say.
      expect(rendered).toContain("status=ok");
      expect(rendered).toContain("roster=18");
      expect(rendered).toContain('team="Norbury"');
      // The doc must carry that exact line. Substring equality on the whole rendered string, not a
      // few chosen fragments — a partial check would pass on a doc example that had quoted
      // `status` or dropped a field.
      expect(readFileSync("docs/cli/GRAMMAR.md", "utf8")).toContain(rendered);
    } finally {
      logSpy.mockRestore();
    }
  });
});
