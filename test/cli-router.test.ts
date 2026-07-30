import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  describe("--help trailing a command", () => {
    const original = process.env.TN_DB_PATH;

    beforeEach(() => {
      process.env.TN_DB_PATH = join(mkdtempSync(join(tmpdir(), "tn-")), "help-guard.db");
    });

    afterEach(() => {
      if (original === undefined) delete process.env.TN_DB_PATH;
      else process.env.TN_DB_PATH = original;
    });

    it("prints help and returns 0 instead of running the command's side effects", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = await dispatch(["db", "migrate", "--help"]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(helpText());
      // The command must not have run: no db file created at TN_DB_PATH.
      expect(existsSync(process.env.TN_DB_PATH!)).toBe(false);
      logSpy.mockRestore();
    });
  });
});
