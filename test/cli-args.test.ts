import { describe, expect, it } from "vitest";
import { globalFlags, parseArgs, parsePayloadArgs } from "../src/cli/args.js";

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
});
