// The DB assembly layer for the predicted lineup (#17 PR B). The heuristic's own behavior is
// specified exhaustively in `query-derive-lineup.test.ts` against hand-built inputs; what these
// tests check is the part that layer cannot see — that the right rows are fetched, that names are
// attached, that a duplicate membership row does not clone a player onto two courts, and that a
// team with no history refuses rather than returning an empty lineup.

import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { events, players, ratingObservations, teamMemberships, teams } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { NoCourtMatchHistoryError, getLineupPlan } from "../src/query/lineup.js";
import { resolveTeamTarget } from "../src/query/team-profile.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

let nextMid = 0;

/** One doubles court match with `ours` on the home side and two anonymous opponents opposite. */
function playDoubles(db: Db, slot: string, ours: number[], times: number): void {
  for (let i = 0; i < times; i++) {
    nextMid += 1;
    const cm = upsertCourtMatch(db, {
      teamMatchId: null,
      slot,
      discipline: "doubles",
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: `lineup-${nextMid}`,
    });
    for (const playerId of ours) upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId, side: "home" });
  }
}

function playSingles(db: Db, slot: string, playerId: number, times: number): void {
  for (let i = 0; i < times; i++) {
    nextMid += 1;
    const cm = upsertCourtMatch(db, {
      teamMatchId: null,
      slot,
      discipline: "singles",
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: `lineup-${nextMid}`,
    });
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId, side: "home" });
  }
}

function seedTeam(db: Db, names: string[]): { teamId: number; ids: Record<string, number> } {
  const team = db.insert(teams).values({ name: "IA/Versteeg/40&Over3.5M" }).returning().get();
  const ids: Record<string, number> = {};
  for (const name of names) {
    const p = db.insert(players).values({ canonicalName: name }).returning().get();
    ids[name] = p.id;
    db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
  }
  backfillNameKeys(db);
  return { teamId: team.id, ids };
}

describe("getLineupPlan", () => {
  useTnDbPath();

  it("returns a named lineup built from the roster's own court-match history", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder", "Del Duxbury", "Emory Ellerby"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 6);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 5);
      playDoubles(db, "D2", [ids["Del Duxbury"]!, ids["Emory Ellerby"]!], 4);

      const plan = getLineupPlan(db, teamId);

      expect(plan.teamName).toBe("IA/Versteeg/40&Over3.5M");
      expect(plan.rosterSize).toBe(5);
      expect(plan.slots.map((s) => s.slot)).toEqual(["S1", "D1", "D2"]);
      expect(plan.slots.map((s) => s.players.map((p) => p.canonicalName))).toEqual([
        ["Ada Ashby"],
        ["Bo Bramwell", "Cy Calder"],
        ["Del Duxbury", "Emory Ellerby"],
      ]);
      // Names, never raw ids — the defect #16 shipped into a printed dossier.
      expect(JSON.stringify(plan)).not.toMatch(/player #\d/);
      expect(plan.observedCourtMatches).toBe(15);
      expect(plan.slotSource).toBe("observed");
    } finally {
      sqlite.close();
    }
  });

  it("reads real rating observations and names the source it ranked within", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder", "Del Duxbury"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 3);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 3);
      for (const [name, value] of [
        ["Ada Ashby", 4.1],
        ["Bo Bramwell", 3.9],
        ["Cy Calder", 3.8],
        ["Del Duxbury", 3.7],
      ] as const) {
        db.insert(ratingObservations)
          .values({ playerId: ids[name]!, source: "ntrp", value, ratingType: "C", observedOn: "2026-05-01" })
          .run();
      }

      const plan = getLineupPlan(db, teamId);

      expect(plan.ratingSource).toBe("ntrp");
      expect(plan.unranked).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("uses only the latest observation per source, matching ratingTrajectory's rule", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 2);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 2);
      // Bo was the stronger player in January and the weaker one in June. If the plan read the
      // stale row, the ranking inverts.
      db.insert(ratingObservations)
        .values({ playerId: ids["Bo Bramwell"]!, source: "ntrp", value: 4.5, ratingType: "C", observedOn: "2026-01-01" })
        .run();
      db.insert(ratingObservations)
        .values({ playerId: ids["Bo Bramwell"]!, source: "ntrp", value: 3.2, ratingType: "C", observedOn: "2026-06-01" })
        .run();
      db.insert(ratingObservations)
        .values({ playerId: ids["Cy Calder"]!, source: "ntrp", value: 4.0, ratingType: "C", observedOn: "2026-06-01" })
        .run();

      const plan = getLineupPlan(db, teamId);

      expect(plan.ratingSource).toBe("ntrp");
      // Ada has no rating at all, so only Bo and Cy are ranked — Cy (4.0) ahead of Bo (3.2).
      expect(plan.unranked.map((p) => p.canonicalName)).toEqual(["Ada Ashby"]);
    } finally {
      sqlite.close();
    }
  });

  it("counts a player on two event rosters once, so nobody is placed on two courts", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      // A district roster row AND a travel roster row for the same player — the normal case per
      // spec § Domain model ("rosters differ per event").
      const event = db
        .insert(events)
        .values({ name: "Springfield Sectionals 2026", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
        .returning()
        .get();
      db.insert(teamMemberships).values({ playerId: ids["Ada Ashby"]!, teamId, eventId: event.id }).run();

      playSingles(db, "S1", ids["Ada Ashby"]!, 3);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 3);

      const plan = getLineupPlan(db, teamId);

      expect(plan.rosterSize, "one person, two membership rows").toBe(3);
      const placedIds = plan.slots.flatMap((s) => s.players.map((p) => p.playerId));
      expect(new Set(placedIds).size).toBe(placedIds.length);
    } finally {
      sqlite.close();
    }
  });

  it("refuses a team with no court-match history rather than returning an empty lineup", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId } = seedTeam(db, ["Ada Ashby", "Bo Bramwell"]);
      expect(() => getLineupPlan(db, teamId)).toThrow(NoCourtMatchHistoryError);
    } finally {
      sqlite.close();
    }
  });

  it("refuses a team with no roster at all", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = db.insert(teams).values({ name: "Empty FC" }).returning().get();
      backfillNameKeys(db);
      expect(() => getLineupPlan(db, team.id)).toThrow(NoCourtMatchHistoryError);
    } finally {
      sqlite.close();
    }
  });

  it("throws a plain error for an id that is not a team at all — a caller bug, not a refusal", () => {
    const { db, sqlite } = freshDb();
    try {
      expect(() => getLineupPlan(db, 9999)).toThrow(/no team with id 9999/);
    } finally {
      sqlite.close();
    }
  });

  it("resolves its target through the same resolveTeamTarget every other team command uses", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 2);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 2);

      const resolution = resolveTeamTarget(db, "IA/Versteeg/40&Over3.5M");
      expect(resolution.kind).toBe("ok");
      if (resolution.kind !== "ok") throw new Error("expected ok");
      expect(getLineupPlan(db, resolution.teamId).teamId).toBe(teamId);
    } finally {
      sqlite.close();
    }
  });
});
