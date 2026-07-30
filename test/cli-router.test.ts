import { describe, expect, it, vi } from "vitest";
import { COMMANDS, dispatch, helpText } from "../src/cli/router.js";

describe("tn router", () => {
  it("helpText lists every registered command as 'noun verb — summary'", () => {
    const help = helpText();
    for (const c of COMMANDS) {
      expect(help).toContain(`${c.noun} ${c.verb}`);
    }
  });

  it("dispatch returns 2 and prints an error line for an unknown command", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["bogus", "nope"]);
    expect(code).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("bogus"));
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
});
