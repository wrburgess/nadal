import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
