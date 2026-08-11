import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { evidenceWindow, windowSnapshot } from "../src/cli/window.js";
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
import { seedTeamWithRosters } from "./helpers/roster.js";
import { useTnDbPath } from "./helpers/tn-db.js";

/** #122 round-1 Finding 1: `getTeamProfile` takes a `window` (an `EvidenceWindowDisclosure`), not a
 * bare `since` — constructed via `windowSnapshot(evidenceWindow(anchorDay))`, never a hand-assembled
 * triple. `anchorDay` is one year after the fixture's intended `since` bound (the textual 12-month
 * subtraction this module documents in `src/cli/window.ts`), so each existing fixture's `since` value
 * is preserved exactly. */
function windowSince(anchorDay: string) {
  return windowSnapshot(evidenceWindow(anchorDay));
}

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

  // #122 round 2 — twin of getPlayerProfile's refusal: the disclosure triple is validated at
  // entry, so a hand-assembled triple cannot make the team page filter by one bound while
  // disclosing another.
  it("refuses a window disclosure whose fields do not derive from their own anchorDay", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      expect(() =>
        getTeamProfile(db, team.id, {
          window: { anchorDay: "2026-08-28", since: "0000-01-01", label: "12mo to 2026-08-28" },
        }),
      ).toThrow(/inconsistent evidence window disclosure/i);
    } finally {
      sqlite.close();
    }
  });

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

      const profile = getTeamProfile(db, team.id, { window: windowSince("2027-01-01") });

      expect(profile.roster.map((r) => r.canonicalName)).toEqual(["Alice Anders", "Mia Marlowe", "Zed Zephyr"]);
      // Re-running produces the identical order (no dependency on insertion/query order).
      const again = getTeamProfile(db, team.id, { window: windowSince("2027-01-01") });
      expect(again.roster.map((r) => r.canonicalName)).toEqual(profile.roster.map((r) => r.canonicalName));
    } finally {
      sqlite.close();
    }
  });

  // Issue #128: `ageRange` was NULL for every one of 1745 players before this PR, and nothing on
  // the roster read side had ever been exercised against a real value. Pins that a roster member's
  // `ageRange` is read straight off the player row, present and absent side by side.
  it("roster member ageRange is read from the player row — present and absent", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team Age Range");
      const withRange = seedPlayer(db, "Micah Merrivale");
      const withoutRange = seedPlayer(db, "Noel Nobody");
      db.update(players).set({ ageRange: "41-50" }).where(eq(players.id, withRange.id)).run();
      seedMembership(db, withRange.id, team.id);
      seedMembership(db, withoutRange.id, team.id);

      const profile = getTeamProfile(db, team.id, { window: windowSince("2027-01-01") });

      const rangeRow = profile.roster.find((r) => r.canonicalName === "Micah Merrivale");
      const noRangeRow = profile.roster.find((r) => r.canonicalName === "Noel Nobody");
      expect(rangeRow?.ageRange).toBe("41-50");
      // The permanent case (#128): no WTN profile on file means this stays NULL forever.
      expect(noRangeRow?.ageRange).toBeNull();
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

      const profile = getTeamProfile(db, team.id, { window: windowSince("2027-01-01") });

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

      const profile = getTeamProfile(db, team.id, { window: windowSince("2027-01-01") });

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

      const before = getTeamProfile(db, teamA.id, { window: windowSince("2027-01-01") });
      expect(before.teamRecord).toEqual({ wins: 1, losses: 0, undecided: 0, excludedUndated: 0 });

      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, retired.id))
        .run();

      const after = getTeamProfile(db, teamA.id, { window: windowSince("2027-01-01") });
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

      const profile = getTeamProfile(db, teamA.id, { window: windowSince("2027-01-01") });
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

      const profile = getTeamProfile(db, teamA.id, { window: windowSince("2027-01-01"), versusTeamId: teamB.id });

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

      const profile = getTeamProfile(db, teamA.id, { window: windowSince("2027-01-01"), versusTeamId: teamB.id });

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
      const profile = getTeamProfile(db, team.id, { window: windowSince("2027-01-01") });
      expect(profile.headToHead).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  // Issue #122, Task 3's explicit exemption: `headToHead` stays all-meetings by documented intent —
  // unlike the records and tendencies above it on the same page, a prior meeting is evidence about
  // an opponent regardless of when it happened, so it stays UNWINDOWED even though `options.since`
  // is passed for everything else `getTeamProfile` derives.
  it("headToHead counts a meeting OUTSIDE the window — it is not filtered by `since`, unlike every other section", () => {
    const { db, sqlite } = freshDb();
    try {
      const teamA = seedTeam(db, "Team A");
      const teamB = seedTeam(db, "Team B");
      const a1 = seedPlayer(db, "A One");
      const b1 = seedPlayer(db, "B One");
      seedMembership(db, a1.id, teamA.id);
      seedMembership(db, b1.id, teamB.id);

      // Played well before `since` — excluded from every windowed section, but a real prior meeting.
      seedCourtMatch(
        db,
        { slot: "S1", discipline: "singles", winnerSide: "home", playedOn: "2025-09-02" },
        [{ playerId: a1.id, side: "home" }, { playerId: b1.id, side: "visiting" }],
      );

      const profile = getTeamProfile(db, teamA.id, { window: windowSince("2027-06-01"), versusTeamId: teamB.id });

      const rows = profile.headToHead!;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playerId: a1.id, opponentId: b1.id, wins: 1, losses: 0, matches: 1 });
      // The windowed record for the same player, over the same match, correctly reads 0-0 — proving
      // the two sections are genuinely computed differently, not merely asserted to be.
      expect(profile.roster[0]!.singlesRecord).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 0 });
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

      const profile = getTeamProfile(db, team.id, { window: windowSince("2027-01-01") });
      expect(profile.slotTendencies).toEqual([{ slot: "S1", count: 2 }]);
    } finally {
      sqlite.close();
    }
  });

  // Issue #122, Task 3: roster-member `slotTendencies` used to be computed over every court match on
  // file, unwindowed — the same "second failure" shape as the player path, one field over. Both the
  // per-member entry AND the roster-wide aggregate (which sums the per-member entries) must reflect
  // only in-window rows.
  it("roster-member slotTendencies (and the aggregate that sums them) count only in-window rows", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const p1 = seedPlayer(db, "Player One");
      const opponent = seedPlayer(db, "Opponent");
      seedMembership(db, p1.id, team.id);

      // Out-of-window: real evidence, must not reach the member's OR the aggregate's tendencies.
      seedCourtMatch(db, { slot: "D4", discipline: "doubles", playedOn: "2025-09-02" }, [
        { playerId: p1.id, side: "home" },
        { playerId: opponent.id, side: "visiting" },
      ]);
      // In-window.
      seedCourtMatch(db, { slot: "S1", discipline: "singles", playedOn: "2026-06-15" }, [
        { playerId: p1.id, side: "home" },
        { playerId: opponent.id, side: "visiting" },
      ]);

      const profile = getTeamProfile(db, team.id, { window: windowSince("2027-06-01") });

      expect(profile.roster[0]!.slotTendencies).toEqual([{ slot: "S1", count: 1 }]);
      expect(profile.slotTendencies).toEqual([{ slot: "S1", count: 1 }]);
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
      const profile = getTeamProfile(db, team.id, { window: windowSince("2027-01-01") });
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
      const profile = getTeamProfile(db, other.id, { window: windowSince("2027-01-01") });
      expect(profile.isHome).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("reports isHome: false for every team when no home team is designated at all", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const profile = getTeamProfile(db, team.id, { window: windowSince("2027-01-01") });
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

// Task 3 (#113): `getTeamProfile` gains `eventId` beside the `leagueScope` it already takes, and
// both its own roster read AND the `versusTeamId` opponent roster now go through the shared
// `resolveRoster` choke point (src/query/roster.ts) instead of each running its own query.
describe("getTeamProfile — event-scoped roster (#113)", () => {
  useTnDbPath();

  it("the issue's own bar: omits a season-roster player who did not register, includes one who did (20 -> 9)", () => {
    const { db, sqlite } = freshDb();
    try {
      const season = Array.from({ length: 20 }, (_, i) => `Season Player ${String(i + 1).padStart(2, "0")}`);
      const registered = season.slice(0, 9);
      const fixture = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season,
        registered: { eventName: "Springfield Sectionals 2026", names: registered },
      });

      const profile = getTeamProfile(db, fixture.teamId, { window: windowSince("2027-01-01"), eventId: fixture.eventId });

      expect(profile.rosterSource).toBe("registered");
      expect(profile.roster).toHaveLength(9);
      expect(profile.roster.map((r) => r.canonicalName).sort()).toEqual([...registered].sort());
      expect(profile.absentRoster.map((r) => r.canonicalName).sort()).toEqual([...season.slice(9)].sort());
    } finally {
      sqlite.close();
    }
  });

  it("an event with no registered memberships renders the full season roster — a second team on the same DB is unaffected", () => {
    const { db, sqlite } = freshDb();
    try {
      const registeredTeam = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season: ["Alice Anders"],
        registered: { eventName: "Springfield Sectionals 2026", names: ["Alice Anders"] },
      });
      const unregisteredTeam = seedTeamWithRosters(db, {
        teamName: "IA/Versteeg/40&Over3.5M",
        season: ["Bo Bergstrom", "Cy Castillo"],
      });

      // The event genuinely exists (registeredTeam.eventId), just carries no registration for THIS
      // team — the feature must not empty every OTHER team's dossier for the same event.
      const profile = getTeamProfile(db, unregisteredTeam.teamId, {
        window: windowSince("2027-01-01"),
        eventId: registeredTeam.eventId,
      });

      expect(profile.rosterSource).toBe("season");
      expect(profile.roster).toHaveLength(2);
      expect(profile.absentRoster).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("evidenceScope counts, records and slot tendencies are computed over the SCOPED roster", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "Team A",
        season: ["Registered Rey", "Absent Ada"],
        registered: { eventName: "Event X", names: ["Registered Rey"] },
      });
      const registeredId = fixture.registeredPlayerIds.get("Registered Rey")!;
      const absentId = fixture.seasonPlayerIds.get("Absent Ada")!;
      // Absent Ada has a court match, Registered Rey does not — proves the evidence descends from
      // the SCOPED roster, not the season roster: an unscoped read would pick this match up too.
      seedCourtMatch(
        db,
        { slot: "D1", discipline: "doubles", winnerSide: "home", playedOn: "2026-05-01" },
        [{ playerId: absentId, side: "home" }],
      );

      const profile = getTeamProfile(db, fixture.teamId, { window: windowSince("2027-01-01"), eventId: fixture.eventId });

      expect(profile.roster.map((r) => r.playerId)).toEqual([registeredId]);
      expect(profile.evidenceScope.considered).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("the head-to-head opponent roster is scoped the same way as our own", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeamWithRosters(db, {
        teamName: "Home Team",
        season: ["Home Player"],
        registered: { eventName: "Shared Event", names: ["Home Player"] },
      });
      const away = seedTeamWithRosters(db, {
        teamName: "Away Team",
        season: ["Away Registered", "Away Not Registered"],
      });
      const awayRegisteredId = away.seasonPlayerIds.get("Away Registered")!;
      // Registers the AWAY player for the SAME event home is scoped to, without a second `events`
      // row (`events.name` is unique) — the shape a real registration payload for a different team
      // would produce.
      db.insert(teamMemberships)
        .values({ playerId: awayRegisteredId, teamId: away.teamId, eventId: home.eventId! })
        .run();

      const profile = getTeamProfile(db, home.teamId, {
        window: windowSince("2027-01-01"),
        eventId: home.eventId,
        versusTeamId: away.teamId,
      });

      expect(profile.headToHead).toHaveLength(1);
      expect(profile.headToHead![0]!.opponentName).toBe("Away Registered");
    } finally {
      sqlite.close();
    }
  });
});
