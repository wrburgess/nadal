import { eq } from "drizzle-orm";
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
import { upsertTeam } from "../src/ingest/upsert.js";
import { getTeamProfile, resolveTeamTarget } from "../src/query/team-profile.js";
import { setHomeTeam } from "../src/query/home-team.js";
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

  // Issue #49: a retired membership row still exists (soft-retire, never a delete) but must not
  // read as a current roster member — the headline symptom the issue was filed for.
  it("a retired member is excluded from the roster, while a current member of the same team is not", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const current = seedPlayer(db, "Current Player");
      const retired = seedPlayer(db, "Departed Player");
      seedMembership(db, current.id, team.id);
      seedMembership(db, retired.id, team.id);
      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, retired.id))
        .run();

      const profile = getTeamProfile(db, team.id, { since: "2026-01-01" });

      expect(profile.roster.map((r) => r.canonicalName)).toEqual(["Current Player"]);
    } finally {
      sqlite.close();
    }
  });

  // The sharp edge of "retired ≠ deleted": filtering the CURRENT roster must not filter the team's
  // match record, which reads court/team-match history rather than the roster query.
  it("a retirement does not change the team's match record — the departed player's court matches still count", () => {
    const { db, sqlite } = freshDb();
    try {
      const teamA = seedTeam(db, "Team A");
      const teamB = seedTeam(db, "Team B");
      const retired = seedPlayer(db, "Departed Player");
      seedMembership(db, retired.id, teamA.id);
      db.insert(teamMatches)
        .values({ homeTeamId: teamA.id, visitingTeamId: teamB.id, homeCourtsWon: 3, visitingCourtsWon: 2, playedOn: "2026-06-01" })
        .run();

      const before = getTeamProfile(db, teamA.id, { since: "2026-01-01" });
      expect(before.teamRecord).toEqual({ wins: 1, losses: 0, undecided: 0, excludedUndated: 0 });

      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, retired.id))
        .run();

      const after = getTeamProfile(db, teamA.id, { since: "2026-01-01" });
      expect(after.teamRecord).toEqual({ wins: 1, losses: 0, undecided: 0, excludedUndated: 0 });
      expect(after.roster, "filtering the CURRENT roster must not filter the team's history").toHaveLength(0);
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
      // Every row carries the OPPONENT'S NAME, not just their id — a rendered dossier prints
      // "vs player #<id>" otherwise, a raw database id in a printed courtside binder. This was
      // latent and untested before #17 (headToHead was always null in production until Task 5
      // wired a real versusTeamId), caught by reading the actual rendered artifact.
      expect(a1VsB1?.opponentName).toBe("B One");
      expect(a2VsB1?.opponentName).toBe("B One");
    } finally {
      sqlite.close();
    }
  });

  // Issue #49: the VERSUS roster is the same kind of "current membership" read as the own roster,
  // and must be filtered the same way — a retired opponent should not appear as a cross-pair either.
  it("a retired member of the VERSUS team is absent from the roster and from every headToHead cross pair", () => {
    const { db, sqlite } = freshDb();
    try {
      const teamA = seedTeam(db, "Team A");
      const teamB = seedTeam(db, "Team B");
      const a1 = seedPlayer(db, "A One");
      const b1 = seedPlayer(db, "B One");
      const bRetired = seedPlayer(db, "B Departed");
      seedMembership(db, a1.id, teamA.id);
      seedMembership(db, b1.id, teamB.id);
      seedMembership(db, bRetired.id, teamB.id);
      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, bRetired.id))
        .run();

      seedCourtMatch(
        db,
        { slot: "S1", discipline: "singles", winnerSide: "home", playedOn: "2026-05-01" },
        [{ playerId: a1.id, side: "home" }, { playerId: bRetired.id, side: "visiting" }],
      );

      const profile = getTeamProfile(db, teamA.id, { since: "2026-01-01", versusTeamId: teamB.id });

      const rows = profile.headToHead!;
      // Only 1 team-A player x 1 CURRENT team-B player = 1 row, never one for the retired opponent.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.opponentId).toBe(b1.id);
      expect(rows.some((r) => r.opponentId === bRetired.id)).toBe(false);
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

describe("getTeamProfile isHome", () => {
  useTnDbPath();

  it("reports isHome: true for the designated home team", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Home Team");
      setHomeTeam(db, team.id);
      const profile = getTeamProfile(db, team.id, { since: "2026-01-01" });
      expect(profile.isHome).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("reports isHome: false for every other team, including when a different team is home", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeam(db, "Home Team");
      const other = seedTeam(db, "Other Team");
      setHomeTeam(db, home.id);
      const profile = getTeamProfile(db, other.id, { since: "2026-01-01" });
      expect(profile.isHome).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("reports isHome: false for every team when no home team is designated at all", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const profile = getTeamProfile(db, team.id, { since: "2026-01-01" });
      expect(profile.isHome).toBe(false);
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

  // Issue #46: `tr:` selects by `tennisrecord_url`, which the URL branch of `upsertTeam` now keeps
  // a unique source identity across a rename — this asserts the query-layer target resolution
  // sees exactly that: one surviving id, with the NEW name.
  it("resolves the single surviving id after a rename (#46), with the NEW name", () => {
    const { db, sqlite } = freshDb();
    try {
      const url = "https://tennisrecord.com/team.aspx?teamname=Springfield%20A";
      const first = upsertTeam(db, { name: "Springfield A", tennisrecordUrl: url });
      const renamed = upsertTeam(db, { name: "Springfield A 4.0", tennisrecordUrl: url });
      expect(renamed.id).toBe(first.id);

      const result = resolveTeamTarget(db, `tr:${url}`);
      expect(result).toEqual({ kind: "ok", teamId: renamed.id });

      const row = db.select().from(teams).where(eq(teams.id, renamed.id)).all()[0];
      expect(row?.name).toBe("Springfield A 4.0");
    } finally {
      sqlite.close();
    }
  });
});
