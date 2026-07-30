import { describe, expect, it } from "vitest";
import { quoteSummaryValue } from "../src/cli/summary.js";

/**
 * A correct escape-aware scan of a `key="..."` field: on a backslash, the NEXT
 * character is always consumed as part of the escape pair (regardless of what it
 * is), so a run of backslashes is resolved pair-by-pair rather than by checking
 * only the single character immediately before a quote — the naive check an
 * earlier version of these tests used, which misclassifies an even-length
 * backslash run before a quote as "escaped" when it is not.
 */
function strictParseQuotedValue(line: string, key: string): string {
  const marker = `${key}="`;
  const start = line.indexOf(marker) + marker.length;
  let i = start;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === '"') break;
    i++;
  }
  expect(line[i]).toBe('"'); // must have found a real closing quote, not run off the end
  return line.slice(start, i).replace(/\\(.)/g, "$1");
}

describe("quoteSummaryValue()", () => {
  it("strips control characters like sanitizeValue", () => {
    expect(quoteSummaryValue("a\nb\tc")).toBe("a b c");
  });

  it("escapes embedded double quotes so a quoted summary value stays parseable", () => {
    // db-migrate.ts wraps this in message="${quoteSummaryValue(message)}" — an
    // unescaped `"` in the error message would prematurely close that quoted value
    // and break the key=value shape the CLI contract requires to stay deterministic.
    expect(quoteSummaryValue('no such table: "players"')).toBe(
      'no such table: \\"players\\"',
    );
  });

  it("escapes backslashes before quotes so an escape-aware parser isn't fooled by a paired run", () => {
    // A message containing a literal backslash immediately followed by a quote
    // (POSIX filenames — and therefore TN_DB_PATH-derived fs error messages — can
    // contain both). Escaping only `"` would turn `\"` into `\\"`, an EVEN run of
    // backslashes before the quote: a real escape-aware parser reads that as one
    // escaped literal backslash followed by an UNESCAPED quote, and terminates the
    // value right there. Escaping backslashes first avoids the ambiguity.
    const raw = String.raw`foo\"bar`; // literal: f o o \ " b a r
    expect(quoteSummaryValue(raw)).toBe(String.raw`foo\\\"bar`); // \\ then \"
  });

  it("keeps a strict escape-aware parse intact for a message containing quotes", () => {
    const raw = 'table "players" already exists';
    const line = `db migrate status=error message="${quoteSummaryValue(raw)}"`;
    expect(strictParseQuotedValue(line, "message")).toBe(raw);
  });

  it("keeps a strict escape-aware parse intact for a message containing a backslash-quote run", () => {
    const raw = String.raw`bad path: C:\temp\"quoted"\end`;
    const line = `db migrate status=error message="${quoteSummaryValue(raw)}"`;
    expect(strictParseQuotedValue(line, "message")).toBe(raw);
  });

  it("round-trips a trailing space in a path through the quoted summary field", () => {
    // The concrete bug this guards: TN_DB_PATH="/tmp/x.db " (trailing space, legal POSIX) must
    // not come out the other side as "/tmp/x.db" — that would misname the file that was actually
    // created. Every summary field is quoted, so the edge space is unambiguous once inside the
    // quotes; it must survive quoteSummaryValue() intact.
    const raw = "/tmp/x.db ";
    const line = `db migrate status=ok path="${quoteSummaryValue(raw)}"`;
    expect(strictParseQuotedValue(line, "path")).toBe(raw);
  });
});
