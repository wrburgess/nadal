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

  // The plan called for this and the first cut of the PR omitted it. `--since` is a VALUE flag, so a
  // trailing `--since` with nothing after it must be a parse error — not a silently-undefined value
  // that would quietly fall back to the default range and look like it worked.
  it("--since with no value exits 1 at the parser, before any fetch", async () => {
    runMigrations();
    const fetchSpy = vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "--players", "--since"]);

    expect(code).toBe(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("--since requires a value");
    // And nothing was fetched — the refusal is at the parser, not after a wasted request.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Codex review of PR #109, rated Medium. Without `--players` there is no cascade for `--since` to
  // bound, and the service used to skip validation entirely — so `--since twenty` returned
  // `status=ok years=""` while GRAMMAR.md promised a refusal for a malformed value. Refusing names
  // the real mistake (the missing `--players`) rather than validating a value nothing would use.
  it("--since without --players is refused, not silently ignored", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "--since", "2026"]);

    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    const line = String(errSpy.mock.calls[0]?.[0]);
    expect(line).toMatch(/^team pull status=error /);
    expect(line).toContain("--players");
  });

  // The same invocation with a MALFORMED value — the case that used to return status=ok, which is
  // what made this a defect rather than a missing convenience.
  it("--since without --players is refused even when the value is malformed", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "--since", "twenty"]);

    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
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

  /**
   * Issue #98. Before this, `skipped=K skippedEntries="<names>"` said how much did not land and
   * nothing about what to do — an operator could not size a re-run without reading K stderr warnings.
   *
   * `pullTeam` is mocked here rather than driven through fixtures on purpose: these tests are about
   * the RENDERING of a mixed disposition set, and building three distinct real failures through the
   * fetch layer would put the fixture's own shape between the assertion and the line under test.
   * The classification itself is pinned end-to-end in `test/ingest-team-pull.test.ts`.
   */
  describe("the partial line says what to do about each skipped entry (#98)", () => {
    const teamRow = {
      id: 1,
      name: "Cascade Test",
      section: null,
      district: null,
      tennislinkUrl: null,
      rosterObservedAt: null,
      rosterObservedUrl: null,
      tennisrecordUrl: null,
      isHome: null,
      nameKey: null,
      nameKeyLength: null,
    };

    function mockPullWithSkipped(skippedRosterEntries: teamPullModule.SkippedRosterEntry[]): void {
      vi.spyOn(teamPullModule, "pullTeam").mockResolvedValue({
        kind: "ok",
        team: teamRow,
        rosterCount: 3,
        matchCount: 0,
        archivedPath: "raw/tennisrecord/x.html",
        skippedRosterEntries,
        retiredCount: 0,
        years: ["2026"],
      });
    }

    const MIXED: teamPullModule.SkippedRosterEntry[] = [
      { entry: "Ann Ashby (year=2026)", disposition: "retryable", reason: "fetch failed with status 503: u" },
      { entry: "Bo Byrne (year=2026)", disposition: "permanent", reason: "fetch failed with status 404: u" },
      { entry: "Cy Carrow", disposition: "permanent", reason: "roster entry has no profile link on the team page" },
      { entry: "Di Dorne (year=2026)", disposition: "unclassified", reason: "boom" },
    ];

    it("reports a count per disposition and tags every named entry", async () => {
      runMigrations();
      mockPullWithSkipped(MIXED);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["team", "pull", "https://www.tennisrecord.com/x", "--players"]);

      expect(code).toBe(1);
      const line = String(errSpy.mock.calls[0]?.[0]);
      expect(line).toMatch(/^team pull status=partial /);
      expect(line).toContain("skipped=4");
      expect(line).toContain("retryable=1");
      expect(line).toContain("permanent=2");
      expect(line).toContain("unclassified=1");
      expect(line).toContain(
        'skippedEntries="Ann Ashby (year=2026) [retryable], Bo Byrne (year=2026) [permanent], ' +
          'Cy Carrow [permanent], Di Dorne (year=2026) [unclassified]"',
      );
    });

    /**
     * The counts summarize the SAME list the line names, so a run where they disagree is a run where
     * the operator's re-run estimate is wrong. Asserted by reading both back OUT of the rendered
     * line — a test that recomputed them from `MIXED` would agree with a miscount that happened to
     * be computed the same wrong way twice.
     */
    it("the three counts sum to skipped= and match the tags actually printed", async () => {
      runMigrations();
      mockPullWithSkipped(MIXED);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await dispatch(["team", "pull", "https://www.tennisrecord.com/x", "--players"]);

      const line = String(errSpy.mock.calls[0]?.[0]);
      const read = (key: string) => Number(new RegExp(`\\b${key}=(\\d+)\\b`).exec(line)?.[1]);
      expect(read("retryable") + read("permanent") + read("unclassified")).toBe(read("skipped"));

      const entries = /skippedEntries="((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? "";
      for (const disposition of ["retryable", "permanent", "unclassified"]) {
        const tagged = entries.split(`[${disposition}]`).length - 1;
        expect(tagged, `${disposition} tags must match its count`).toBe(read(disposition));
      }
    });

    it("carries the same four fields under --json", async () => {
      runMigrations();
      mockPullWithSkipped(MIXED);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await dispatch(["team", "pull", "https://www.tennisrecord.com/x", "--players", "--json"]);

      const payload = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
      expect(payload).toMatchObject({
        status: "partial",
        skipped: 4,
        retryable: 1,
        permanent: 2,
        unclassified: 1,
      });
    });

    // The boundary that must not regress: a clean cascade is still `ok`, and none of the new fields
    // appear on it. A count that printed `retryable=0` on every successful pull would be noise on
    // the line an operator reads most often.
    it("prints none of the new fields when nothing was skipped", async () => {
      runMigrations();
      mockPullWithSkipped([]);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["team", "pull", "https://www.tennisrecord.com/x", "--players"]);

      expect(code).toBe(0);
      const line = String(logSpy.mock.calls[0]?.[0]);
      expect(line).toMatch(/^team pull status=ok /);
      for (const key of ["skipped=", "retryable=", "permanent=", "unclassified=", "skippedEntries="]) {
        expect(line, `${key} must not appear on a clean pull`).not.toContain(key);
      }
    });

    /**
     * A roster name is scraped data, so it reaches this line attacker-influenced — and #98 adds a
     * SECOND untrusted string beside it, since `reason` can quote the document a parser choked on.
     * Pinned as a whole-line equality rather than an absence-of-ESC search: "contains nothing
     * executable" is only assertable by naming the entire string (docs/findings.md).
     */
    it("sanitizes a hostile entry name in the tagged rendering", async () => {
      runMigrations();
      const ESC = String.fromCharCode(0x1b);
      const RTL_OVERRIDE = String.fromCharCode(0x202e);
      mockPullWithSkipped([
        { entry: `Ann${RTL_OVERRIDE}${ESC}[2J Ashby`, disposition: "retryable", reason: "boom" },
      ]);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await dispatch(["team", "pull", "https://www.tennisrecord.com/x", "--players"]);

      expect(String(errSpy.mock.calls[0]?.[0])).toBe(
        'team pull status=partial team="Cascade Test" roster=3 matches=0 archived="raw/tennisrecord/x.html" ' +
          'retired=0 years="2026" skipped=1 retryable=1 permanent=0 unclassified=0 ' +
          'skippedEntries="Ann  [2J Ashby [retryable]"',
      );
    });
  });
});
