import { describe, expect, it } from "vitest";
import { sanitizeValue } from "../src/sanitize.js";

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

describe("sanitizeValue()", () => {
  it("strips control characters, including newlines, so a value stays single-line", () => {
    expect(sanitizeValue("a\nb\tc")).toBe("a b c");
  });

  it("leaves ordinary paths unchanged", () => {
    expect(sanitizeValue("/tmp/foo/bar.db")).toBe("/tmp/foo/bar.db");
  });

  it("does not itself escape double quotes — that responsibility belongs only to quoteSummaryValue()", () => {
    // sanitizeValue() strips control/format characters only; quoting
    // and backslash/quote escaping are quoteSummaryValue()'s job (it calls
    // sanitizeValue() first, then escapes). Every db-migrate.ts summary
    // field is quoted via quoteSummaryValue() today, but this locks down
    // sanitizeValue()'s own narrower contract regardless of how many
    // callers wrap it, so the two responsibilities don't blur back together.
    expect(sanitizeValue('a"b.db')).toBe('a"b.db');
  });

  it("strips Unicode line-break characters (NEL, Line Separator, Paragraph Separator), not just ASCII controls", () => {
    // \n/\r/other C0 controls aren't the only characters that can render or be
    // indexed as a line break — some terminals and log consumers treat U+0085,
    // U+2028, and U+2029 the same way, which would let them forge an apparent
    // second summary line despite not being ASCII control characters.
    const withUnicodeBreaks = `a${NEL}b${LINE_SEPARATOR}c${PARAGRAPH_SEPARATOR}d`;
    expect(sanitizeValue(withUnicodeBreaks)).toBe("a b c d");
  });

  it("strips the rest of the Unicode C1 control block (e.g. CSI, OSC), not just NEL", () => {
    // A terminal that recognizes C1 controls can have its output rewritten or
    // hidden by CSI/OSC sequences embedded in an otherwise-plain-looking
    // error message, defeating the "safe, observable one-line summary"
    // guarantee just as much as an ASCII control character would.
    const withC1Controls = `a${CSI}b${OSC}c`;
    expect(sanitizeValue(withC1Controls)).toBe("a b c");
  });

  it("strips Unicode bidirectional/format control characters (e.g. RTL override)", () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) and isolate controls are category Cf
    // (Format), not Cc (Control) — a terminal/log viewer honoring them can
    // render a summary line with its fields visually reordered or hidden,
    // the same "Trojan Source" class of spoofing bidi controls enable in
    // source code, applied here to CLI/log output instead.
    const withBidiControls = `a${RTL_OVERRIDE}b${POP_DIRECTIONAL_ISOLATE}c`;
    expect(sanitizeValue(withBidiControls)).toBe("a b c");
  });

  it("strips a real RTL override embedded in a path so it cannot visually spoof the success line", () => {
    // The concrete case Codex's review flagged: sanitizeValue preserved
    // a path with an RTL-override character embedded before ".db status=ok"
    // unchanged, letting a hostile path visually relabel what follows it.
    // Assert against db-migrate.ts's own line shape.
    const spoofedPath = `report${RTL_OVERRIDE}.db status=ok`;
    const line = `db migrate status=ok path=${sanitizeValue(spoofedPath)}`;
    expect(line).not.toContain(RTL_OVERRIDE);
    // Matches every other sanitizeValue() case: the character is
    // replaced with a space, not deleted outright.
    expect(line).toBe("db migrate status=ok path=report .db status=ok");
  });
});
