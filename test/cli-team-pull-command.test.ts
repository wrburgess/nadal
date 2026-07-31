import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations } from "../src/db/client.js";
import * as fetchModule from "../src/ingest/fetch.js";
import * as teamPullModule from "../src/ingest/team-pull.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const team = loadFixture("tennisrecord/team");

function requestLogRows(dbPath: string) {
  const sqlite = new Database(dbPath);
  const rows = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
  sqlite.close();
  return rows;
}

describe("tn team pull (end-to-end via dispatch)", () => {
  const dbFixture = useTnDbPath("cmd.db");
  useTnRawPath();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints exactly one status=ok summary line and exits 0", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toMatch(
      /^team pull status=ok team=".+" roster=18 matches=10 archived=".+"$/,
    );
  });

  it("round-trips a team name containing a double quote, a backslash, and a newline, un-spoofed", async () => {
    runMigrations();
    const malicious = 'Weird"Team\\Name\nstatus=error';
    vi.spyOn(teamPullModule, "pullTeam").mockResolvedValue({
      kind: "ok",
      team: {
        id: 1,
        name: malicious,
        section: null,
        district: null,
        tennislinkUrl: null,
        tennisrecordUrl: null,
        nameKey: null,
        nameKeyLength: null,
      },
      rosterCount: 0,
      matchCount: 0,
      archivedPath: "raw/tennisrecord/x.html",
      skippedRosterEntries: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", "https://www.tennisrecord.com/x"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    // The line stays single-line — a raw newline embedded in the value would otherwise split it.
    expect(printed.split("\n")).toHaveLength(1);
    // And the quoted team= field decodes back to the real value once unescaped.
    const match = /team="((?:[^"\\]|\\.)*)"/.exec(printed);
    expect(match).not.toBeNull();
    const decoded = (match?.[1] ?? "").replace(/\\(.)/g, "$1");
    expect(decoded).toBe(malicious.replace(/\n/g, " "));
  });

  it("--from ingests an archived page without calling the fetcher at all", async () => {
    runMigrations();
    const raw = process.env.TN_RAW_PATH ?? "raw";
    const savedPath = join(raw, "saved-team.html");
    writeFileSync(savedPath, team.html, "utf8");
    const fetchSpy = vi.spyOn(fetchModule, "fetchPage");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "team",
      "pull",
      "tr:ignored",
      "--from",
      savedPath,
      "--source-url",
      team.source.url,
    ]);

    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls[0]?.[0]).toMatch(/^team pull status=ok/);
  });

  it("an unknown target exits 1 with a message on stderr and writes no team row", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", "Some Team Nobody Has Pulled Before"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^team pull status=error message=".+"$/));

    const rows = new Database(dbFixture.path()).prepare("SELECT * FROM teams").all();
    expect(rows).toHaveLength(0);
  });

  it("an unrecognized flag exits 1", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", "some-target", "--bogus"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --bogus"));
  });

  it("logs a request_log row on both the ok and the error path", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await dispatch(["team", "pull", team.source.url]);
    await dispatch(["team", "pull", "--bogus-flag", "x"]);

    const rows = requestLogRows(dbFixture.path());
    const commands = rows.map((r) => r.command);
    expect(commands.filter((c) => c === "team pull")).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(["ok", "error:exit-1"]));
  });
});

// Codex adversarial review, PR #31 [high]: the team transaction commits BEFORE the --players
// cascade, so a cascade that pulls zero players still returned `ok`. The CLI discarded
// `skippedRosterEntries` entirely, so a caller reading only the exit code saw success.
describe("tn team pull --players (partial cascade)", () => {
  useTnDbPath("cmd-partial.db");
  useTnRawPath();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("REGRESSION: a cascade that fails for every roster entry reports status=partial and exits non-zero", async () => {
    runMigrations();
    // The team page parses; every cascaded player page is structurally broken, so each pullPlayer
    // returns a non-ok result and is recorded as skipped.
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: url === team.source.url ? team.html : "<html><body>not a match history</body></html>",
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "--players"]);

    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = String(errSpy.mock.calls[0]?.[0]);
    expect(line).toMatch(/^team pull status=partial /);
    expect(line).toContain("skipped=18");
    expect(line).toContain('skippedEntries="');
  });
});
