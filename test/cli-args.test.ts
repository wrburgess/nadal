import { describe, expect, it } from "vitest";
import { globalFlags, parseArgs, parsePayloadArgs, scanFlags } from "../src/cli/args.js";

describe("parseArgs", () => {
  it("parses a target with no flags", () => {
    const parsed = parseArgs(["some-target"], [], []);
    expect(parsed).toEqual({ target: "some-target", flags: {} });
  });

  it("still rejects a flag the command did not declare (typo protection preserved)", () => {
    const parsed = parseArgs(["target", "--bogus"], [], []);
    expect(parsed.error).toBe("unrecognized flag --bogus");
  });

  it("still requires a value for a declared value flag", () => {
    const parsed = parseArgs(["target", "--from"], [], ["from"]);
    expect(parsed.error).toBe("flag --from requires a value");
  });

  it("still parses a command-declared boolean flag", () => {
    const parsed = parseArgs(["target", "--players"], ["players"], []);
    expect(parsed).toEqual({ target: "target", flags: { players: true } });
  });

  describe("global flags — accepted by every command without being declared", () => {
    it("accepts --json without the command declaring it", () => {
      const parsed = parseArgs(["target", "--json"], [], []);
      expect(parsed).toEqual({ target: "target", flags: { json: true } });
    });

    it("accepts --quiet without the command declaring it", () => {
      const parsed = parseArgs(["target", "--quiet"], [], []);
      expect(parsed).toEqual({ target: "target", flags: { quiet: true } });
    });

    it("accepts the -q short alias for quiet", () => {
      const parsed = parseArgs(["target", "-q"], [], []);
      expect(parsed).toEqual({ target: "target", flags: { q: true } });
    });

    it("accepts --json and --quiet together, alongside a command-declared flag", () => {
      const parsed = parseArgs(["target", "--players", "--json", "--quiet"], ["players"], []);
      expect(parsed).toEqual({ target: "target", flags: { players: true, json: true, quiet: true } });
    });

    it("a genuinely unrecognized flag still errors even when global flags are also present", () => {
      const parsed = parseArgs(["target", "--json", "--bogus"], [], []);
      expect(parsed.error).toBe("unrecognized flag --bogus");
    });
  });
});

describe("parsePayloadArgs", () => {
  it("collects target plus a fixed number of payload positionals, in order", () => {
    const parsed = parsePayloadArgs(["Rowan Rushworth", "2026-08-29", "available"], 2);
    expect(parsed).toEqual({
      target: "Rowan Rushworth",
      payload: ["2026-08-29", "available"],
      flags: {},
    });
  });

  it("leaves payload short (not an error here) when fewer tokens than payloadCount are given", () => {
    const parsed = parsePayloadArgs(["Rowan Rushworth", "2026-08-29"], 2);
    expect(parsed.error).toBeUndefined();
    expect(parsed.target).toBe("Rowan Rushworth");
    expect(parsed.payload).toEqual(["2026-08-29"]);
  });

  it("errors on a token beyond target + payloadCount", () => {
    const parsed = parsePayloadArgs(["a", "b", "c", "d"], 2);
    expect(parsed.error).toBe('unexpected extra argument "d"');
  });

  it("recognizes global flags interleaved with payload positionals", () => {
    const parsed = parsePayloadArgs(["a", "--json", "b", "c"], 2);
    expect(parsed).toEqual({ target: "a", payload: ["b", "c"], flags: { json: true } });
  });

  it("still rejects an undeclared flag", () => {
    const parsed = parsePayloadArgs(["a", "b", "--bogus"], 1);
    expect(parsed.error).toBe("unrecognized flag --bogus");
  });
});

describe("globalFlags", () => {
  it("is quiet:false, json:false when neither flag is present", () => {
    expect(globalFlags({})).toEqual({ quiet: false, json: false });
  });

  it("is quiet:true when --quiet was passed", () => {
    expect(globalFlags({ quiet: true })).toEqual({ quiet: true, json: false });
  });

  it("is quiet:true when -q was passed (the q key)", () => {
    expect(globalFlags({ q: true })).toEqual({ quiet: true, json: false });
  });

  it("is json:true when --json was passed", () => {
    expect(globalFlags({ json: true })).toEqual({ quiet: false, json: true });
  });

  it("is quiet:true and json:true when both are passed (caller decides precedence, not this helper)", () => {
    expect(globalFlags({ quiet: true, json: true })).toEqual({ quiet: true, json: true });
  });
});

// Independent-reviewer finding on #17 PR A (Codex, medium, category A — reachable by the sole
// operator through ordinary use): every token beginning `--` was treated as a flag, so an ordinary
// captain note beginning `--` could not be recorded at all. `tn player note Randy "--poach at net"`
// died as `unrecognized flag --poach at net`, and both workarounds corrupt the note (leading
// whitespace changes text `addCaptainNote` deliberately stores untrimmed). Free-text payload
// commands did not exist when GRAMMAR.md wrote "there is no `--` payload terminator" — that line
// was true when written and became a defect the moment `player note` landed.
describe("`--` end-of-flags delimiter", () => {
  it("records a payload token that begins with `--`", () => {
    const parsed = parsePayloadArgs(["Randy", "--", "--poach at net"], 1);
    expect(parsed.error).toBeUndefined();
    expect(parsed.target).toBe("Randy");
    expect(parsed.payload).toEqual(["--poach at net"]);
  });

  it("treats a token that LOOKS like a known global flag as payload once after `--`", () => {
    // The whole point of the delimiter: past it, `--json` is text, not a flag.
    const parsed = parsePayloadArgs(["Randy", "--", "--json"], 1);
    expect(parsed.error).toBeUndefined();
    expect(parsed.payload).toEqual(["--json"]);
    expect(parsed.flags.json).toBeUndefined();
  });

  it("still parses global flags that appear BEFORE the delimiter", () => {
    const parsed = parsePayloadArgs(["Randy", "--json", "--", "--poach"], 1);
    expect(parsed.error).toBeUndefined();
    expect(parsed.flags.json).toBe(true);
    expect(parsed.payload).toEqual(["--poach"]);
  });

  it("a second `--` after the delimiter is payload, not another delimiter", () => {
    const parsed = parsePayloadArgs(["Randy", "--", "--"], 1);
    expect(parsed.error).toBeUndefined();
    expect(parsed.payload).toEqual(["--"]);
  });

  it("an empty payload after the delimiter is still reported as missing, not silently filled", () => {
    const parsed = parsePayloadArgs(["Randy", "--"], 1);
    expect(parsed.error).toBeUndefined();
    expect(parsed.target).toBe("Randy");
    expect(parsed.payload[0]).toBeUndefined();
  });

  it("applies to a TARGET beginning with `--` too, not only to payloads", () => {
    // Same defect one positional over — a team or player whose name begins `--`.
    const parsed = parseArgs(["--", "--Odd Team Name"], [], []);
    expect(parsed.error).toBeUndefined();
    expect(parsed.target).toBe("--Odd Team Name");
  });

  it("an unrecognized flag before the delimiter still fails (the delimiter is not a way to silence typos)", () => {
    const parsed = parsePayloadArgs(["Randy", "--typo", "--", "text"], 1);
    expect(parsed.error).toBe("unrecognized flag --typo");
  });

  // #44: `--from --` was already read by `parseArgs` as `from` taking the value `"--"` (correct
  // — a declared value flag's value is that value, never a delimiter, the same rule this whole
  // describe block already exercises one flag over). The bug was `dispatch`'s SEPARATE raw
  // `argv.indexOf("--")` scan disagreeing with this layer about which `--` was the delimiter.
  // These three pin that this layer was always right, ahead of the Task 2 refactor that makes
  // `dispatch` share this exact scan instead of re-deriving its own.
  it("#44: a `--` that is a declared value flag's value is that value, not the end-of-flags delimiter", () => {
    const parsed = parseArgs(["T", "--from", "--", "--source-url", "U"], [], ["from", "source-url"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.target).toBe("T");
    expect(parsed.flags.from).toBe("--");
    expect(parsed.flags["source-url"]).toBe("U");
  });

  it("#44: same, with the flag order swapped — `--source-url --` then `--from`", () => {
    const parsed = parseArgs(["T", "--source-url", "--", "--from", "U"], [], ["from", "source-url"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.target).toBe("T");
    expect(parsed.flags["source-url"]).toBe("--");
    expect(parsed.flags.from).toBe("U");
  });

  it("a trailing `--` as the FINAL token is still a value flag's value, not 'requires a value'", () => {
    const parsed = parseArgs(["T", "--from", "--"], [], ["from"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.flags.from).toBe("--");
  });
});

// The single scan `dispatch` (src/cli/router.ts) and `parsePositionals` both derive from, added by
// #44 so the two layers can no longer disagree about where flags end and whether `--help` was
// requested — they were previously two independent scans of the same tokens, and dispatch's scan
// did not know about value flags at all, so it read a value flag's `--`-valued argument as the
// end-of-flags delimiter.
describe("scanFlags", () => {
  it("no delimiter found: a `--` consumed as a value flag's value does not set endOfFlags", () => {
    const scan = scanFlags(["--from", "--", "x"], [], ["from"]);
    expect(scan.endOfFlags).toBe(3);
    expect(scan.helpRequested).toBe(false);
  });

  it("#44 consequence: `--help` consumed as a value flag's value is not a help request", () => {
    const scan = scanFlags(["--from", "--help"], [], ["from"]);
    expect(scan.helpRequested).toBe(false);
  });

  it("a BOOLEAN flag does not consume the next token, so a following `--` is a real delimiter", () => {
    const scan = scanFlags(["--players", "--", "--help"], ["players"], []);
    expect(scan.endOfFlags).toBe(1);
    // Past the real delimiter, "--help" is text — never visited as a flag.
    expect(scan.helpRequested).toBe(false);
  });

  it("a second `--help`, past the one consumed as a value, IS in flag position", () => {
    // Kills an implementation that scans for "--help" anywhere in the token stream (would see the
    // first one too) and one that stops walking at the first value flag (would see neither).
    const scan = scanFlags(["--from", "--help", "--help"], [], ["from"]);
    expect(scan.helpRequested).toBe(true);
  });

  // #160: the scan also answers "which output mode did the caller ask for", so `dispatch` can hand
  // `reportFatal` the right `emitSummary` opts for a command that THREW — at which point the
  // command's own parsed flags no longer exist to read. Derived from this walk rather than by
  // string-matching argv, because a value flag's value is exactly what a naive `args.includes()`
  // would misread — the #44 defect, one layer over.
  it("#160: reports --json and --quiet in flag position", () => {
    const scan = scanFlags(["x", "--json"], [], []);
    expect(scan.json).toBe(true);
    expect(scan.quiet).toBe(false);
  });

  it("#160: -q is the short spelling of --quiet, reconciled here as globalFlags does", () => {
    const scan = scanFlags(["x", "-q"], [], []);
    expect(scan.quiet).toBe(true);
    expect(scanFlags(["x", "--quiet"], [], []).quiet).toBe(true);
  });

  it("#160: --json consumed as a value flag's VALUE is not an output-mode request", () => {
    // The #44 class, applied to the new fields: `--from --json` means "from, whose value is the
    // literal string --json", not "JSON output". An implementation using args.includes("--json")
    // passes every other test in this block and fails this one.
    const scan = scanFlags(["--from", "--json"], [], ["from"]);
    expect(scan.json).toBe(false);
  });

  it("#160: --json past a real end-of-flags delimiter is text, not a flag", () => {
    const scan = scanFlags(["--players", "--", "--json"], ["players"], []);
    expect(scan.json).toBe(false);
  });

  it("precedence: a name declared as BOTH boolean and value classifies as boolean, matching parseArgs", () => {
    const scanned = scanFlags(["--dual", "--"], ["dual"], ["dual"]);
    // Boolean flags never consume — so the following "--" is visited and IS the delimiter.
    expect(scanned.endOfFlags).toBe(1);

    const parsed = parseArgs(["--dual", "--"], ["dual"], ["dual"]);
    expect(parsed.flags.dual).toBe(true);
    expect(parsed.target).toBeUndefined(); // nothing follows the delimiter
    expect(parsed.error).toBeUndefined();
  });
});
