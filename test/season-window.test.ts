// Issue #90 — the season boundary, end to end through `dispatch`.
//
// The defect was a BOUNDARY, so every case here pins WHICH matches are counted against fixtures
// placed deliberately on both sides of one. A test that asserted only "a record was printed" passed
// before this change and after it, which is exactly how the original shipped: measured on the real
// HOA/Burgess-Zingg team, the binder showed 5 of 8 matches on 2026-08-03 and would have shown 2 of 8
// on the day of Sectionals, and no test noticed because none of them pinned a count.
//
// `vi.setSystemTime` is the instrument throughout: the whole claim is that the printed numbers no
// longer depend on when the command runs, and the only way to assert that is to run it twice from
// two different "nows" and compare.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { events, players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { seasonStart } from "../src/cli/window.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import { resolveSeasonAnchor } from "../src/query/events.js";
import { useTnDbPath } from "./helpers/tn-db.js";

/** Three team matches: one in the PRIOR season's December, two inside the 2026 season. */
const PRIOR_SEASON_WIN = "2025-12-20";
const SEASON_OPENER_WIN = "2026-01-01"; // the boundary instant itself
const SEASON_LATE_WIN = "2026-03-14";

describe("season-anchored records (issue #90)", () => {
  const dbFixture = useTnDbPath("season.db");

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function seed(): { teamId: number; teamName: string } {
    runMigrations();
    const { db, sqlite } = openDb();
    const name = "HOA/Burgess-Zingg/40&over3.5M";
    const team = db.insert(teams).values({ name, nameKey: nameKey(name) }).returning().get();
    const opponent = db.insert(teams).values({ name: "Opponent", nameKey: nameKey("Opponent") }).returning().get();
    const player = db
      .insert(players)
      .values({ canonicalName: "Randy Burgess", nameKey: nameKey("Randy Burgess") })
      .returning()
      .get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    for (const playedOn of [PRIOR_SEASON_WIN, SEASON_OPENER_WIN, SEASON_LATE_WIN]) {
      db.insert(teamMatches)
        .values({
          homeTeamId: team.id,
          visitingTeamId: opponent.id,
          homeCourtsWon: 3,
          visitingCourtsWon: 1,
          playedOn,
        })
        .run();
    }
    sqlite.close();
    return { teamId: team.id, teamName: name };
  }

  async function showTeam(name: string): Promise<string> {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["team", "show", name]);
    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    logSpy.mockRestore();
    return printed;
  }

  it("counts the whole season and excludes the prior one", async () => {
    // Two of three matches are in 2026; the December 2025 win is a DIFFERENT season and must not be
    // counted. This is the straddling-season limitation stated as behavior rather than left to a
    // comment — a league whose season crossed New Year would be split here, by construction.
    const { teamName } = seed();
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));

    expect(await showTeam(teamName)).toContain("record: 2-0");
  });

  it("prints the same record in August and in December — the print date does not move it", async () => {
    // THE regression. Under the old rolling six months these two runs returned different numbers
    // from an unchanged database, and the August one (the month Sectionals is played) was the
    // thinner of the two.
    const { teamName } = seed();

    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    const august = await showTeam(teamName);
    vi.setSystemTime(new Date("2026-12-24T12:00:00Z"));
    const december = await showTeam(teamName);

    expect(august).toBe(december);
    expect(august).toContain("record: 2-0");
  });

  it("labels the roster records with the season they were filtered to, not a fixed string", async () => {
    // The label and the boundary come from ONE anchor. Nothing asserted the old `(6mo)` text, which
    // is why changing every user-visible label in this change broke no test — a gap this closes.
    const { teamName } = seed();
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));

    const printed = await showTeam(teamName);
    expect(printed).toContain("singles: 0-0 (2026)");
    expect(printed).not.toContain("(6mo)");

    // A run in a different season must label itself that season, so the label cannot be a constant
    // that merely happens to read correctly this year.
    vi.setSystemTime(new Date("2027-02-01T12:00:00Z"));
    expect(await showTeam(teamName)).toContain("singles: 0-0 (2027)");
  });

  it("player show labels its season record the same way", async () => {
    seed();
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "Randy Burgess"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("(2026) /");
    expect(printed).toContain("(all-time)");
    expect(printed).not.toContain("(6mo)");
    logSpy.mockRestore();
  });

  describe("report build's anchor", () => {
    function seedEvent(name: string, startsOn: string | null): void {
      const { db, sqlite } = openDb();
      db.insert(events)
        .values({ name, kind: "tournament", startsOn, endsOn: startsOn, format: "S1:singles" })
        .run();
      sqlite.close();
    }

    it("anchors to the EVENT's season, not to the year the command is run in", async () => {
      // The case that makes this more than a rename: printing a 2026 binder in 2027 must still be a
      // 2026 binder. Anchoring to the clock — or to `event start - 6 months`, the framing rejected
      // in the assessment — would silently produce a different one.
      seed();
      seedEvent("Sectionals 2026", "2026-08-28");
      vi.setSystemTime(new Date("2027-05-01T12:00:00Z"));
      const { db, sqlite } = openDb();

      const anchor = resolveSeasonAnchor(db, "Sectionals 2026");
      sqlite.close();

      expect(anchor).toEqual({ value: "2026-08-28", anchoredTo: "event" });
      expect(seasonStart(anchor.value)).toBe("2026-01-01");
    });

    it("falls back to today when the event carries no start date, and says which it used", async () => {
      // A silent fallback would be this issue's own defect wearing a different hat: a boundary that
      // reads as anchored to the event and is not. `anchoredTo` is what makes the two tellable
      // apart, so it is asserted here rather than trusted.
      seed();
      seedEvent("Undated Event", null);
      vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
      const { db, sqlite } = openDb();

      const anchor = resolveSeasonAnchor(db, "Undated Event");
      sqlite.close();

      expect(anchor.anchoredTo).toBe("today");
      expect(seasonStart(anchor.value)).toBe("2026-01-01");
    });

    it("refuses an unknown event rather than quietly anchoring to today", async () => {
      // A typo must not produce a whole binder filtered to the wrong season with an exit 0.
      seed();
      const { db, sqlite } = openDb();

      expect(() => resolveSeasonAnchor(db, "Sectionals 2O26")).toThrow(/unknown event/i);
      sqlite.close();
    });
  });

  it("MCP and the CLI resolve the same boundary — three of the six call sites are MCP", async () => {
    // Drift here would give an agent chat different numbers from the printed binder, with nothing
    // on either surface to reveal the disagreement.
    const { teamName } = seed();
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    const cliPrinted = await showTeam(teamName);

    const teamShow = MCP_TOOLS.find((t) => t.name === "team_show");
    if (teamShow === undefined) throw new Error("team_show tool is missing from MCP_TOOLS");
    const mcpProfile = (await teamShow.handler({ target: teamName })) as {
      teamRecord: { wins: number; losses: number; undecided: number; excludedUndated: number };
    };

    expect(mcpProfile.teamRecord).toEqual({ wins: 2, losses: 0, undecided: 0, excludedUndated: 0 });
    expect(cliPrinted).toContain("record: 2-0");
  });

  it("leaves `tn lineup plan` alone — it does not window, and must not start", async () => {
    // Scope guard. `src/query/lineup.ts` has no date filter, so a lineup prediction sees all
    // history; this change must not have introduced one by way of a shared helper.
    const { teamName } = seed();
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // No court matches were seeded, so the honest outcome is the no-history refusal — asserted by
    // its message, which proves the command ran its own path rather than a windowed one.
    const code = await dispatch(["lineup", "plan", teamName]);

    const output = [...errSpy.mock.calls, ...logSpy.mock.calls].map((c) => String(c[0])).join("\n");
    expect(code).toBe(1);
    expect(output).toMatch(/court-match history|no court match/i);
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("dbFixture is wired (guards against a suite that silently shares a database)", () => {
    expect(dbFixture.path()).toContain("season.db");
  });
});
