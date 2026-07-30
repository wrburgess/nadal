import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli/router.js";

function grammarRows(): string[] {
  const md = readFileSync("docs/cli/GRAMMAR.md", "utf8");
  const section = md.split("## Commands")[1] ?? "";
  const rows: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\|\s*`tn ([a-z]+) ([a-z]+)[^`]*`\s*\|/.exec(line);
    if (m) rows.push(`${m[1]} ${m[2]}`);
  }
  return rows;
}

describe("grammar parity", () => {
  it("every registered command appears in GRAMMAR.md", () => {
    const rows = grammarRows();
    for (const c of COMMANDS) {
      expect(rows, `tn ${c.noun} ${c.verb} missing from GRAMMAR.md`).toContain(`${c.noun} ${c.verb}`);
    }
  });

  it("every GRAMMAR.md row is a registered command", () => {
    const keys = new Set(COMMANDS.map((c) => `${c.noun} ${c.verb}`));
    for (const row of grammarRows()) {
      expect(keys, `GRAMMAR.md row "tn ${row}" not implemented`).toContain(row);
    }
  });
});
