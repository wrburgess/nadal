import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, dispatch, helpText } from "../src/cli/router.js";
import { runMigrations } from "../src/db/client.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("tn router", () => {
  it("helpText lists every registered command as 'noun verb — summary'", () => {
    const help = helpText();
    for (const c of COMMANDS) {
      expect(help).toContain(`${c.noun} ${c.verb}`);
    }
  });

  it("helpText aligns the command column so every summary starts at the same character position, even though registered commands have differently-sized noun+verb pairs (spec § Interfaces: help fits one screen)", () => {
    const help = helpText();
    const lines = help.split("\n").filter((l) => l.startsWith("  tn "));
    expect(lines.length).toBe(COMMANDS.length);
    // The real registry already mixes short ("db migrate") and long ("report build", "player show")
    // noun+verb pairs — padding only the verb (the old bug) misaligns every row whose NOUN differs
    // in length, which every one of these does. No fixture needed to exercise the failure mode.
    const summaryStarts = COMMANDS.map((c) => {
      const line = lines.find((l) => l.includes(`tn ${c.noun} ${c.verb}`));
      expect(line, `no help line found for tn ${c.noun} ${c.verb}`).toBeDefined();
      return line!.indexOf(c.summary);
    });
    expect(new Set(summaryStarts).size).toBe(1);
  });

  it("dispatch returns 2 and prints an error line for an unknown command", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["bogus", "nope"]);
    expect(code).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("bogus"));
    errorSpy.mockRestore();
  });

  it("prints the exact unknown-command message for a two-word command, with no stray space", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["bogus", "nope"]);
    expect(code).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith('error: unknown command "tn bogus nope". Run tn --help');
    errorSpy.mockRestore();
  });

  it("prints the exact unknown-command message for a bare one-word noun, with no stray space before the closing quote", async () => {
    // `tn db` alone: verb is undefined, so the un-trimmed template would read `"tn db ".` — a
    // trim() applied to the whole string (as it was) can't remove that interior space since the
    // string doesn't end in whitespace; only trimming the `${noun} ${verb ?? ""}` piece itself
    // before it's embedded in the quotes does.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["db"]);
    expect(code).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith('error: unknown command "tn db". Run tn --help');
    errorSpy.mockRestore();
  });

  it("dispatch of --help returns 0", async () => {
    const code = await dispatch(["--help"]);
    expect(code).toBe(0);
  });

  it("has no duplicate noun+verb spellings", () => {
    const keys = COMMANDS.map((c) => `${c.noun} ${c.verb}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe("--help trailing a command", () => {
    const fixture = useTnDbPath("help-guard.db");

    it("prints help and returns 0 instead of running the command's side effects", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = await dispatch(["db", "migrate", "--help"]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(helpText());
      // The command must not have run: no db file created at TN_DB_PATH.
      expect(existsSync(fixture.path())).toBe(false);
      logSpy.mockRestore();
    });
  });

  describe("dispatch telemetry wiring", () => {
    const fixture = useTnDbPath("telemetry.db");

    beforeEach(() => {
      runMigrations(fixture.path());
    });

    function requestLogRows() {
      const sqlite = new Database(fixture.path());
      const r = sqlite.prepare("SELECT * FROM request_log ORDER BY id").all() as Array<
        Record<string, unknown>
      >;
      sqlite.close();
      return r;
    }

    it("a real dispatch is captured in request_log — this is the only test that would catch dispatch() forgetting to wrap cmd.run() in logRequest()", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const codeOne = await dispatch(["db", "migrate"]);
        expect(codeOne).toBe(0);
        const codeTwo = await dispatch(["db", "migrate", "--quiet"]);
        expect(codeTwo).toBe(0);
      } finally {
        logSpy.mockRestore();
      }

      const rows = requestLogRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ surface: "cli", command: "db migrate", outcome: "ok" });
      expect(rows[1]).toMatchObject({ surface: "cli", command: "db migrate", outcome: "ok" });
      expect(JSON.parse(String(rows[0]?.args))).toEqual([]);
      expect(JSON.parse(String(rows[1]?.args))).toEqual(["--quiet"]);
    });
  });
});

// #44: `dispatch`'s own `argv.indexOf("--")` scan disagreed with the command parser's stateful
// scan about which `--` ends the flag region, so a `--` consumed as `--from`'s value looked like
// the end-of-flags delimiter to `dispatch` only — suppressing a `--help` that came after it. The
// headline regression: `tn player pull usta:1234 --from -- --source-url https://x --help` exited 1
// with "unrecognized flag --help" instead of printing help.
describe("dispatch and a command's declared value flags (#44)", () => {
  const fixture = useTnDbPath("value-flag-help.db");

  beforeEach(() => {
    runMigrations(fixture.path());
  });

  function requestLogRows() {
    const sqlite = new Database(fixture.path());
    const rows = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
    sqlite.close();
    return rows;
  }

  it("REGRESSION: `--from --` no longer swallows a trailing --help into 'unrecognized flag'", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch([
      "player",
      "pull",
      "usta:1234",
      "--from",
      "--",
      "--source-url",
      "https://example.com",
      "--help",
    ]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(helpText());
    // The command never ran — no telemetry row for an invocation that was actually a help request.
    expect(requestLogRows()).toHaveLength(0);
    logSpy.mockRestore();
  });

  it.each([
    ["player", "pull", "from"],
    ["player", "pull", "source-url"],
    ["team", "pull", "from"],
    ["team", "pull", "source-url"],
  ])("%s %s: `--%s --` still reaches a trailing --help past the consumed `--`", async (noun, verb, consumedFlag) => {
    const otherFlag = consumedFlag === "from" ? "source-url" : "from";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch([
      noun,
      verb,
      "some-target",
      `--${consumedFlag}`,
      "--",
      `--${otherFlag}`,
      "value",
      "--help",
    ]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(helpText());
    expect(requestLogRows()).toHaveLength(0);
    logSpy.mockRestore();
  });

  it("consequence: `--from --help` no longer prints help — --help becomes --from's value, so the command runs and fails on the pairing rule instead", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["player", "pull", "some-target", "--from", "--help"]);
    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--from requires --source-url"));
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// Risks & Considerations (plan): "Ordering inversion (highest)." Resolution now precedes the help
// check in `dispatch`, so these pin the UNRESOLVED path specifically — written before the Task 3
// reorder, not after, since that is exactly the failure mode a reorder could introduce silently.
describe("dispatch's unresolved-command path still honors --help (#44 ordering-inversion guard)", () => {
  it("dispatch([]) — a bare 'tn' with no arguments at all — prints help and returns 0", async () => {
    // #44 Task 3 split this off dispatch's old single `argv.length === 0 || beforeTerminator...`
    // condition into its own early return; every OTHER case of that condition already had test
    // coverage via some `--help` invocation, but none ever called dispatch with a truly empty
    // argv, so this specific branch went uncovered by the split until this test.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch([]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(helpText());
    logSpy.mockRestore();
  });

  it("dispatch(['--help']) prints help and returns 0", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["--help"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(helpText());
    logSpy.mockRestore();
  });

  it("dispatch(['player', '--help']) prints help and returns 0 — an unresolved noun+verb pair ('player' + '--help'), not the 'player pull' command", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["player", "--help"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(helpText());
    logSpy.mockRestore();
  });

  it("dispatch(['bogus', 'nope', '--help']) prints help and returns 0 — NOT the exit-2 unknown-command diagnostic", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["bogus", "nope", "--help"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(helpText());
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("dispatch(['--', 'player', 'note', 'X']) is still exit 2 unknown-command (noun '--') — pins the index basis dispatch reads argv at", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["--", "player", "note", "X"]);
    expect(code).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
    errorSpy.mockRestore();
  });
});

// #44 Task 6: registry-wide guards, derived from `COMMANDS` rather than hand-listing each command,
// so a command registered tomorrow is covered without anyone remembering to add a case here.
describe("registry-wide: --help reachability for every registered command (#44)", () => {
  // Called at describe scope, not inside the `it.each` callback: `useTnDbPath` registers its own
  // `beforeEach`/`afterEach` (vitest hooks are collection-time registrations, not something a
  // running test can call), and its `beforeEach` re-runs before EACH of the 12 parameterized
  // cases below, so every case still gets its own fresh mkdtemp path.
  const fixture = useTnDbPath("help-reachability.db");

  it.each(COMMANDS.map((c) => [c.noun, c.verb] as const))(
    "tn %s %s --help prints help, returns 0, and touches no DB file",
    async (noun, verb) => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = await dispatch([noun, verb, "--help"]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(helpText());
      expect(existsSync(fixture.path())).toBe(false);
      logSpy.mockRestore();
    },
  );
});

describe("registry-wide: dispatch's --help scan is value-flag-aware for EVERY declared value flag (#44)", () => {
  // What this guarantees: for every value flag any registered command declares, `dispatch` consumes
  // that flag's `--`-valued argument rather than reading it as the end-of-flags delimiter. Derived
  // from the registry, so a NEW value flag added to any command tomorrow is covered without editing
  // this test — which is the whole reason it exists alongside the hand-written 4-case matrix above.
  //
  // What it does NOT guarantee, stated because the honest limit matters more than the reassuring
  // claim: it does not detect drift between `cmd.valueFlags` and the list `run` actually passes to
  // `parseArgs`. Its cases are derived from `cmd.valueFlags`, so a flag dropped from that field
  // simply stops generating a case (silently), and a flag present there but missing from `run`'s
  // list still passes, because `dispatch` prints help and returns before the command ever parses.
  // Verified by mutation, not assumed: dropping `source-url` from `player pull`'s `parseArgs` call
  // leaves all 39 tests in this file green and fails `cli-player-pull-command.test.ts` instead.
  //
  // Drift is prevented STRUCTURALLY rather than detected here — each command's `run` reads the
  // declaration back off its own `Command` object (`playerPull.valueFlags ?? []`), so there is one
  // list, not two — and each command's own tests cover the flag actually working. A future command
  // that hardcodes its lists inline instead would reopen that gap, and this test would not see it.
  const cases = COMMANDS.flatMap((c) => (c.valueFlags ?? []).map((flag) => [c.noun, c.verb, flag] as const));

  it.each(cases)("tn %s %s --%s -- --help still prints help (declared value flag consumes the `--`, not a delimiter)", async (noun, verb, flag) => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch([noun, verb, "some-target", `--${flag}`, "--", "--help"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(helpText());
    logSpy.mockRestore();
  });
});

describe("registry-wide: flag-declaration invariants dispatch's scan depends on (#44)", () => {
  it("booleanFlags and valueFlags never overlap on any registered command", () => {
    for (const c of COMMANDS) {
      const overlap = (c.booleanFlags ?? []).filter((f) => (c.valueFlags ?? []).includes(f));
      expect(overlap, `tn ${c.noun} ${c.verb} declares ${JSON.stringify(overlap)} as both boolean and value`).toEqual(
        [],
      );
    }
  });

  // `help` is RESERVED, and until this test that was enforced only by a comment in args.ts and by
  // nobody having tried it. Traced by the independent Codex review (round 2) of this PR: declaring
  // it reopens #44's exact divergence for that one name, because `scanFlags` sets `helpRequested`
  // from the token BEFORE `classifyFlag` sees it. With `valueFlags: ["help"]`,
  // `scanFlags(["--help","v"], [], ["help"])` reports help requested AND consumes `v`, so
  // `dispatch` prints help and exits 0 — while `parseArgs` on the same tokens stores
  // `flags.help === "v"` and would have run the command. Two layers, one token, different answers:
  // the thing this whole PR exists to make impossible.
  //
  // Guarded as a registry invariant rather than a runtime check because `COMMANDS` is static — the
  // only way to declare it is to edit a command module, and this fails the moment someone does.
  // The fix if it is ever genuinely wanted is to reserve the name in `scanFlags` explicitly, not to
  // delete this test.
  //
  // Scope, stated exactly: this asserts ONE thing — that no entry in any registered command's
  // `booleanFlags`/`valueFlags` is named `help`. It does not assert anything about dispatch's
  // runtime behavior, and "dispatch owns `--help`" would be too wide a claim to attach to it:
  // dispatch intercepts `--help` only in FLAG position, so a `--help` past the delimiter
  // (`tn player note Randy -- --help`, a recorded note) or consumed as a declared value flag's
  // value (`tn player pull X --from --help`) reaches the parser as ordinary data, by design.
  // Narrowed after the independent Codex review (round 3) flagged the original title as claiming
  // more than the assertion enforces — the same overclaim this PR already corrected once.
  it("no registered command declares a flag named `help`", () => {
    for (const c of COMMANDS) {
      const declared = [...(c.booleanFlags ?? []), ...(c.valueFlags ?? [])];
      expect(declared, `tn ${c.noun} ${c.verb} declares a flag named \`help\`, which dispatch intercepts`).not.toContain(
        "help",
      );
    }
  });
});

// Found by the independent Codex review of PR #47 (rated medium). This diagnostic runs BEFORE any
// command is resolved, so no command formatter exists to sanitize it — which made it the last
// unguarded terminal sink in the codebase, echoing raw argv straight to stderr.
describe("dispatch's unknown-command diagnostic is sanitized", () => {
  const ESC = String.fromCharCode(0x1b);
  const RTL_OVERRIDE = String.fromCharCode(0x202e);

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["an ANSI escape", `bo${ESC}[2Jgus`],
    ["a bidi override", `bo${RTL_OVERRIDE}gus`],
  ])("strips %s from the echoed command", async (_label, hostile) => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch([hostile, "verb"]);

    expect(code).toBe(2);
    const line = errSpy.mock.calls.at(-1)?.[0] as string;
    expect(line).not.toContain(ESC);
    expect(line).not.toContain(RTL_OVERRIDE);
    // Still names what the caller typed, just neutralized — the diagnostic stays useful.
    expect(line).toContain("bo");
    expect(line).toContain("Run tn --help");
  });
});
