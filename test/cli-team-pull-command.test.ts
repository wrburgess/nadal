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
    // `years=""` — no `--players`, so no cascade ran and no season was fetched (#108). Asserted as
    // part of the whole anchored line rather than skipped, because the field being EMPTY here is the
    // signal that a pull without `--players` enriched nobody.
    expect(logSpy.mock.calls[0]?.[0]).toMatch(
      /^team pull status=ok team=".+" roster=18 matches=10 archived=".+" retired=0 years=""$/,
    );
  });

  // Issue #49: retirement is a data-REMOVING effect and must be visible in the command's own
  // output, not only in the database — a caller reading `roster=17` alone has no way to tell
  // "one fewer person pulled" from "this page never had that person to begin with".
  it("reports retired=N in the summary when a re-pull no longer observes a previously-pulled member", async () => {
    runMigrations();
    // Remove Ellis Eastwick's WHOLE roster row (not just the profile link) — a missing link alone
    // still leaves the person on the roster, which `test/ingest-team-pull.test.ts`'s "no profile
    // link" case already covers; this needs the person genuinely absent from the parsed roster.
    const anchor = '<a class="link" href="/adult/profile.aspx?playername=Ellis Eastwick">Ellis Eastwick</a>';
    const anchorIndex = team.html.indexOf(anchor);
    expect(anchorIndex).toBeGreaterThan(-1);
    const rowStart = team.html.lastIndexOf("<tr", anchorIndex);
    const rowEnd = team.html.indexOf("</tr>", anchorIndex) + "</tr>".length;
    const withoutEllis = team.html.slice(0, rowStart) + team.html.slice(rowEnd);
    expect(withoutEllis).not.toBe(team.html);

    let call = 0;
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: (() => {
        call += 1;
        return call === 1 ? team.html : withoutEllis;
      })(),
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["team", "pull", team.source.url]);
    const secondCode = await dispatch(["team", "pull", team.source.url]);

    expect(secondCode).toBe(0);
    const secondLine = logSpy.mock.calls[1]?.[0] as string;
    expect(secondLine).toMatch(/roster=17/);
    expect(secondLine).toMatch(/retired=1/);
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
        rosterObservedAt: null,
        rosterObservedUrl: null,
        tennisrecordUrl: null,
        isHome: null,
        nameKey: null,
        nameKeyLength: null,
      },
      rosterCount: 0,
      matchCount: 0,
      archivedPath: "raw/tennisrecord/x.html",
      skippedRosterEntries: [],
      retiredCount: 0,
      years: [],
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

  it("--from ingests a POSTSEASON team page end to end (#92)", async () => {
    // The reported failure was at the command, not only in the parser: `tn team pull` refused the
    // OK/Dickason page outright, so the HC could not scout a qualified opponent at all. Parser
    // unit tests would not have caught a fix that stopped short of the dispatch path.
    runMigrations();
    const postseason = loadFixture("tennisrecord/team-postseason");
    const raw = process.env.TN_RAW_PATH ?? "raw";
    const savedPath = join(raw, "saved-postseason-team.html");
    writeFileSync(savedPath, postseason.html, "utf8");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "team",
      "pull",
      "tr:ignored",
      "--from",
      savedPath,
      "--source-url",
      postseason.source.url,
    ]);

    expect(code).toBe(0);
    // The roster count is asserted, not just the status: a "success" that stored zero players
    // would satisfy `status=ok` and still leave the opponent unscouted.
    expect(logSpy.mock.calls[0]?.[0]).toMatch(/^team pull status=ok .*roster=18/);
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

  // Issue #108 — the `--since` surface. The service owns every rule about what a season is
  // (`cascadeYears`); these assert the flag is wired, parsed, and that a refusal reaches the operator
  // as a summary line rather than a stack trace.
  it("--since narrows the cascade to the named season and reports it", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: url === team.source.url ? team.html : "<html><body>not a match history</body></html>",
      fetchedAt: new Date().toISOString(),
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await dispatch(["team", "pull", team.source.url, "--players", "--since", "2026"]);

    const line = String(errSpy.mock.calls[0]?.[0]);
    expect(line).toContain('years="2026"');
    // One season, so one skip per roster entry — not the two the default range would produce.
    expect(line).toContain("skipped=18");
  });

  it("an out-of-range --since exits 1 with the service's refusal, not a stack trace", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "--players", "--since", "2099"]);

    expect(code).toBe(1);
    const line = String(errSpy.mock.calls[0]?.[0]);
    expect(line).toMatch(/^team pull status=error /);
    expect(line).toContain("2099");
  });

  it("a malformed --since exits 1 and names what a season looks like", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "--players", "--since", "twenty"]);

    expect(code).toBe(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("four-digit year");
  });

  // `--since` must be declared in `teamPull.valueFlags`, not merely read out of `parsed.flags`. The
  // router's target scan is value-flag-aware: an UNDECLARED `--since` would leave its value `2026`
  // looking like a positional, and the command would pull the team named "2026". Putting the flag
  // BEFORE the target is what makes the two spellings distinguishable — with the flag last, a
  // missing declaration is invisible.
  it("--since is a declared value flag, so its value is never mistaken for the target", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: url === team.source.url ? team.html : "<html><body>not a match history</body></html>",
      fetchedAt: new Date().toISOString(),
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", "--since", "2026", team.source.url, "--players"]);

    // Reached the real team page and cascaded — not an "unknown team target \"2026\"" error.
    expect(code).toBe(1); // partial: the stub serves no match history
    const line = String(errSpy.mock.calls[0]?.[0]);
    expect(line).toMatch(/^team pull status=partial /);
    expect(line).toContain('years="2026"');
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
    // 18 roster entries × 2 default seasons (#108) — a skip is per (player, season), because that is
    // the unit a retry acts on. The count is derived from the reported season list rather than
    // hardcoded, so it cannot drift out of step with the shipped default range.
    const seasons = /years="([^"]*)"/.exec(line)?.[1]?.split(",") ?? [];
    expect(seasons).toHaveLength(2);
    expect(line).toContain(`skipped=${18 * seasons.length}`);
    expect(line).toContain('skippedEntries="');
  });
});
