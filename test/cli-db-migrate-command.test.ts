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
// Unicode Format characters (category Cf): invisible/zero-width, used to
// control text rendering rather than represent content. RIGHT-TO-LEFT
// OVERRIDE in particular can make a terminal/log viewer render a one-line
// summary with its fields visually reordered ("Trojan Source"-style).
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const POP_DIRECTIONAL_ISOLATE = String.fromCharCode(0x2069);

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

/**
 * A naive-but-representative whitespace-delimited key/value parser: an unquoted
 * value is read up to the next space (so an unescaped space in it WOULD end the
 * value early, exactly the vulnerability an unquoted field has); a quoted value
 * is scanned to its true closing quote. Later occurrences of a key overwrite
 * earlier ones, mirroring how many simple log parsers behave — which is exactly
 * what lets an injected `status=error` inside an unquoted path spoof the real
 * `status=ok` field if that field isn't quoted.
 */
function parseSummaryFields(line: string): Record<string, string> {
  const rest = line.replace(/^\S+\s+\S+\s*/, ""); // drop the "db migrate " prefix
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (rest[i] === " ") i++;
    if (i >= rest.length) break;
    const eq = rest.indexOf("=", i);
    if (eq === -1) break; // no more key=value pairs — trailing content, not a field
    const key = rest.slice(i, eq);
    i = eq + 1;
    let value: string;
    if (rest[i] === '"') {
      i++;
      const start = i;
      while (i < rest.length) {
        if (rest[i] === "\\") {
          i += 2;
          continue;
        }
        if (rest[i] === '"') break;
        i++;
      }
      value = rest.slice(start, i).replace(/\\(.)/g, "$1");
      i++;
    } else {
      const start = i;
      while (i < rest.length && rest[i] !== " ") i++;
      value = rest.slice(start, i);
    }
    fields[key] = value;
  }
  return fields;
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
      expect.stringMatching(/^db migrate status=ok path=".+cmd\.db"$/),
    );
    logSpy.mockRestore();
  });

  it("keeps status= from being spoofed by a path containing whitespace and an embedded key=value pair", async () => {
    // Not a contrived attack scenario: any path with a space in it — e.g. a
    // home directory like "/Users/Randy Burgess/..." — already breaks a naive
    // unquoted path= field with today's shape. This case also embeds a literal
    // "status=error" to prove the quoted field can't be mistaken for a second,
    // overriding status field by a whitespace-delimited parser.
    const trickyDir = mkdtempSync(join(tmpdir(), "tn-"));
    const trickyPath = join(trickyDir, "weird status=error dir", "cmd.db");
    process.env.TN_DB_PATH = trickyPath;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["db", "migrate"]);
    expect(code).toBe(0);

    const printed = logSpy.mock.calls[0]?.[0] as string;
    const fields = parseSummaryFields(printed);
    expect(fields.status).toBe("ok"); // not overwritten by the embedded "status=error"
    expect(fields.path).toBe(trickyPath); // decodes back to the exact real path

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

  it("does not itself escape double quotes — that responsibility belongs only to quoteSummaryValue()", () => {
    // sanitizeSummaryValue() strips control/format characters only; quoting
    // and backslash/quote escaping are quoteSummaryValue()'s job (it calls
    // sanitizeSummaryValue() first, then escapes). Every db-migrate.ts summary
    // field is quoted via quoteSummaryValue() today, but this locks down
    // sanitizeSummaryValue()'s own narrower contract regardless of how many
    // callers wrap it, so the two responsibilities don't blur back together.
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

  it("strips Unicode bidirectional/format control characters (e.g. RTL override)", () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) and isolate controls are category Cf
    // (Format), not Cc (Control) — a terminal/log viewer honoring them can
    // render a summary line with its fields visually reordered or hidden,
    // the same "Trojan Source" class of spoofing bidi controls enable in
    // source code, applied here to CLI/log output instead.
    const withBidiControls = `a${RTL_OVERRIDE}b${POP_DIRECTIONAL_ISOLATE}c`;
    expect(sanitizeSummaryValue(withBidiControls)).toBe("a b c");
  });

  it("strips a real RTL override embedded in a path so it cannot visually spoof the success line", () => {
    // The concrete case Codex's review flagged: sanitizeSummaryValue preserved
    // a path with an RTL-override character embedded before ".db status=ok"
    // unchanged, letting a hostile path visually relabel what follows it.
    // Assert against db-migrate.ts's own line shape.
    const spoofedPath = `report${RTL_OVERRIDE}.db status=ok`;
    const line = `db migrate status=ok path=${sanitizeSummaryValue(spoofedPath)}`;
    expect(line).not.toContain(RTL_OVERRIDE);
    // Matches every other sanitizeSummaryValue() case: the character is
    // replaced with a space, not deleted outright.
    expect(line).toBe("db migrate status=ok path=report .db status=ok");
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
