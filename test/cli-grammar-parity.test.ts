import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli/router.js";

type GrammarRow = { noun: string; verb: string; summary: string };

// [a-z0-9-]+ (not [a-z]+): a noun/verb spelling containing a digit or hyphen (e.g. a future
// `tn db backup-all`) must still be captured — with the narrower [a-z]+ pattern such a row simply
// never matches, so the "every GRAMMAR.md row is a registered command" direction below passes
// vacuously (0 rows checked) instead of actually verifying it.
const ROW_PATTERN = /^\|\s*`tn ([a-z0-9-]+) ([a-z0-9-]+)[^`]*`\s*\|\s*([^|]+?)\s*\|/;

function grammarRows(): GrammarRow[] {
  const md = readFileSync("docs/cli/GRAMMAR.md", "utf8");
  const section = md.split("## Commands")[1] ?? "";
  const rows: GrammarRow[] = [];
  for (const line of section.split("\n")) {
    const m = ROW_PATTERN.exec(line);
    if (m) rows.push({ noun: m[1]!, verb: m[2]!, summary: m[3]! });
  }
  return rows;
}

function key(nounOrRow: { noun: string; verb: string }): string {
  return `${nounOrRow.noun} ${nounOrRow.verb}`;
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
});
