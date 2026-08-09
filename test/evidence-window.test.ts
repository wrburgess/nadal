// Issue #122 — the evidence window, end to end through `dispatch` and the real `MCP_TOOLS` table.
// This file supersedes `test/season-window.test.ts` (issue #90): every one of that file's 12 cases
// is mapped below to its successor property or a stated reason it no longer applies — see the PR
// body's mapping table for the same list in prose. None were deleted outright.
//
// The defect was a BOUNDARY, so every case here still pins WHICH matches are counted against
// fixtures placed deliberately on both sides of one — the discipline #90 introduced and #122 keeps.
// `vi.setSystemTime` is the instrument throughout: several claims here are specifically about the
// printed numbers NOT depending on when the command runs, and the only way to assert that is to run
// a command twice from two different "nows" and compare.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { events, players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { windowStart } from "../src/cli/window.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import { encodeEventFormat } from "../src/query/event-format.js";
import { windowAnchorFor } from "../src/query/events.js";
import { resolveEvent } from "../src/query/lineup.js";
import { useTnDbPath } from "./helpers/tn-db.js";

/** Four team matches spanning both sides of the 12-month bound for anchor `2026-08-28` (the
 * Springfield date, `since` = `2025-08-28`): one just OUTSIDE it, one ON it, and two comfortably
 * inside — the shape the issue's own measurement found on IA/Versteeg (four 2025 matches, two 2026
 * matches, all of which the old calendar-year boundary should have kept together and did not). */
const JUST_OUTSIDE = "2025-08-27"; // one day before `since` — excluded
const ON_BOUND = "2025-08-28"; // exactly `since` — included (inclusive lower bound)
const MID_WINDOW = "2026-01-01";
const RECENT = "2026-06-01";

function toolHandler(name: string) {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`${name} tool is missing from MCP_TOOLS`);
  return tool.handler;
}

describe("the 12-month evidence window (issue #122, superseding #90's calendar-year season)", () => {
  const dbFixture = useTnDbPath("evidence-window.db");
  let reportsDir: string;
  const originalReportsPath = process.env.TN_REPORTS_PATH;

  beforeEach(() => {
    vi.useFakeTimers();
    // `report build` writes real files under `TN_REPORTS_PATH` — redirected to a throwaway temp
    // dir so this suite never touches the repo's own `reports/` directory (test/helpers/tn-db.js's
    // absolute-path discipline, applied to the reports root the same way it applies to the DB).
    reportsDir = mkdtempSync(join(tmpdir(), "tn-reports-evidence-window-"));
    process.env.TN_REPORTS_PATH = reportsDir;
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalReportsPath === undefined) delete process.env.TN_REPORTS_PATH;
    else process.env.TN_REPORTS_PATH = originalReportsPath;
    rmSync(reportsDir, { recursive: true, force: true });
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
    for (const playedOn of [JUST_OUTSIDE, ON_BOUND, MID_WINDOW, RECENT]) {
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

  function seedEvent(name: string, startsOn: string | null): void {
    const { db, sqlite } = openDb();
    db.insert(events)
      .values({
        name,
        kind: "tournament",
        startsOn,
        endsOn: startsOn,
        format: encodeEventFormat([{ slot: "S1", discipline: "singles" }]),
      })
      .run();
    sqlite.close();
  }

  async function showTeam(name: string, eventName?: string): Promise<string> {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(eventName === undefined ? ["team", "show", name] : ["team", "show", name, eventName]);
    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    logSpy.mockRestore();
    return printed;
  }

  // Maps old case #1 ("counts the whole season and excludes the prior one") AND the Testing
  // Strategy's "a fixture set where the window boundary falls between two of one team's matches
  // (the IA/Versteeg shape)". The OLD assertion was that a calendar-year boundary excluded evidence
  // from a different year — that was #90's fix, and it is exactly the axis #122 measured wrong: the
  // successor property is RECENCY, not calendar-year membership, so a match from "the prior year"
  // now counts as long as it is within the trailing 12 months, and only evidence actually older than
  // that is excluded.
  it("counts evidence within the trailing 12 months, across a calendar-year boundary — excludes only what is actually older than that (the IA/Versteeg shape)", async () => {
    const { teamName } = seed();
    seedEvent("Sectionals 2026", "2026-08-28");
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));

    // 3 of 4 matches are within the trailing 12 months (ON_BOUND, MID_WINDOW, RECENT); JUST_OUTSIDE
    // is the one day short of it. Under the OLD calendar-year boundary this same fixture would have
    // read 2-0 (only MID_WINDOW and RECENT, both 2026) — the exact undercount the issue measured.
    expect(await showTeam(teamName, "Sectionals 2026")).toContain("record: 3-0");
  });

  // NEW case (boundary precision — no old-suite predecessor; old case #7, the unknown-event
  // refusal, is mapped in the "report build's anchor" describe below). The inclusive-bound behavior
  // itself is unit-tested exhaustively in test/cli-window.test.ts and test/query-derive.test.ts;
  // this is the integration pin that the exclusion actually reaches the printed record.
  it("a match exactly one day before the bound is excluded from the printed record", async () => {
    const { teamId, teamName } = seed();
    seedEvent("Sectionals 2026", "2026-08-28");
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    void teamId;

    const printed = await showTeam(teamName, "Sectionals 2026");
    expect(printed).toContain("record: 3-0");
    expect(printed).not.toContain("record: 4-0");
  });

  // Maps old case #2 ("prints the same record in August and in December") and old case #3 ("labels
  // the roster records with the season they were filtered to"), REWRITTEN per the plan's design
  // decision 6: an event-LESS `team show` is now a named semantic change — a SLIDING 12-month
  // window from today, not a fixed season. The old invariance claim no longer holds for THIS path;
  // the new truth is that the window (and its printed label) follow the clock, and the page says so.
  it("team show, event-less: the window SLIDES with the clock — August and December differ, and the label says which window was used", async () => {
    const { teamName } = seed();

    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    const august = await showTeam(teamName);
    vi.setSystemTime(new Date("2026-12-24T12:00:00Z"));
    const december = await showTeam(teamName);

    // August: since = 2025-08-28, so JUST_OUTSIDE (2025-08-27) is excluded -> 3-0.
    expect(august).toContain("record: 3-0");
    expect(august).toContain("(12mo to 2026-08-28)");
    // December: since = 2025-12-24, so ON_BOUND and JUST_OUTSIDE are BOTH excluded, only
    // MID_WINDOW and RECENT survive -> 2-0. The two runs must differ — the opposite of #90's
    // invariance claim, and exactly what design decision 6 names as the new, disclosed truth.
    expect(december).toContain("record: 2-0");
    expect(december).toContain("(12mo to 2026-12-24)");
    expect(august).not.toBe(december);
  });

  // Maps old case #2's OTHER half: #90's no-drift-with-print-date property is NOT abandoned, only
  // narrowed to where it was actually earned — an EVENT-anchored read. `report build` always
  // resolves an anchor (event or today) rather than reading the clock directly the way event-less
  // `team show` now does, so it stays print-date invariant regardless of when it is run.
  it("report build stays print-date invariant when anchored to a named event", async () => {
    seed();
    seedEvent("Sectionals 2026", "2026-08-28");

    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    const logSpyA = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const codeA = await dispatch(["report", "build", "sectionals", "Sectionals 2026"]);
    const printedA = logSpyA.mock.calls[0]?.[0] as string;
    logSpyA.mockRestore();

    vi.setSystemTime(new Date("2026-12-24T12:00:00Z"));
    const logSpyB = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const codeB = await dispatch(["report", "build", "sectionals", "Sectionals 2026"]);
    const printedB = logSpyB.mock.calls[0]?.[0] as string;
    logSpyB.mockRestore();

    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    expect(printedA).toContain('since="2025-08-28"');
    expect(printedB).toContain('since="2025-08-28"');
  });

  // Maps design decision 5's own named target: `team show <team> <event>` is ALSO print-date
  // invariant, because it now anchors to the already-resolved event's `starts_on` rather than
  // ignoring its `[event]` argument for windowing the way it used to.
  it("team show <team> <event> stays print-date invariant — the named defect design decision 5 fixes", async () => {
    const { teamName } = seed();
    seedEvent("Sectionals 2026", "2026-08-28");

    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    const august = await showTeam(teamName, "Sectionals 2026");
    vi.setSystemTime(new Date("2027-05-01T12:00:00Z"));
    const nextYear = await showTeam(teamName, "Sectionals 2026");

    expect(august).toBe(nextYear);
    expect(august).toContain("record: 3-0");
    expect(august).toContain("(12mo to 2026-08-28)");
  });

  // Maps old case #4 ("player show labels its season record the same way"), relabeled for the new
  // window and reusing the SAME event-anchored fixture as the case above, so the assertion is that
  // an event named for `player show` reaches the SAME anchor `team show` does — not merely that
  // SOME label is printed.
  it("player show labels its windowed record with the window label, event-anchored the same way team show is", async () => {
    seed();
    seedEvent("Sectionals 2026", "2026-08-28");
    vi.setSystemTime(new Date("2027-05-01T12:00:00Z")); // far from the event on purpose
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "Randy Burgess", "Sectionals 2026"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("(12mo to 2026-08-28) /");
    expect(printed).toContain("(all-time)");
    logSpy.mockRestore();
  });

  // Maps old describe block "report build's anchor" (old cases #5, #6, #7). Round-1 Finding 3
  // (#122 review) split `resolveWindowAnchor` in two: `resolveEvent` (the ONE read of the `events`
  // row, shared with format/scope/roster) and `windowAnchorFor` (a PURE function over that
  // already-resolved event) — closing the double-read that used to let the window come from one
  // snapshot and the format/scope/roster come from another.
  describe("report build's anchor", () => {
    it("anchors to the EVENT's starts_on, not to the year the command is run in", async () => {
      seed();
      seedEvent("Sectionals 2026", "2026-08-28");
      vi.setSystemTime(new Date("2027-05-01T12:00:00Z"));
      const { db, sqlite } = openDb();

      const event = resolveEvent(db, "Sectionals 2026");
      const anchor = windowAnchorFor(event);
      sqlite.close();

      expect(anchor).toEqual({ value: "2026-08-28", anchoredTo: "event" });
      expect(windowStart(anchor.value)).toBe("2025-08-28");
    });

    it("falls back to today when the event carries no start date, and says which it used", async () => {
      seed();
      seedEvent("Undated Event", null);
      vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
      const { db, sqlite } = openDb();

      const event = resolveEvent(db, "Undated Event");
      const anchor = windowAnchorFor(event);
      sqlite.close();

      expect(anchor.anchoredTo).toBe("today");
      expect(windowStart(anchor.value)).toBe("2025-08-03");
    });

    // The unknown-event refusal moved to `resolveEvent` at the command boundary (round-1 Finding 3):
    // `windowAnchorFor` is now pure over an already-resolved event and cannot itself look anything
    // up, let alone refuse a bad name — so this is asserted END TO END through `dispatch` rather
    // than against a helper that no longer has the means to throw it.
    it("refuses an unknown event rather than quietly anchoring to today", async () => {
      seed();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "sectionals", "Sectionals 2O26"]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown event"));
      // The refusal happens before any dossier is prepared — nothing lands on disk.
      expect(existsSync(join(reportsDir, "index.html"))).toBe(false);
      errSpy.mockRestore();
    });
  });

  // Maps old case #8 ("MCP and the CLI resolve the same boundary").
  it("MCP and the CLI resolve the same boundary — three of the six call sites are MCP", async () => {
    const { teamName } = seed();
    seedEvent("Sectionals 2026", "2026-08-28");
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    const cliPrinted = await showTeam(teamName, "Sectionals 2026");

    const mcpProfile = (await toolHandler("team_show")({ target: teamName, event: "Sectionals 2026" })) as {
      teamRecord: { wins: number; losses: number; undecided: number; excludedUndated: number };
      evidenceWindow: { anchorDay: string; since: string; label: string };
    };

    expect(mcpProfile.teamRecord).toEqual({ wins: 3, losses: 0, undecided: 0, excludedUndated: 0 });
    expect(cliPrinted).toContain("record: 3-0");
    // Round-1 Finding 1 (#122 review): `team_show`/`player_show` (and CLI `--json`) used to return a
    // WINDOWED profile with no value explaining the boundary it was windowed to — a caller couldn't
    // tell one window from another without a second, out-of-band CLI call. `evidenceWindow` is the
    // disclosure, copied from the SAME validated snapshot the query filtered by.
    expect(mcpProfile.evidenceWindow).toEqual({
      anchorDay: "2026-08-28",
      since: "2025-08-28",
      label: "12mo to 2026-08-28",
    });
  });

  // Round-1 Finding 1 (#122 review), the reviewer's own trace: call `team_show` against the SAME DB
  // at two different clock times with no event named — the two calls generate different bounds and
  // therefore different records, but (before this fix) both payloads carried only `windowed` records
  // with nothing that explained either boundary. `evidenceWindow.since` is the value that makes the
  // difference legible instead of merely observable.
  it("MCP team_show, event-less: two different clock times return two different records AND two different evidenceWindow.since values", async () => {
    const { teamName } = seed();

    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    const august = (await toolHandler("team_show")({ target: teamName })) as {
      teamRecord: { wins: number; losses: number };
      evidenceWindow: { anchorDay: string; since: string; label: string };
    };

    vi.setSystemTime(new Date("2026-12-24T12:00:00Z"));
    const december = (await toolHandler("team_show")({ target: teamName })) as {
      teamRecord: { wins: number; losses: number };
      evidenceWindow: { anchorDay: string; since: string; label: string };
    };

    // August: since = 2025-08-28, so JUST_OUTSIDE (2025-08-27) is excluded -> 3-0 (matches the CLI
    // twin's own assertion above).
    expect(august.teamRecord).toEqual(expect.objectContaining({ wins: 3, losses: 0 }));
    expect(august.evidenceWindow).toEqual({ anchorDay: "2026-08-28", since: "2025-08-28", label: "12mo to 2026-08-28" });
    // December: since = 2025-12-24, so ON_BOUND and JUST_OUTSIDE are both excluded -> 2-0.
    expect(december.teamRecord).toEqual(expect.objectContaining({ wins: 2, losses: 0 }));
    expect(december.evidenceWindow).toEqual({
      anchorDay: "2026-12-24",
      since: "2025-12-24",
      label: "12mo to 2026-12-24",
    });
    // The records differ, AND the disclosure explains why — a reader given only these two payloads
    // (no side-channel CLI call) can tell the two windows apart.
    expect(august.evidenceWindow.since).not.toBe(december.evidenceWindow.since);
  });

  // New, per the plan's Task 7 list: "event-anchored windowing actually reaching team show/player
  // show/MCP twins (set system time far from the event; assert records count event-adjacent
  // matches)" — the single most direct regression test for design decision 5's named defect. Under
  // the PRE-#122 code, `team_show`/`player_show` (CLI and MCP alike) always anchored to `new Date()`
  // and silently ignored a named `[event]` argument for windowing — this proves that is fixed by
  // running the clock somewhere the window would look completely empty if the event were ignored.
  it("MCP team_show/player_show anchor to the named event, not to a clock set a year away", async () => {
    const { teamId, teamName } = seed();
    seedEvent("Sectionals 2026", "2026-08-28");
    void teamId;
    // A year past the event: if windowing still used `new Date()` (the pre-#122 defect), `since`
    // would be ~2026-08-28 and EVERY fixture match (all in 2025/early-2026) would read as excluded.
    vi.setSystemTime(new Date("2027-08-28T12:00:00Z"));

    const teamProfile = (await toolHandler("team_show")({ target: teamName, event: "Sectionals 2026" })) as {
      teamRecord: { wins: number; losses: number };
    };
    expect(teamProfile.teamRecord).toEqual(expect.objectContaining({ wins: 3, losses: 0 }));

    const playerProfile = (await toolHandler("player_show")({
      target: "Randy Burgess",
      event: "Sectionals 2026",
    })) as { singlesRecord: { windowed: unknown } };
    // Randy has no COURT matches seeded (only team matches), so this asserts the shape survived the
    // rename rather than a specific count — the team-level assertion above is what proves the anchor.
    expect(playerProfile.singlesRecord.windowed).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 0 });
  });

  // Maps old case #9 ("MCP report_build reports its season AND which anchor it used"), field
  // renamed `season` -> `since` (design decision 4).
  it("MCP report_build reports its `since` AND which anchor it used, like the CLI", async () => {
    seed();
    const { db, sqlite } = openDb();
    db.insert(events)
      .values({
        name: "Undated Event",
        kind: "tournament",
        startsOn: null,
        endsOn: null,
        format: encodeEventFormat([{ slot: "S1", discipline: "singles" }]),
      })
      .run();
    sqlite.close();
    vi.setSystemTime(new Date("2027-01-02T12:00:00Z"));

    const payload = (await toolHandler("report_build")({ event: "Undated Event" })) as {
      since: string;
      anchoredTo: string;
    };

    // The clock says 2027-01-02 and the event carries no date: the result must SAY it fell back,
    // and `since` must be the real ISO lower bound (12 months before 2027-01-02), not a bare year.
    expect(payload.since).toBe("2026-01-02");
    expect(payload.anchoredTo).toBe("today");
  });

  // Maps old case #10 ("pins the renamed record key on the real MCP wire") — the Task 7 wire-key
  // pin is now `["allTime", "windowed"]`, replacing `["allTime", "season"]`.
  it("pins the renamed record key on the real MCP wire", async () => {
    seed();
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));

    const payload = (await toolHandler("player_show")({ target: "Randy Burgess" })) as {
      singlesRecord: Record<string, unknown>;
      doublesRecord: Record<string, unknown>;
    };

    expect(Object.keys(payload.singlesRecord).sort()).toEqual(["allTime", "windowed"]);
    expect(Object.keys(payload.doublesRecord).sort()).toEqual(["allTime", "windowed"]);
  });

  // Maps old case #11 ("leaves `tn lineup plan` alone"), KEPT VERBATIM per the plan — lineup
  // prediction has no date filter at all, and this change must not have introduced one by way of a
  // shared helper (`rowsWithin` is opt-in, not threaded into `predictedLineup`).
  it("leaves `tn lineup plan` alone — it does not window, and must not start", async () => {
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

  // New, per the Testing Strategy's "malformed starts_on refuses (fail closed)" edge case. Written
  // against the RAW `MCP_TOOLS` handler (not the CLI, which has no top-level catch for a generic
  // validation Error — a pre-existing gap this PR does not widen the scope to close) so the
  // assertion is a clean rejection rather than an uncaught throw crashing the test process.
  // `addEvent`'s own writer refuses a malformed `starts_on` before it is ever stored (`isIsoDay`), so
  // this seeds the corrupted row directly, the same way the codebase's other fail-closed-on-corrupt-
  // stored-value tests do for `events.format`/`events.league_scope`.
  it("a corrupted starts_on refuses fail-closed rather than silently anchoring to today", async () => {
    const { teamName } = seed();
    const { db, sqlite } = openDb();
    db.insert(events)
      .values({
        name: "Corrupted Event",
        kind: "tournament",
        // Not a real calendar day (Feb 30) — never producible through `addEvent`'s own `isIsoDay`
        // guard, but directly reachable if the column is hand-edited, exactly like the other
        // fail-closed reads this codebase already tests for `events.format`/`events.league_scope`.
        startsOn: "2026-02-30",
        endsOn: "2026-02-28",
        format: encodeEventFormat([{ slot: "S1", discipline: "singles" }]),
      })
      .run();
    sqlite.close();

    await expect(toolHandler("team_show")({ target: teamName, event: "Corrupted Event" })).rejects.toThrow(
      /unusable evidence window anchor/i,
    );
  });

  it("dbFixture is wired (guards against a suite that silently shares a database)", () => {
    expect(dbFixture.path()).toContain("evidence-window.db");
  });
});
