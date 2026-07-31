import { afterEach, describe, expect, it, vi } from "vitest";
import { emitJson, emitSummary, sanitizeJson } from "../src/cli/emit.js";

describe("emitSummary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("status=ok prints a deterministic key=value line to stdout: status bare, strings quoted, numbers bare", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    emitSummary("team pull", "ok", [
      ["team", "Norbury"],
      ["roster", 18],
      ["matches", 10],
      ["archived", "raw/tennisrecord/x.html"],
    ]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      'team pull status=ok team="Norbury" roster=18 matches=10 archived="raw/tennisrecord/x.html"',
    );
  });

  it("a non-ok status (error, partial, ...) prints to stderr, not stdout", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    emitSummary("team pull", "error", [["message", "missing target"]]);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('team pull status=error message="missing target"');
  });

  it("quotes a string field containing a double quote, a backslash, and a space — un-spoofed", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emitSummary("player pull", "ok", [["player", 'Weird"Player\\Name']]);

    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed.split("\n")).toHaveLength(1);
    const match = /player="((?:[^"\\]|\\.)*)"/.exec(printed);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? "").replace(/\\(.)/g, "$1")).toBe('Weird"Player\\Name');
  });

  it("--quiet suppresses the stdout (status=ok) line entirely", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emitSummary("team pull", "ok", [["team", "Norbury"]], { quiet: true });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("--quiet does NOT suppress a non-ok status: exit-code-relevant stderr stays visible", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    emitSummary("team pull", "error", [["message", "boom"]], { quiet: true });

    expect(errorSpy).toHaveBeenCalledWith('team pull status=error message="boom"');
  });

  it("--json emits JSON.stringify of status + fields instead of the summary line", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emitSummary(
      "team pull",
      "ok",
      [
        ["team", "Norbury"],
        ["roster", 18],
      ],
      { json: true },
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(printed)).not.toThrow();
    expect(JSON.parse(printed)).toEqual({ status: "ok", team: "Norbury", roster: 18 });
  });

  it("--json round-trips a value containing a literal double quote without CLI-style double-escaping", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emitSummary("player pull", "ok", [["player", 'Weird"Player\\Name']], { json: true });

    const printed = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed) as { player: string };
    expect(parsed.player).toBe('Weird"Player\\Name');
  });

  it("--quiet wins when both --quiet and --json are passed on the stdout path", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emitSummary("team pull", "ok", [["team", "Norbury"]], { quiet: true, json: true });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("sanitizes control characters out of a string field in both line and json modes", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const withControlChar = "line1\rline2";

    emitSummary("team pull", "ok", [["team", withControlChar]]);
    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("\r");

    logSpy.mockClear();
    emitSummary("team pull", "ok", [["team", withControlChar]], { json: true });
    const json = logSpy.mock.calls[0]?.[0] as string;
    expect(json).not.toContain("\r");
  });
});


// Found by the independent Codex review of PR #47 (rated medium). `emitSummary`'s `--json` payload
// has been sanitized since PR A, but the three commands that dump a whole profile object
// (`team show`, `player show`, `lineup plan`) called `JSON.stringify` directly and bypassed it.
// `JSON.stringify` escapes the C0 controls and leaves category-Cf characters — notably
// RIGHT-TO-LEFT OVERRIDE — completely intact, so a scraped name carrying one reached the terminal
// unchanged.
describe("emitJson — the --json path is sanitized too, not just the summary line", () => {
  // Built from character codes so this source file contains no literal escape sequence, matching
  // the reasoning src/sanitize.ts records for its own constants.
  const ESC = String.fromCharCode(0x1b);
  const RTL_OVERRIDE = String.fromCharCode(0x202e);
  const LINE_SEPARATOR = String.fromCharCode(0x2028);

  it("strips a bidi override that JSON.stringify would have passed straight through", () => {
    const hostile = { canonicalName: `Dan${RTL_OVERRIDE}Kestrel` };

    // The gap, stated as an assertion so it cannot silently close or reopen unnoticed.
    expect(JSON.stringify(hostile)).toContain(RTL_OVERRIDE);
    expect(emitJson(hostile)).not.toContain(RTL_OVERRIDE);
  });

  it("strips U+2028, which JSON.stringify also leaves intact", () => {
    expect(JSON.stringify({ n: LINE_SEPARATOR })).toContain(LINE_SEPARATOR);
    expect(emitJson({ n: LINE_SEPARATOR })).not.toContain(LINE_SEPARATOR);
  });

  it("strips an ANSI escape from a nested array of objects, at any depth", () => {
    const plan = {
      teamName: `Team${ESC}[2J`,
      slots: [{ slot: "S1", players: [{ playerId: 1, canonicalName: `Ada${RTL_OVERRIDE}Ashby` }] }],
    };
    const out = emitJson(plan);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(RTL_OVERRIDE);
    // Still valid, still parseable, still the same shape — sanitizing is not mangling.
    const parsed = JSON.parse(out) as typeof plan;
    expect(parsed.slots[0]!.players[0]!.playerId).toBe(1);
    expect(parsed.slots[0]!.players[0]!.canonicalName.startsWith("Ada")).toBe(true);
  });

  it("leaves ordinary values — including non-ASCII, numbers, booleans and null — untouched", () => {
    const payload = { name: "Élodie Örström", count: 12, ok: true, missing: null, list: ["a", "b"] };
    expect(JSON.parse(emitJson(payload))).toEqual(payload);
  });

  it("sanitizeJson does not turn an array into an object", () => {
    expect(Array.isArray(sanitizeJson(["a", "b"]))).toBe(true);
  });
});
