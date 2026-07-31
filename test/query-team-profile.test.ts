import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import {
  courtMatchPlayers,
  courtMatches,
  players,
  teamMatches,
  teamMemberships,
  teams,
} from "../src/db/schema.js";
import { getTeamProfile, resolveTeamTarget } from "../src/query/team-profile.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

function seedPlayer(db: Db, canonicalName: string) {
  return db.insert(players).values({ canonicalName, nameKey: nameKey(canonicalName) }).returning().get();
}

function seedTeam(db: Db, name: string) {
  return db.insert(teams).values({ name, nameKey: nameKey(name) }).returning().get();
}

function seedMembership(db: Db, playerId: number, teamId: number) {
  db.insert(teamMemberships).values({ playerId, teamId, eventId: null }).run();
}

function seedCourtMatch(
  db: Db,
  values: Partial<typeof courtMatches.$inferInsert> & { slot: string; discipline: string },
  participants: { playerId: number; side: "home" | "visiting" }[],
) {
  const row = db.insert(courtMatches).values({ winnerSide: null, playedOn: null, ...values }).returning().get();
  for (const p of participants) {
    db.insert(courtMatchPlayers).values({ courtMatchId: row.id, playerId: p.playerId, side: p.side }).run();
  }
  return row;
}

describe("getTeamProfile", () => {
  useTnDbPath();

  it("roster ordering is deterministic (alphabetical by canonical name)", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const zed = seedPlayer(db, "Zed Zephyr");
      const alice = seedPlayer(db, "Alice Anders");
      const mia = seedPlayer(db, "Mia Marlowe");
      // Insert deliberately out of alphabetical order.
      seedMembership(db, zed.id, team.id);
      seedMembership(db, alice.id, team.id);
      seedMembership(db, mia.id, team.id);

      const profile = getTeamProfile(db, team.id, { since: "2026-01-01" });

      expect(profile.roster.map((r) => r.canonicalName)).toEqual(["Alice Anders", "Mia Marlowe", "Zed Zephyr"]);
      // Re-running produces the identical order (no dependency on insertion/query order).
      const again = getTeamProfile(db, team.id, { since: "2026-01-01" });
      expect(again.roster.map((r) => r.canonicalName)).toEqual(profile.roster.map((r) => r.canonicalName));
    } finally {
      sqlite.close();
    }
  });

  it("a player with NO memberships row is excluded from the roster", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const member = seedPlayer(db, "Ellis Eastwick");
      seedPlayer(db, "Not On This Team"); // exists, never joined
      seedMembership(db, member.id, team.id);

      const profile = getTeamProfile(db, team.id, { since: "2026-01-01" });

      expect(profile.roster).toHaveLength(1);
      expect(profile.roster[0]!.canonicalName).toBe("Ellis Eastwick");
    } finally {
      sqlite.close();
    }
  });

  it("team record is computed from team_matches WITHOUT reading home/visiting as venue", () => {
    const { db, sqlite } = freshDb();
    try {
      const teamA = seedTeam(db, "Team A");
      const teamB = seedTeam(db, "Team B");

      // Team A is "home" and wins.
      db.insert(teamMatches)
        .values({
          homeTeamId: teamA.id,
          visitingTeamId: teamB.id,
          homeCourtsWon: 3,
          visitingCourtsWon: 2,
          playedOn: "2026-06-01",
        })
        .run();
      // The SAME real fixture, from Team A's OTHER match that day being pulled from Team B's page:
      // Team A is "visiting" here, but the actual real-world result is still a Team A win — the
      // courts-won columns flip with the labels (docs/findings.md, #15's note on team_matches).
      db.insert(teamMatches)
        .values({
          homeTeamId: teamB.id,
          visitingTeamId: teamA.id,
          homeCourtsWon: 2,
          visitingCourtsWon: 3,
          playedOn: "2026-06-08",
        })
        .run();

      const profile = getTeamProfile(db, teamA.id, { since: "2026-01-01" });
      expect(profile.teamRecord).toEqual({ wins: 2, losses: 0, undecided: 0, excludedUndated: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("versusTeamId produces a head-to-head row per cross pair", () => {
    const { db, sqlite } = freshDb();
    try {
      const teamA = seedTeam(db, "Team A");
      const teamB = seedTeam(db, "Team B");
      const a1 = seedPlayer(db, "A One");
      const a2 = seedPlayer(db, "A Two");
      const b1 = seedPlayer(db, "B One");
      seedMembership(db, a1.id, teamA.id);
      seedMembership(db, a2.id, teamA.id);
      seedMembership(db, b1.id, teamB.id);

      // a1 beat b1; a2 never played b1.
      seedCourtMatch(
        db,
        { slot: "S1", discipline: "singles", winnerSide: "home", playedOn: "2026-05-01" },
        [{ playerId: a1.id, side: "home" }, { playerId: b1.id, side: "visiting" }],
      );

      const profile = getTeamProfile(db, teamA.id, { since: "2026-01-01", versusTeamId: teamB.id });

      expect(profile.headToHead).not.toBeNull();
      const rows = profile.headToHead!;
      // 2 team-A players x 1 team-B player = 2 cross-pair rows.
      expect(rows).toHaveLength(2);
      const a1VsB1 = rows.find((r) => r.playerId === a1.id && r.opponentId === b1.id);
      const a2VsB1 = rows.find((r) => r.playerId === a2.id && r.opponentId === b1.id);
      expect(a1VsB1).toMatchObject({ wins: 1, losses: 0, undecided: 0, matches: 1 });
      // The never-met pair still gets an explicit zero row, not an absence.
      expect(a2VsB1).toMatchObject({ wins: 0, losses: 0, undecided: 0, matches: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("headToHead is null (not an empty array) when no versusTeamId is given", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const profile = getTeamProfile(db, team.id, { since: "2026-01-01" });
      expect(profile.headToHead).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("per-slot roster tendencies aggregate across the whole roster", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const p1 = seedPlayer(db, "Player One");
      const p2 = seedPlayer(db, "Player Two");
      const opponent = seedPlayer(db, "Opponent");
      seedMembership(db, p1.id, team.id);
      seedMembership(db, p2.id, team.id);

      seedCourtMatch(db, { slot: "S1", discipline: "singles", playedOn: "2026-05-01" }, [
        { playerId: p1.id, side: "home" },
        { playerId: opponent.id, side: "visiting" },
      ]);
      seedCourtMatch(db, { slot: "S1", discipline: "singles", playedOn: "2026-05-02" }, [
        { playerId: p2.id, side: "home" },
        { playerId: opponent.id, side: "visiting" },
      ]);

      const profile = getTeamProfile(db, team.id, { since: "2026-01-01" });
      expect(profile.slotTendencies).toEqual([{ slot: "S1", count: 2 }]);
    } finally {
      sqlite.close();
    }
  });
});

describe("resolveTeamTarget", () => {
  useTnDbPath();

  it("resolves a bare team name", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "IA/Versteeg/40&Over3.5M");
      const result = resolveTeamTarget(db, "IA/Versteeg/40&Over3.5M");
      expect(result).toEqual({ kind: "ok", teamId: team.id });
    } finally {
      sqlite.close();
    }
  });

  it("an unknown target is not-found and creates nothing", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = resolveTeamTarget(db, "No Such Team");
      expect(result).toEqual({ kind: "not-found" });
      expect(db.select().from(teams).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("resolves a tr: prefixed target by tennisrecord_url", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = db
        .insert(teams)
        .values({ name: "Team A", tennisrecordUrl: "https://tennisrecord.com/team.aspx?teamname=Team%20A" })
        .returning()
        .get();
      const result = resolveTeamTarget(db, "tr:https://tennisrecord.com/team.aspx?teamname=Team%20A");
      expect(result).toEqual({ kind: "ok", teamId: team.id });
    } finally {
      sqlite.close();
    }
  });

  it("an unknown tr: prefixed target is not-found", () => {
    const { db, sqlite } = freshDb();
    try {
      expect(resolveTeamTarget(db, "tr:https://nope")).toEqual({ kind: "not-found" });
    } finally {
      sqlite.close();
    }
  });

  it("an ambiguous fuzzy team name lists every candidate", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(teams)
        .values([
          { name: "Team Alpha", nameKey: nameKey("Team Alpha") },
          { name: "Team Alpho", nameKey: nameKey("Team Alpho") },
        ])
        .run();
      const result = resolveTeamTarget(db, "Team Alph");
      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.candidates.sort()).toEqual(["Team Alpha", "Team Alpho"]);
      }
    } finally {
      sqlite.close();
    }
  });
});
