// Issue #19 (Phase 7 — runbooks, binder, dry run), Task 1: the dry run's central deliverable.
//
// This walks the WHOLE `tn` pipeline through the real `dispatch` (src/cli/router.ts), in
// operational order, against the captured Tulsa 2025 scorecard fixture
// (test/fixtures/scorecard/tulsa-2025-redacted.json) — turning "we did a dry run" from a story
// (a PR-body transcript) into a re-runnable regression anchor that reddens on drift.
//
// The two teams and rosters the scorecard payload names must exist in the DB, seeded through the
// real pipeline (a `team pull --from` fixture replay), so `match add`'s roster-scoped name
// resolution succeeds. Aligning a synthesized roster page with the payload's own names is the
// friction point of this whole task (see `buildRosterPage` in test/helpers/roster-html.ts) — so the
// roster pages below are built FROM the payload's own player names, not the other way around.
//
// Deliberately NOT re-tested here (already unit-covered, and re-testing end to end would buy
// slowness, not signal): flag/`--` delimiter parsing, output-root guards, `event add` range
// narrowing, `player avail` multi-event ambiguity.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb } from "../src/db/client.js";
import {
  availability,
  captainNotes,
  courtMatches,
  courtMatchPlayers,
  events,
  players,
  teamMatches,
  teamMemberships,
  teams,
} from "../src/db/schema.js";
import * as fetchModule from "../src/ingest/fetch.js";
import { buildRosterPage } from "./helpers/roster-html.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SCORECARD_PATH = join(FIXTURES_DIR, "scorecard", "tulsa-2025-redacted.json");
const MATCH_HISTORY_PATH = join(FIXTURES_DIR, "tennisrecord", "match-history.html");

type ScorecardPayload = {
  playedOn: string;
  homeTeam: string;
  visitingTeam: string;
  scheduledTime?: string;
  site?: string;
  courts: {
    slot: string;
    discipline: string;
    homePlayers: string[];
    visitingPlayers: string[];
    winnerSide?: string;
    score?: string;
  }[];
};

// Read directly from the committed fixture rather than hardcoding names, so the roster pages below
// are built FROM the payload's own names (issue #19's stated friction point), not duplicated by hand
// and left free to drift from it.
const scorecardPayload = JSON.parse(readFileSync(SCORECARD_PATH, "utf8")) as ScorecardPayload;
const HOME_TEAM_NAME = scorecardPayload.homeTeam;
const OPPONENT_TEAM_NAME = scorecardPayload.visitingTeam;
const HOME_SCORECARD_PLAYERS = Array.from(new Set(scorecardPayload.courts.flatMap((c) => c.homePlayers)));
const VISITING_SCORECARD_PLAYERS = Array.from(new Set(scorecardPayload.courts.flatMap((c) => c.visitingPlayers)));

// The real, captured player-pull fixture (test/fixtures/tennisrecord/match-history.html) is Avery
// Ashby's 2025 match history — a stand-in name from tools/fixture-vocabulary/stand-ins.txt, distinct
// from every scorecard name above. Folded into the home roster (rather than pulled as an unrelated
// player) so the player-pull step demonstrates real connective tissue: the same person is on the
// home roster, gets enriched via `player pull`, and is who `player avail`/`player note` act on.
const matchHistoryFixture = loadFixture("tennisrecord/match-history");
const HOME_ENRICHED_PLAYER = "Avery Ashby";
const HOME_ROSTER_PLAYERS = [...HOME_SCORECARD_PLAYERS, HOME_ENRICHED_PLAYER];

const HOME_SOURCE_URL = "https://www.tennisrecord.com/adult/teamprofile.aspx?teamname=IA%2fVersteeg&year=2026";
const OPPONENT_SOURCE_URL =
  "https://www.tennisrecord.com/adult/teamprofile.aspx?teamname=OK%2fTulsa+Ironwood&year=2026";

const EVENT_NAME = "Springfield Sectionals";
const AVAIL_DAY = "2026-08-28";
const CAPTAIN_NOTE_TEXT = "Focus returns to the ad court — forehand is the pattern to exploit.";

function writeTempFile(dir: string, filename: string, contents: string): string {
  const path = join(dir, filename);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** Recursively snapshots every file under `root` as a flat map of relative path -> content, so two
 * builds can be compared byte-for-byte without hand-listing every leaf `report build` writes. */
function snapshotDir(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out[rel] = readFileSync(join(dir, entry.name), "utf8");
    }
  };
  walk(root, "");
  return out;
}

/** Finds the per-team dossier directory `report build` assigned `teamName` by content, not by
 * recomputing `teamSlug`'s own collision-disambiguation logic a second time in the test. */
function findTeamDossierDir(root: string, teamName: string): string {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mdPath = join(root, entry.name, "index.md");
    if (existsSync(mdPath) && readFileSync(mdPath, "utf8").startsWith(`# ${teamName}`)) {
      return join(root, entry.name);
    }
  }
  throw new Error(`no dossier directory found for team "${teamName}" under ${root}`);
}

function countMatchRows(db: ReturnType<typeof openDb>["db"]) {
  return {
    teamMatches: db.select().from(teamMatches).all().length,
    courtMatches: db.select().from(courtMatches).all().length,
    courtMatchPlayers: db.select().from(courtMatchPlayers).all().length,
    teams: db.select().from(teams).all().length,
    players: db.select().from(players).all().length,
  };
}

describe("dry run: 2025 Tulsa data through the whole tn pipeline (issue #19)", () => {
  useTnDbPath("dry-run.db");
  useTnRawPath();

  let reportsDir: string;
  let workDir: string;
  const originalReportsPath = process.env.TN_REPORTS_PATH;
  let fetchSpy: MockInstance<typeof fetchModule.fetchPage>;

  beforeEach(() => {
    reportsDir = mkdtempSync(join(tmpdir(), "tn-dry-run-reports-"));
    process.env.TN_REPORTS_PATH = reportsDir;
    workDir = mkdtempSync(join(tmpdir(), "tn-dry-run-work-"));

    // Scenario 2 (credibility guard), applied to EVERY test in this file: the fetch seam
    // (src/ingest/fetch.ts) is replaced with a stub that THROWS. A step that ever fell back to a
    // live fetch fails loudly and immediately instead of the dry run silently reporting success
    // while never actually going offline-only. Every step below uses `--from`/`--source-url`, so
    // this should never fire — `expect(fetchSpy).not.toHaveBeenCalled()` in the tests below is the
    // explicit, positive assertion of that; this mock is what makes a violation IMPOSSIBLE to miss.
    fetchSpy = vi.spyOn(fetchModule, "fetchPage").mockImplementation(async () => {
      throw new Error("dry run must never touch the network — fetchPage was called");
    });
  });

  afterEach(() => {
    if (originalReportsPath === undefined) delete process.env.TN_REPORTS_PATH;
    else process.env.TN_REPORTS_PATH = originalReportsPath;
    rmSync(reportsDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** `db migrate` + both `team pull --from` replays — the shared base every scenario below needs. */
  async function seedRosters(): Promise<void> {
    expect(await dispatch(["db", "migrate"])).toBe(0);

    const homePath = writeTempFile(
      workDir,
      "home-team.html",
      buildRosterPage({ teamName: HOME_TEAM_NAME, players: HOME_ROSTER_PLAYERS }),
    );
    expect(
      await dispatch(["team", "pull", "tr:home", "--from", homePath, "--source-url", HOME_SOURCE_URL]),
    ).toBe(0);

    const oppPath = writeTempFile(
      workDir,
      "opponent-team.html",
      buildRosterPage({ teamName: OPPONENT_TEAM_NAME, players: VISITING_SCORECARD_PLAYERS }),
    );
    expect(
      await dispatch(["team", "pull", "tr:opponent", "--from", oppPath, "--source-url", OPPONENT_SOURCE_URL]),
    ).toBe(0);
  }

  /** The full spine through `player note` (spec's operational order) — `db migrate` -> both team
   * pulls -> `player pull` -> `team home` -> `event add` -> `player avail` -> `player note`. Returns
   * the console.log spy so a caller can inspect every summary line printed so far, in order. */
  async function runSpineThroughNote(): Promise<{ logSpy: MockInstance<typeof console.log> }> {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await seedRosters();

    expect(
      await dispatch([
        "player",
        "pull",
        "tr:ignored",
        "--from",
        MATCH_HISTORY_PATH,
        "--source-url",
        matchHistoryFixture.source.url,
      ]),
    ).toBe(0);

    expect(await dispatch(["team", "home", HOME_TEAM_NAME])).toBe(0);

    expect(await dispatch(["event", "add", EVENT_NAME, "tournament", "2026-08-28", "2026-08-30"])).toBe(0);

    expect(await dispatch(["player", "avail", HOME_ENRICHED_PLAYER, AVAIL_DAY, "available"])).toBe(0);

    expect(await dispatch(["player", "note", HOME_ENRICHED_PLAYER, "--", CAPTAIN_NOTE_TEXT])).toBe(0);

    return { logSpy };
  }

  it("scenario 1 (happy path): the whole spine composes end to end with real, checkable artifacts", async () => {
    const { logSpy } = await runSpineThroughNote();

    expect(await dispatch(["match", "add", SCORECARD_PATH])).toBe(0);
    expect(await dispatch(["lineup", "plan", OPPONENT_TEAM_NAME])).toBe(0);
    expect(await dispatch(["report", "build", "sectionals"])).toBe(0);

    // Folds in scenario 2's headline assertion for the happy path itself: if any step above had
    // fallen back to a live fetch, the throwing stub installed in `beforeEach` would already have
    // made that step return a non-zero exit — this is the explicit, positive proof of the negative.
    expect(fetchSpy).not.toHaveBeenCalled();

    const printedLines = logSpy.mock.calls.map((call) => String(call[0]));

    // --- terminal artifacts, asserted on CONTENT, not merely presence ---

    const { db, sqlite } = openDb();
    try {
      const homeTeamRow = db.select().from(teams).where(eq(teams.name, HOME_TEAM_NAME)).all()[0];
      const oppTeamRow = db.select().from(teams).where(eq(teams.name, OPPONENT_TEAM_NAME)).all()[0];
      expect(homeTeamRow).toBeDefined();
      expect(oppTeamRow).toBeDefined();

      // team home designated the HOME team, and only it.
      expect(homeTeamRow?.isHome).toBe(true);
      expect(oppTeamRow?.isHome).toBeFalsy();

      // roster rows: every scorecard home player plus the player-pull-enriched one; every scorecard
      // visiting player.
      const homeRoster = db
        .select({ playerId: teamMemberships.playerId })
        .from(teamMemberships)
        .where(eq(teamMemberships.teamId, homeTeamRow!.id))
        .all();
      expect(homeRoster).toHaveLength(HOME_ROSTER_PLAYERS.length);
      const oppRoster = db
        .select({ playerId: teamMemberships.playerId })
        .from(teamMemberships)
        .where(eq(teamMemberships.teamId, oppTeamRow!.id))
        .all();
      expect(oppRoster).toHaveLength(VISITING_SCORECARD_PLAYERS.length);

      // event + availability + captain note.
      const eventRow = db.select().from(events).where(eq(events.name, EVENT_NAME)).all()[0];
      expect(eventRow).toMatchObject({ kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" });

      const enrichedPlayerRow = db
        .select()
        .from(players)
        .where(eq(players.canonicalName, HOME_ENRICHED_PLAYER))
        .all()[0];
      expect(enrichedPlayerRow).toBeDefined();
      // Also enriched via player pull: a tennisrecord_url and rating observation(s) came from the
      // real `--from` replay, not merely from being seeded on the roster page.
      expect(enrichedPlayerRow?.tennisrecordUrl).toBe(matchHistoryFixture.source.url);

      const availRows = db
        .select()
        .from(availability)
        .where(and(eq(availability.playerId, enrichedPlayerRow!.id), eq(availability.eventId, eventRow!.id)))
        .all();
      expect(availRows).toHaveLength(1);
      expect(availRows[0]).toMatchObject({ day: AVAIL_DAY, status: "available" });

      const noteRows = db
        .select()
        .from(captainNotes)
        .where(eq(captainNotes.playerId, enrichedPlayerRow!.id))
        .all();
      expect(noteRows).toHaveLength(1);
      expect(noteRows[0]?.note).toBe(CAPTAIN_NOTE_TEXT);

      // the scorecard's five court matches, persisted under one team match.
      const teamMatchRows = db
        .select()
        .from(teamMatches)
        .where(
          and(eq(teamMatches.homeTeamId, homeTeamRow!.id), eq(teamMatches.visitingTeamId, oppTeamRow!.id)),
        )
        .all();
      expect(teamMatchRows).toHaveLength(1);
      const courtRows = db
        .select()
        .from(courtMatches)
        .where(eq(courtMatches.teamMatchId, teamMatchRows[0]!.id))
        .all();
      expect(courtRows).toHaveLength(5);
      expect(new Set(courtRows.map((r) => r.slot))).toEqual(new Set(["S1", "D1", "D2", "D3", "D4"]));
    } finally {
      sqlite.close();
    }

    // lineup plan: a real prediction was printed, naming the opponent and at least one real slot.
    const lineupOutput = printedLines.find((line) => line.startsWith("PREDICTED LINEUP"));
    expect(lineupOutput).toBeDefined();
    expect(lineupOutput).toContain(OPPONENT_TEAM_NAME);
    expect(lineupOutput).toMatch(/S1|D1|D2|D3|D4/);

    // report build: top-level index links both teams, and each team's own dossier names it.
    expect(existsSync(join(reportsDir, "index.html"))).toBe(true);
    expect(existsSync(join(reportsDir, "index.md"))).toBe(true);
    const topIndexMd = readFileSync(join(reportsDir, "index.md"), "utf8");
    expect(topIndexMd).toContain(HOME_TEAM_NAME);
    expect(topIndexMd).toContain(OPPONENT_TEAM_NAME);

    const opponentDir = findTeamDossierDir(reportsDir, OPPONENT_TEAM_NAME);
    const opponentIndexMd = readFileSync(join(opponentDir, "index.md"), "utf8");
    expect(opponentIndexMd.startsWith(`# ${OPPONENT_TEAM_NAME}`)).toBe(true);
    for (const name of VISITING_SCORECARD_PLAYERS) expect(opponentIndexMd).toContain(name);

    const homeDir = findTeamDossierDir(reportsDir, HOME_TEAM_NAME);
    const homeIndexMd = readFileSync(join(homeDir, "index.md"), "utf8");
    expect(homeIndexMd.startsWith(`# ${HOME_TEAM_NAME}`)).toBe(true);
    expect(homeIndexMd).toContain(HOME_ENRICHED_PLAYER);
  });

  it("scenario 2 (credibility guard): the whole run makes zero network calls", async () => {
    await runSpineThroughNote();
    expect(await dispatch(["match", "add", SCORECARD_PATH])).toBe(0);
    expect(await dispatch(["lineup", "plan", OPPONENT_TEAM_NAME])).toBe(0);
    expect(await dispatch(["report", "build", "sectionals"])).toBe(0);

    // The headline assertion: if ANY step above had silently fallen back to a live fetch, this
    // would already be nonzero (fetchSpy throws), so this positively confirms it was never called
    // rather than merely failing to notice a violation.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scenario 3 (determinism): report build sectionals is byte-identical on a rerun over the same DB", async () => {
    await runSpineThroughNote();
    expect(await dispatch(["match", "add", SCORECARD_PATH])).toBe(0);

    expect(await dispatch(["report", "build", "sectionals"])).toBe(0);
    const firstSnapshot = snapshotDir(reportsDir);

    expect(await dispatch(["report", "build", "sectionals"])).toBe(0);
    const secondSnapshot = snapshotDir(reportsDir);

    expect(Object.keys(secondSnapshot).sort()).toEqual(Object.keys(firstSnapshot).sort());
    expect(secondSnapshot).toEqual(firstSnapshot);
  });

  it("scenario 4 (sad path): match add refuses a payload naming a player off the named team's roster, and writes nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await seedRosters();

    const { db: dbBefore, sqlite: sqliteBefore } = openDb();
    const before = countMatchRows(dbBefore);
    sqliteBefore.close();

    // A payload identical to the real scorecard except one home-side player who is not on ANY
    // roster — the first court's `homePlayers` is replaced wholesale (not merely misspelled) so
    // there is no chance a fuzzy match resolves it by accident.
    const badPayload: ScorecardPayload = {
      ...scorecardPayload,
      courts: scorecardPayload.courts.map((court, index) =>
        index === 0 ? { ...court, homePlayers: ["Nobody On This Roster At All"] } : court,
      ),
    };
    const badPath = writeTempFile(workDir, "bad-scorecard.json", JSON.stringify(badPayload));

    const code = await dispatch(["match", "add", badPath]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unresolved player name"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Nobody On This Roster At All"));

    const { db: dbAfter, sqlite: sqliteAfter } = openDb();
    const after = countMatchRows(dbAfter);
    sqliteAfter.close();

    // The whole ingest rolled back: not one row landed anywhere the ingest could have touched.
    expect(after).toEqual(before);
  });

  it("scenario 5 (sad path): lineup plan refuses for a team with roster history but no matches of its own", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await dispatch(["db", "migrate"])).toBe(0);
    const oppPath = writeTempFile(
      workDir,
      "opponent-team.html",
      buildRosterPage({ teamName: OPPONENT_TEAM_NAME, players: VISITING_SCORECARD_PLAYERS }),
    );
    expect(
      await dispatch(["team", "pull", "tr:opponent", "--from", oppPath, "--source-url", OPPONENT_SOURCE_URL]),
    ).toBe(0);

    // No `match add` yet: the opponent has a real roster (just pulled) but zero court matches of
    // its own on file — the "only this team's own matches count" rule must refuse rather than guess.
    const code = await dispatch(["lineup", "plan", OPPONENT_TEAM_NAME]);

    expect(code).toBe(1);
    // The summary line's `message=` value is itself quoted (src/cli/emit.ts's `quoteSummaryValue`),
    // so an embedded `"` around the team name is backslash-escaped in the printed line — asserted
    // as two substrings rather than one literal string carrying that escaping.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no court-match history on file for"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(OPPONENT_TEAM_NAME));
  });
});
