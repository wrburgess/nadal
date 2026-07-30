import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { quoteSummaryValue, sanitizeSummaryValue } from "../src/cli/commands/db-migrate.js";
import * as client from "../src/db/client.js";

// Unicode line-break characters that are NOT ASCII C0 controls: NEL, Line
// Separator, Paragraph Separator. Some terminals/log consumers render or
// index these as a new line, so they must be stripped too, not just \n/\r.
const NEL = String.fromCharCode(0x85);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
// Unicode C1 control characters beyond NEL: CSI and OSC. A terminal that
// recognizes these can have its output rewritten or hidden by them.
const CSI = String.fromCharCode(0x9b);
const OSC = String.fromCharCode(0x9d);

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

describe("tn db migrate (end-to-end via dispatch)", () => {
  const original = process.env.TN_DB_PATH;

  beforeEach(() => {
    process.env.TN_DB_PATH = join(mkdtempSync(join(tmpdir(), "tn-")), "cmd.db");
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TN_DB_PATH;
    else process.env.TN_DB_PATH = original;
  });

  it("applies migrations, prints one status=ok summary line, and exits 0", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["db", "migrate"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^db migrate status=ok path=.+cmd\.db$/),
    );
    logSpy.mockRestore();
  });

  it("prints one status=error summary line and exits non-zero when migration fails", async () => {
    // Point TN_DB_PATH inside a path segment that is a regular file, not a directory,
    // so mkdirSync(dirname(path), { recursive: true }) throws ENOTDIR.
    const blockerFile = join(mkdtempSync(join(tmpdir(), "tn-")), "blocker");
    writeFileSync(blockerFile, "not a directory");
    process.env.TN_DB_PATH = join(blockerFile, "nested", "test.db");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["db", "migrate"]);
    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^db migrate status=error message=".+"$/),
    );
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("strips Unicode line-break characters from a real error message end-to-end", async () => {
    // A cross-module spy on client.ts's runMigrations() — as seen by
    // db-migrate.ts, a different module — lets us force a controlled error
    // message, unlike a real fs failure whose message text we don't control.
    const runMigrationsSpy = vi.spyOn(client, "runMigrations").mockImplementation(() => {
      throw new Error(`line one${LINE_SEPARATOR}line two${PARAGRAPH_SEPARATOR}line three${NEL}end`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["db", "migrate"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toMatch(/^db migrate status=error message=".+"$/);
    expect(printed).not.toContain(LINE_SEPARATOR);
    expect(printed).not.toContain(PARAGRAPH_SEPARATOR);
    expect(printed).not.toContain(NEL);

    runMigrationsSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("sanitizeSummaryValue()", () => {
  it("strips control characters, including newlines, so a value stays single-line", () => {
    expect(sanitizeSummaryValue("a\nb\tc")).toBe("a b c");
  });

  it("leaves ordinary paths unchanged", () => {
    expect(sanitizeSummaryValue("/tmp/foo/bar.db")).toBe("/tmp/foo/bar.db");
  });

  it("does not mangle a path containing a literal double quote", () => {
    // sanitizeSummaryValue() is also used for the UNQUOTED `path=` field
    // (db-migrate.ts's success line). It must not apply message-quoting escapes
    // there: POSIX filenames may legally contain `"`, and inserting a backslash
    // would print a path that no longer matches the file actually migrated.
    // Quote-escaping belongs only to quoteSummaryValue(), for the quoted
    // `message="..."` field.
    expect(sanitizeSummaryValue('a"b.db')).toBe('a"b.db');
  });

  it("strips Unicode line-break characters (NEL, Line Separator, Paragraph Separator), not just ASCII controls", () => {
    // \n/\r/other C0 controls aren't the only characters that can render or be
    // indexed as a line break — some terminals and log consumers treat U+0085,
    // U+2028, and U+2029 the same way, which would let them forge an apparent
    // second summary line despite not being ASCII control characters.
    const withUnicodeBreaks = `a${NEL}b${LINE_SEPARATOR}c${PARAGRAPH_SEPARATOR}d`;
    expect(sanitizeSummaryValue(withUnicodeBreaks)).toBe("a b c d");
  });

  it("strips the rest of the Unicode C1 control block (e.g. CSI, OSC), not just NEL", () => {
    // A terminal that recognizes C1 controls can have its output rewritten or
    // hidden by CSI/OSC sequences embedded in an otherwise-plain-looking
    // error message, defeating the "safe, observable one-line summary"
    // guarantee just as much as an ASCII control character would.
    const withC1Controls = `a${CSI}b${OSC}c`;
    expect(sanitizeSummaryValue(withC1Controls)).toBe("a b c");
  });
});

describe("quoteSummaryValue()", () => {
  it("strips control characters like sanitizeSummaryValue", () => {
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
});
