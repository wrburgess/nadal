import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../src/cli/router.js";
import { emitSummary } from "../src/cli/emit.js";

type GrammarRow = { noun: string; verb: string; summary: string };

// [a-z0-9-]+ (not [a-z]+): a noun/verb spelling containing a digit or hyphen (e.g. a future
// `tn db backup-all`) must still be captured — with the narrower [a-z]+ pattern such a row simply
// never matches, so the "every GRAMMAR.md row is a registered command" direction below passes
// vacuously (0 rows checked) instead of actually verifying it.
const ROW_PATTERN = /^\|\s*`tn ([a-z0-9-]+) ([a-z0-9-]+)[^`]*`\s*\|\s*([^|]+?)\s*\|/;

// Pure over its input so a test can feed it synthetic markdown — which is what makes the
// duplicate-row guard below provably non-vacuous rather than a check that would also pass on an
// empty parse (rules/testing.md: "never let a fixture satisfy a loop's exit condition before the
// case under test is reached").
function parseGrammarRows(md: string): GrammarRow[] {
  const section = md.split("## Commands")[1] ?? "";
  const rows: GrammarRow[] = [];
  for (const line of section.split("\n")) {
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
