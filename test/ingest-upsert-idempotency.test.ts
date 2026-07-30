import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import {
  courtMatchPlayers,
  courtMatches,
  ratingObservations,
  teamMatches,
  teamMemberships,
  teams,
} from "../src/db/schema.js";
import { hrefParam } from "../src/parsers/dom.js";
import { resolvePlayer } from "../src/ingest/identity.js";
import { matchHistoryUrlFor } from "../src/ingest/player-pull.js";
import { pullTeam } from "../src/ingest/team-pull.js";
import { upsertRatingObservation, upsertTeam, upsertTeamMatch } from "../src/ingest/upsert.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";

const team = loadFixture("tennisrecord/team");
const matchHistory = loadFixture("tennisrecord/match-history");

const ROSTER_NAMES = [
  "Ellis Eastwick",
  "EMORY ELLERBY",
  "Ira Inglewood",
  "Yuma Yarrowby",
  "Hollis Hartwell",
  "Kai Kestrel",
  "Blake Bramwell",
  "Lane Linfield",
  "Casey Calder",
  "Orin Oakhurst",
  "Marek Melbourne",
  "Rowan Rushworth",
  "Nova Norbury",
  "Avery Ashby",
  "Zephyr Zellman",
  "Harper Halloway",
  "Juniper Jarrow",
  "Delaney Duxbury",
];

/** A minimal, structurally valid TennisRecord match-history page for a given player, with zero
 * matches — enough for parseTennisRecordHeader + parseMatchHistory to succeed without throwing,
 * so every roster entry's `--players` cascade resolves to ITS OWN distinct player identity rather
 * than colliding on a shared name. */
function syntheticEmptyMatchHistory(name: string): string {
  return `<html><body>
    <table>
      <tr>
        <td><a class="link" href="/adult/profile.aspx?playername=${name}">${name}</a> (Somewhere, ZZ)<br><span>Male</span></td>
        <td>4.0 C<br>12/31/2025</td>
      </tr>
      <tr>
        <td>Estimated Dynamic Rating</td>
        <td>4.0<br>01/01/2026</td>
      </tr>
    </table>
    <div class="large">
      <table>
        <tr>
          <th>Match Date</th><th>League</th><th>Team</th><th>Court</th><th>Partner</th>
          <th>Opponent(s)</th><th>W/L</th><th>Result</th><th>Match</th><th>Rating</th>
        </tr>
      </table>
    </div>
  </body></html>`;
}

function buildFetcher() {
  const year = hrefParam(team.source.url, "year") ?? "2026";
  const fixtures: Record<string, { body: string }> = {
    [team.source.url]: { body: team.html },
  };
  for (const name of ROSTER_NAMES) {
    const url = matchHistoryUrlFor(name, year);
    fixtures[url] = name === "Avery Ashby" ? { body: matchHistory.html } : { body: syntheticEmptyMatchHistory(name) };
  }
  return createStubFetcher(fixtures);
}

describe("upsert idempotency — the headline test", () => {
  useTnDbPath();

  it("running team pull twice through the stub fetcher leaves identical rows, and updates a changed rating in place", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const fetcher1 = buildFetcher();
      const first = await pullTeam({
        db,
        fetchPage: fetcher1,
        target: team.source.url,
        cascadePlayers: true,
      });
      expect(first.kind).toBe("ok");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshot = (table: any) => db.select().from(table).all();

      const teamsAfterFirst = snapshot(teams);
      const membershipsAfterFirst = snapshot(teamMemberships);
      const teamMatchesAfterFirst = snapshot(teamMatches);
      const courtMatchesAfterFirst = snapshot(courtMatches);
      const courtMatchPlayersAfterFirst = snapshot(courtMatchPlayers);
      const ratingObservationsAfterFirst = snapshot(ratingObservations);

      expect(teamMatchesAfterFirst).toHaveLength(10);
      expect(courtMatchesAfterFirst).toHaveLength(14);
      expect(ratingObservationsAfterFirst.length).toBeGreaterThan(0);

      const fetcher2 = buildFetcher();
      const second = await pullTeam({
        db,
        fetchPage: fetcher2,
        target: team.source.url,
        cascadePlayers: true,
      });
      expect(second.kind).toBe("ok");

      expect(snapshot(teams)).toEqual(teamsAfterFirst);
      expect(snapshot(teamMemberships)).toEqual(membershipsAfterFirst);
      expect(snapshot(teamMatches)).toEqual(teamMatchesAfterFirst);
      expect(snapshot(courtMatches)).toEqual(courtMatchesAfterFirst);
      expect(snapshot(courtMatchPlayers)).toEqual(courtMatchPlayersAfterFirst);
      expect(snapshot(ratingObservations)).toEqual(ratingObservationsAfterFirst);
    } finally {
      sqlite.close();
    }
  });

  it("a changed dynamic rating on a second pass updates the SAME rating_observations row in place, not a second one", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const resolved = resolvePlayer(db, { name: "Some Player" });
      if (resolved.kind === "ambiguous") throw new Error("unexpected ambiguous");

      upsertRatingObservation(db, {
        playerId: resolved.row.id,
        source: "tr_dynamic",
        value: 4.0,
        ratingType: null,
        observedOn: "2026-05-01",
      });
      upsertRatingObservation(db, {
        playerId: resolved.row.id,
        source: "tr_dynamic",
        value: 4.2,
        ratingType: null,
        observedOn: "2026-05-01",
      });

      const rows = db.select().from(ratingObservations).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value).toBe(4.2);
    } finally {
      sqlite.close();
    }
  });

  it("EDGE: a team_matches row with a NULL source_match_id does not collide with another NULL row", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const teamRow = upsertTeam(db, { name: "Solo Team" });
      upsertTeamMatch(db, {
        eventId: null,
        homeTeamId: teamRow.id,
        visitingTeamId: teamRow.id,
        playedOn: "2026-01-01",
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });
      upsertTeamMatch(db, {
        eventId: null,
        homeTeamId: teamRow.id,
        visitingTeamId: teamRow.id,
        playedOn: "2026-01-08",
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });

      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });
});
