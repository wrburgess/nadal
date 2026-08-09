// Issue #97, end to end at the query layer: the event-scoped evidence filter that stops a scouting
// dossier's records and slot tendencies from being computed over every league a player has ever
// played in.
//
// The bar this file is written against is #97 scope item 4, verbatim: *an unfiltered read and a
// filtered read over the same fixture must DIFFER, and the excluded count must be asserted — not
// merely that the filter ran.* Every case below either shows two reads of one fixture disagreeing,
// or pins a number the filter itself reported.
//
// One fixture shape recurs: a player with real in-league doubles history AND mixed-doubles history
// at the same slot. That is the measured shape of the live data — D2 appearances were 32% mixed
// across the five Sectionals teams — and it is what makes "this player usually plays D2" a claim
// about a partner pool that does not exist at Sectionals.

import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { getLineupPlan } from "../src/query/lineup.js";
import { parseLeagueScope } from "../src/query/league-scope.js";
import { courtMatchRowsForPlayers, getPlayerProfile } from "../src/query/player-profile.js";
import { getTeamProfile } from "../src/query/team-profile.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

const SEASON = "2026-01-01";
const EXCLUDE_MIXED = parseLeagueScope("exclude:Mixed");
const ONLY_MIXED = parseLeagueScope("only:Mixed");

let nextMid = 0;

/**
 * One court match with `ours` on the home side and `theirs` opposite, carrying an explicit league
 * context — `null` models what `src/ingest/match-add.ts` writes for every court recorded from an
 * in-event scorecard photo.
 *
 * `won` is the home side's outcome, so a caller can make the two leagues' records DIFFER rather than
 * merely differ in count — a filter that dropped the right number of rows but left the win/loss
 * totals unchanged would satisfy a count assertion while changing nothing a captain reads.
 */
function play(
  db: Db,
  opts: {
    slot: string;
    discipline: "singles" | "doubles";
    ours: number[];
    theirs?: number[];
    leagueContext: string | null;
    won: boolean;
    teamMatchId?: number | null;
    playedOn?: string;
  },
): void {
  nextMid += 1;
  const cm = upsertCourtMatch(db, {
    teamMatchId: opts.teamMatchId ?? null,
    slot: opts.slot,
    discipline: opts.discipline,
    winnerSide: opts.won ? "home" : "visiting",
    score: "6-3 6-4",
    leagueContext: opts.leagueContext,
    playedOn: opts.playedOn ?? "2026-05-01",
    sourceMatchId: `scope-${nextMid}`,
  });
  for (const playerId of opts.ours) upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId, side: "home" });
  for (const playerId of opts.theirs ?? []) {
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId, side: "visiting" });
  }
}

function seedPlayer(db: Db, canonicalName: string, teamId?: number): number {
  const p = db.insert(players).values({ canonicalName }).returning().get();
  if (teamId !== undefined) {
    db.insert(teamMemberships).values({ playerId: p.id, teamId, eventId: null }).run();
  }
  backfillNameKeys(db);
  return p.id;
}

function seedTeam(db: Db, name: string): number {
  return db.insert(teams).values({ name }).returning().get().id;
}

describe("courtMatchRowsForPlayers — the scope, and the account of it", () => {
  useTnDbPath();

  it("no scope: every league counts, and the summary says so positively", () => {
    const { db, sqlite } = freshDb();
    try {
      const nova = seedPlayer(db, "Nova Norbury");
      play(db, { slot: "D2", discipline: "doubles", ours: [nova], leagueContext: "Adult 40+ 3.5", won: true });
      play(db, { slot: "D2", discipline: "doubles", ours: [nova], leagueContext: "Mixed 40+ 7.0", won: true });

      const evidence = courtMatchRowsForPlayers(db, [nova]);

      expect(evidence.rows).toHaveLength(2);
      // `scope: null` is a REPORTED state, not an absent field — a reader has to be able to tell an
      // unscoped read from a scoped one.
      expect(evidence.scope).toEqual({
        scope: null,
        considered: 2,
        retained: 2,
        excluded: 0,
        unclassified: 0,
        retainedLeagues: [
          { league: "Adult 40+ 3.5", count: 1 },
          { league: "Mixed 40+ 7.0", count: 1 },
        ],
      });
    } finally {
      sqlite.close();
    }
  });

  it("exclude:Mixed sets aside the mixed rows and reports the exact count", () => {
    const { db, sqlite } = freshDb();
    try {
      const nova = seedPlayer(db, "Nova Norbury");
      for (const league of ["Adult 40+ 3.5", "Adult 18+ 3.5", "Adult 55+ 7.0"]) {
        play(db, { slot: "D2", discipline: "doubles", ours: [nova], leagueContext: league, won: true });
      }
      for (const league of ["Mixed 40+ 7.0", "Mixed 18+ 7.0"]) {
        play(db, { slot: "D2", discipline: "doubles", ours: [nova], leagueContext: league, won: true });
      }

      const unscoped = courtMatchRowsForPlayers(db, [nova]);
      const scoped = courtMatchRowsForPlayers(db, [nova], EXCLUDE_MIXED);

      // The two reads DIFFER — scope item 4's actual requirement, asserted as a difference between
      // reads rather than as "the filter ran".
      expect(unscoped.rows).toHaveLength(5);
      expect(scoped.rows).toHaveLength(3);
      expect(scoped.scope.excluded).toBe(2);
      expect(scoped.scope.considered).toBe(5);
      expect(scoped.scope.scope).toEqual({ mode: "exclude", prefixes: ["Mixed"] });
      // What is STILL in there — the accepted residual, stated rather than implied.
      expect(scoped.scope.retainedLeagues).toEqual([
        { league: "Adult 18+ 3.5", count: 1 },
        { league: "Adult 40+ 3.5", count: 1 },
        { league: "Adult 55+ 7.0", count: 1 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("only:Mixed is the exact inverse over classified rows — September reuses it", () => {
    const { db, sqlite } = freshDb();
    try {
      const nova = seedPlayer(db, "Nova Norbury");
      for (const league of ["Adult 40+ 3.5", "Adult 18+ 3.5", "Mixed 40+ 7.0", "Mixed Other 8.0"]) {
        play(db, { slot: "D2", discipline: "doubles", ours: [nova], leagueContext: league, won: true });
      }
      // One unclassified row, which BOTH modes retain.
      play(db, { slot: "D2", discipline: "doubles", ours: [nova], leagueContext: null, won: true });

      const excluded = courtMatchRowsForPlayers(db, [nova], EXCLUDE_MIXED);
      const only = courtMatchRowsForPlayers(db, [nova], ONLY_MIXED);

      expect(excluded.scope.retained).toBe(3); // 2 adult + 1 unclassified
      expect(only.scope.retained).toBe(3); // 2 mixed + 1 unclassified

      // The inverse relationship as an IDENTITY rather than as two hand-counted numbers: every
      // classified row is retained by exactly one of the two modes, and the unclassified row by both.
      // If the modes ever stop being exact inverses this fails without anyone having to notice.
      const total = excluded.scope.considered;
      const unclassified = excluded.scope.unclassified;
      expect(only.scope.unclassified).toBe(unclassified);
      expect(excluded.scope.retained + only.scope.retained - unclassified).toBe(total);
    } finally {
      sqlite.close();
    }
  });

  it("an unclassified row survives both modes and is counted separately, never folded into a league", () => {
    const { db, sqlite } = freshDb();
    try {
      const nova = seedPlayer(db, "Nova Norbury");
      play(db, { slot: "D1", discipline: "doubles", ours: [nova], leagueContext: null, won: true });
      play(db, { slot: "D1", discipline: "doubles", ours: [nova], leagueContext: "Mixed 40+ 7.0", won: true });

      for (const scope of [EXCLUDE_MIXED, ONLY_MIXED]) {
        const evidence = courtMatchRowsForPlayers(db, [nova], scope);
        expect(evidence.scope.unclassified).toBe(1);
        expect(evidence.scope.retainedLeagues).toContainEqual({ league: null, count: 1 });
      }
    } finally {
      sqlite.close();
    }
  });

  it("the unclassified bucket sorts last even when it is the largest", () => {
    const { db, sqlite } = freshDb();
    try {
      const nova = seedPlayer(db, "Nova Norbury");
      for (let i = 0; i < 5; i++) {
        play(db, { slot: "D1", discipline: "doubles", ours: [nova], leagueContext: null, won: true });
      }
      play(db, { slot: "D1", discipline: "doubles", ours: [nova], leagueContext: "Adult 40+ 3.5", won: true });

      const evidence = courtMatchRowsForPlayers(db, [nova]);

      // A real league must never read as the smaller category behind a nameless bucket, whatever the
      // counts are — so the null sorts last unconditionally, ahead of the count comparison.
      expect(evidence.scope.retainedLeagues).toEqual([
        { league: "Adult 40+ 3.5", count: 1 },
        { league: null, count: 5 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("folds case, so a source that starts spelling it MIXED does not silently re-open the defect", () => {
    const { db, sqlite } = freshDb();
    try {
      const nova = seedPlayer(db, "Nova Norbury");
      play(db, { slot: "D1", discipline: "doubles", ours: [nova], leagueContext: "MIXED 40+ 7.0", won: true });
      play(db, { slot: "D1", discipline: "doubles", ours: [nova], leagueContext: "Adult 40+ 3.5", won: true });

      const scoped = courtMatchRowsForPlayers(db, [nova], EXCLUDE_MIXED);

      expect(scoped.scope.excluded).toBe(1);
      expect(scoped.scope.retainedLeagues).toEqual([{ league: "Adult 40+ 3.5", count: 1 }]);
    } finally {
      sqlite.close();
    }
  });
});

describe("getPlayerProfile — the records a dossier prints", () => {
  useTnDbPath();

  it("scoped and unscoped reads of ONE fixture produce different records and different slot tendencies", () => {
    const { db, sqlite } = freshDb();
    try {
      const nova = seedPlayer(db, "Nova Norbury");
      const partner = seedPlayer(db, "Kai Kestrel");
      const mixedPartner = seedPlayer(db, "Wren Wexley");

      // In-league doubles: two wins at D1.
      for (let i = 0; i < 2; i++) {
        play(db, {
          slot: "D1",
          discipline: "doubles",
          ours: [nova, partner],
          leagueContext: "Adult 40+ 3.5",
          won: true,
        });
      }
      // Mixed doubles: three LOSSES at D2, with a partner pool that does not exist at Sectionals.
      for (let i = 0; i < 3; i++) {
        play(db, {
          slot: "D2",
          discipline: "doubles",
          ours: [nova, mixedPartner],
          leagueContext: "Mixed 40+ 7.0",
          won: false,
        });
      }

      const unscoped = getPlayerProfile(db, nova, { since: SEASON });
      const scoped = getPlayerProfile(db, nova, { since: SEASON, leagueScope: EXCLUDE_MIXED });

      // RECORD: 2-3 becomes 2-0. Not merely a smaller count — a different answer to "is this player
      // winning in doubles", which is the question the dossier is read for.
      expect(unscoped.doublesRecord.windowed).toMatchObject({ wins: 2, losses: 3 });
      expect(scoped.doublesRecord.windowed).toMatchObject({ wins: 2, losses: 0 });
      expect(scoped.doublesRecord.windowed).not.toEqual(unscoped.doublesRecord.windowed);

      // SLOT TENDENCIES: "usually plays D2" becomes "plays D1", which is the headline symptom #97
      // was filed for.
      expect(unscoped.slotTendencies).toEqual([
        { slot: "D2", count: 3 },
        { slot: "D1", count: 2 },
      ]);
      expect(scoped.slotTendencies).toEqual([{ slot: "D1", count: 2 }]);

      // PARTNERS: the mixed partner is gone entirely, not merely down-weighted.
      expect(unscoped.partnerFrequency.map((p) => p.canonicalName)).toContain("Wren Wexley");
      expect(scoped.partnerFrequency.map((p) => p.canonicalName)).not.toContain("Wren Wexley");

      // And the excluded count is ASSERTED, not inferred.
      expect(scoped.evidenceScope.excluded).toBe(3);
      expect(scoped.evidenceScope.retained).toBe(2);
      expect(unscoped.evidenceScope.excluded).toBe(0);
      expect(unscoped.evidenceScope.scope).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("carries the scope summary that describes the very rows it derived from", () => {
    const { db, sqlite } = freshDb();
    try {
      const nova = seedPlayer(db, "Nova Norbury");
      play(db, { slot: "D1", discipline: "doubles", ours: [nova], leagueContext: "Adult 18+ 3.5", won: true });
      play(db, { slot: "D1", discipline: "doubles", ours: [nova], leagueContext: "Mixed 40+ 7.0", won: true });

      const scoped = getPlayerProfile(db, nova, { since: SEASON, leagueScope: EXCLUDE_MIXED });

      // The residual, concretely: what survived is NOT all in-league, and the profile says which.
      expect(scoped.evidenceScope.retainedLeagues).toEqual([{ league: "Adult 18+ 3.5", count: 1 }]);
      expect(scoped.evidenceScope.scope).toEqual({ mode: "exclude", prefixes: ["Mixed"] });
    } finally {
      sqlite.close();
    }
  });
});

describe("getTeamProfile — the roster table, the aggregate, and prior meetings", () => {
  useTnDbPath();

  it("scoping changes roster records, aggregated slot tendencies, and head-to-head alike", () => {
    const { db, sqlite } = freshDb();
    try {
      const opponentTeam = seedTeam(db, "OK/Dickason/40&Over3.5M");
      const ourTeam = seedTeam(db, "HOA/Burgess-Zingg/40&Over3.5M");
      const rival = seedPlayer(db, "Nova Norbury", opponentTeam);
      const ours = seedPlayer(db, "Ada Ashby", ourTeam);

      // The rival beat our player once in MIXED, and lost to them once in league.
      play(db, {
        slot: "D2",
        discipline: "doubles",
        ours: [rival],
        theirs: [ours],
        leagueContext: "Mixed 40+ 7.0",
        won: true,
      });
      play(db, {
        slot: "D1",
        discipline: "doubles",
        ours: [rival],
        theirs: [ours],
        leagueContext: "Adult 40+ 3.5",
        won: false,
      });

      const unscoped = getTeamProfile(db, opponentTeam, { since: SEASON, versusTeamId: ourTeam });
      const scoped = getTeamProfile(db, opponentTeam, {
        since: SEASON,
        versusTeamId: ourTeam,
        leagueScope: EXCLUDE_MIXED,
      });

      expect(unscoped.roster[0]!.doublesRecord).toMatchObject({ wins: 1, losses: 1 });
      expect(scoped.roster[0]!.doublesRecord).toMatchObject({ wins: 0, losses: 1 });

      expect(unscoped.slotTendencies).toEqual([
        { slot: "D1", count: 1 },
        { slot: "D2", count: 1 },
      ]);
      expect(scoped.slotTendencies).toEqual([{ slot: "D1", count: 1 }]);

      // A prior meeting in mixed doubles says as little about a Sectionals court as a mixed record
      // does, so `headToHead` moves with the scope too — it is the same evidence question asked
      // across two rosters.
      expect(unscoped.headToHead![0]).toMatchObject({ wins: 1, losses: 1, matches: 2 });
      expect(scoped.headToHead![0]).toMatchObject({ wins: 0, losses: 1, matches: 1 });

      expect(scoped.evidenceScope.excluded).toBe(1);
      expect(scoped.evidenceScope.retained).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  // Codex adversarial review of PR #99, round 1, Finding 2 [A/medium]. The disclosure's counts have
  // to be counts of the evidence the page actually DISPLAYS. `getTeamProfile` was fetching rows for
  // the roster AND the versus roster, so a court match played only by OUR players — feeding no
  // roster record, no slot tendency, and no head-to-head row (derive.ts's `headToHead` skips any row
  // the roster member did not play in) — was still counted in `considered`/`excluded`. A dossier
  // could then read "N of M retained, K excluded" where some of K changed nothing on the page.
  it("counts only the evidence the profile actually displays — never a court match no section uses", () => {
    const { db, sqlite } = freshDb();
    try {
      const opponentTeam = seedTeam(db, "OK/Dickason/40&Over3.5M");
      const ourTeam = seedTeam(db, "HOA/Burgess-Zingg/40&Over3.5M");
      const rival = seedPlayer(db, "Nova Norbury", opponentTeam);
      const ours = seedPlayer(db, "Ada Ashby", ourTeam);
      const stranger = seedPlayer(db, "Wren Wexley");

      // Displayed: the rival met our player once, in league.
      play(db, {
        slot: "D1",
        discipline: "doubles",
        ours: [rival],
        theirs: [ours],
        leagueContext: "Adult 40+ 3.5",
        won: false,
      });

      const before = getTeamProfile(db, opponentTeam, {
        since: SEASON,
        versusTeamId: ourTeam,
        leagueScope: EXCLUDE_MIXED,
      });

      // NOT displayed anywhere on the opponent's dossier: OUR player's own mixed match against a
      // third party. No opponent-roster player took part, so no section can reach it.
      play(db, {
        slot: "D3",
        discipline: "doubles",
        ours: [ours],
        theirs: [stranger],
        leagueContext: "Mixed 40+ 7.0",
        won: true,
      });

      const after = getTeamProfile(db, opponentTeam, {
        since: SEASON,
        versusTeamId: ourTeam,
        leagueScope: EXCLUDE_MIXED,
      });

      // Nothing the page shows moved...
      expect(after.roster).toEqual(before.roster);
      expect(after.slotTendencies).toEqual(before.slotTendencies);
      expect(after.headToHead).toEqual(before.headToHead);
      // ...so nothing the page CLAIMS about its evidence may move either. Before the fix,
      // `considered` went 1 -> 2 and `excluded` went 0 -> 1 on this exact input.
      expect(after.evidenceScope).toEqual(before.evidenceScope);
      expect(after.evidenceScope).toMatchObject({ considered: 1, retained: 1, excluded: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("the team record is NOT scoped — it comes from team fixtures, which carry no league context", () => {
    const { db, sqlite } = freshDb();
    try {
      const ourTeam = seedTeam(db, "HOA/Burgess-Zingg/40&Over3.5M");
      const other = seedTeam(db, "Opponent");
      seedPlayer(db, "Nova Norbury", ourTeam);
      db.insert(teamMatches)
        .values({
          homeTeamId: ourTeam,
          visitingTeamId: other,
          playedOn: "2026-05-01",
          homeCourtsWon: 3,
          visitingCourtsWon: 2,
        })
        .run();

      const unscoped = getTeamProfile(db, ourTeam, { since: SEASON });
      const scoped = getTeamProfile(db, ourTeam, { since: SEASON, leagueScope: EXCLUDE_MIXED });

      // Asserted rather than assumed, because both renderers print a sentence saying exactly this —
      // and a sentence about behavior nothing pins is how a true claim becomes a stale one.
      expect(scoped.teamRecord).toEqual(unscoped.teamRecord);
      expect(scoped.teamRecord).toMatchObject({ wins: 1, losses: 0 });
    } finally {
      sqlite.close();
    }
  });
});

describe("getLineupPlan — the one reader #97 must NOT change", () => {
  useTnDbPath();

  it("ignores the event's league scope entirely, on a fixture where applying it WOULD change the plan", () => {
    const { db, sqlite } = freshDb();
    try {
      const teamId = seedTeam(db, "IA/Versteeg/40&Over3.5M");
      const opponent = seedTeam(db, "Opponent");
      const ada = seedPlayer(db, "Ada Ashby", teamId);
      const bo = seedPlayer(db, "Bo Bramwell", teamId);
      const cy = seedPlayer(db, "Cy Calder", teamId);
      const ourMatch = db
        .insert(teamMatches)
        .values({ homeTeamId: teamId, visitingTeamId: opponent, sourceMatchId: "own-1" })
        .returning()
        .get();

      // NON-VACUOUS BY CONSTRUCTION: this Mixed court match is linked to the team's OWN team match,
      // so it IS part of `getLineupPlan`'s evidence. If a league scope ever leaked into that reader,
      // the D1 partnership below would lose its entire support and the assertions would fail. A
      // fixture whose own-team rows were all in-league would let a leak pass unnoticed.
      for (let i = 0; i < 4; i++) {
        play(db, {
          slot: "D1",
          discipline: "doubles",
          ours: [bo, cy],
          leagueContext: "Mixed 40+ 7.0",
          won: true,
          teamMatchId: ourMatch.id,
        });
      }
      for (let i = 0; i < 3; i++) {
        play(db, {
          slot: "S1",
          discipline: "singles",
          ours: [ada],
          leagueContext: "Adult 40+ 3.5",
          won: true,
          teamMatchId: ourMatch.id,
        });
      }

      const plan = getLineupPlan(db, teamId);

      expect(plan.observedCourtMatches).toBe(7);
      const d1 = plan.slots.find((s) => s.slot === "D1")!;
      expect(d1.players.map((p) => p.canonicalName).sort()).toEqual(["Bo Bramwell", "Cy Calder"]);
      expect(d1.support).toBe(4);
      expect(d1.basis).toBe("history");

      // The same DB, read through the SCOPED path, drops exactly those rows — which is what makes
      // the assertions above a statement about `getLineupPlan` rather than about the fixture.
      const scopedTeam = getTeamProfile(db, teamId, { since: SEASON, leagueScope: EXCLUDE_MIXED });
      expect(scopedTeam.evidenceScope.excluded).toBe(4);
      expect(scopedTeam.slotTendencies).toEqual([{ slot: "S1", count: 3 }]);
    } finally {
      sqlite.close();
    }
  });
});
