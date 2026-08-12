// The DB assembly layer for `tn lineup build` (#127). The rules themselves are specified
// exhaustively in `query-derive-lineup-build.test.ts` against hand-built inputs; what these tests
// check is the part that layer cannot see — that the right rows are fetched, ONCE each, and threaded
// down: the day's availability rather than the event's, the registered roster rather than the
// season one, this team's own court matches rather than every match its players appear in.
//
// Real on-disk SQLite (`useTnDbPath`), seeded through the REAL writers wherever one exists
// (`setHomeTeam`, `addEvent`, `setEventRoster`, `setAvailability`, `addCaptainNote`,
// `upsertCourtMatch`), with `backfillNameKeys` before the name-resolving writers run.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { availability, players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { setEventRoster } from "../src/ingest/roster-set.js";
import { upsertCourtMatch, upsertCourtMatchPlayers, upsertRatingObservation } from "../src/ingest/upsert.js";
import {
  AmbiguousEventForDayError,
  EventDoesNotCoverDayError,
  InvalidAvailabilityDayError,
  InvalidAvailabilityStatusError,
  NoEventForDayError,
  UnknownEventError,
  setAvailability,
} from "../src/query/availability.js";
import { addCaptainNote } from "../src/query/captain-notes.js";
import { NoCourtMatchHistoryError } from "../src/query/derive.js";
import { addEvent } from "../src/query/events.js";
import { NoHomeTeamError, setHomeTeam } from "../src/query/home-team.js";
import { EventHasNoFormatError } from "../src/query/lineup.js";
import { getLineupBuild } from "../src/query/lineup-build.js";
import { InvalidPlaysError, setPlays } from "../src/query/player-plays.js";
import { seedAvailabilityMatrix } from "./helpers/availability-matrix.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

const EVENT = "Springfield Sectionals 2026";
const FORMAT = "S1:singles,D1:doubles,D2:doubles,D3:doubles";
const FRIDAY = "2026-08-28";
const SATURDAY = "2026-08-29";

/** Ten roster members, named so alphabetical order and insertion order agree. */
const TEN = Array.from({ length: 10 }, (_, i) => `Player ${String(i + 1).padStart(2, "0")} Ashby`);

type Fixture = {
  teamId: number;
  teamName: string;
  eventId: number;
  ids: Record<string, number>;
  ourMatch: { id: number };
};

type SeedOptions = {
  season?: string[];
  /** Registered for the event, via the real `setEventRoster`. Omitted -> season roster only. */
  registered?: string[];
  format?: string;
  eventName?: string;
  startsOn?: string;
  endsOn?: string;
};

/**
 * A home team, an event with a court format, a season roster, and (optionally) a registered field —
 * plus one `team_matches` row so court matches can be linked to THIS team, which is what production
 * produces and what `ownTeamCourtMatchRows` restricts evidence to.
 */
function seedBuild(db: Db, options: SeedOptions = {}): Fixture {
  const season = options.season ?? TEN;
  const teamName = "HOA/Burgess-Zingg/40&over3.5M";
  const team = db.insert(teams).values({ name: teamName }).returning().get();
  setHomeTeam(db, team.id);

  const event = addEvent(db, {
    name: options.eventName ?? EVENT,
    kind: "tournament",
    startsOn: options.startsOn ?? FRIDAY,
    endsOn: options.endsOn ?? "2026-08-30",
    ...(options.format === undefined ? {} : { format: options.format }),
  });

  const ids: Record<string, number> = {};
  for (const name of season) {
    const player = db.insert(players).values({ canonicalName: name }).returning().get();
    ids[name] = player.id;
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
  }

  const opponent = db.insert(teams).values({ name: "Opponent Team" }).returning().get();
  const ourMatch = db
    .insert(teamMatches)
    .values({ homeTeamId: team.id, visitingTeamId: opponent.id, sourceMatchId: "own-1" })
    .returning()
    .get();

  // Before the name-resolving writers below, never after: `setEventRoster` resolves both the team
  // and every player by name through the `name_key` index.
  backfillNameKeys(db);

  if (options.registered !== undefined) {
    const result = setEventRoster(db, {
      team: teamName,
      event: options.eventName ?? EVENT,
      players: options.registered,
    });
    if (!result.ok) throw new Error(`fixture: setEventRoster refused (${result.kind})`);
  }

  return { teamId: team.id, teamName, eventId: event.eventId, ids, ourMatch };
}

let nextMid = 0;

/** One doubles court match with `pair` on the same side, linked to `teamMatch` — or unlinked/linked
 * elsewhere when a test needs evidence that is NOT ours. */
function playDoubles(
  db: Db,
  pair: [number, number],
  times: number,
  teamMatchId: number | null,
  /** Which side the pair sat on. Defaults to `"home"`, which `seedBuild` makes OUR side on
   * `ourMatch`; pass `"visiting"` to place them on the OPPONENT's side of one of our own matches. */
  side: "home" | "visiting" = "home",
): void {
  for (let i = 0; i < times; i++) {
    nextMid += 1;
    const court = upsertCourtMatch(db, {
      teamMatchId,
      slot: "D1",
      discipline: "doubles",
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: `build-${nextMid}`,
    });
    for (const playerId of pair) upsertCourtMatchPlayers(db, { courtMatchId: court.id, playerId, side });
  }
}

/** Singles courts for one player, on OUR side of `teamMatchId` — used to steer `history-first`'s S1
 * pick away from a player a doubles assertion needs left in the pool. */
function playSingles(db: Db, playerId: number, times: number, teamMatchId: number): void {
  for (let i = 0; i < times; i++) {
    nextMid += 1;
    const court = upsertCourtMatch(db, {
      teamMatchId,
      slot: "S1",
      discipline: "singles",
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: `build-${nextMid}`,
    });
    upsertCourtMatchPlayers(db, { courtMatchId: court.id, playerId, side: "home" });
  }
}

function rate(db: Db, playerId: number, value: number, source = "tr_dynamic"): void {
  upsertRatingObservation(db, { playerId, source, value, ratingType: null, observedOn: "2026-01-01" });
}

/** Everyone available on both days, expressed through the real writer. */
function allAvailable(db: Db, ids: number[], days: string[] = [FRIDAY, SATURDAY]): void {
  seedAvailabilityMatrix(db, {
    players: ids,
    days,
    statuses: ids.map(() => days.map(() => "available" as const)),
  });
}

describe("getLineupBuild — the day is the target", () => {
  useTnDbPath();

  it("reads eligibility for the TARGET day only: unavailable Friday is still eligible Saturday", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedBuild(db, { season: TEN.slice(0, 8), format: FORMAT });
      const ids = TEN.slice(0, 8).map((n) => fixture.ids[n]!);
      seedAvailabilityMatrix(db, {
        players: ids,
        days: [FRIDAY, SATURDAY],
        // Player 01 is out Friday and in Saturday; everyone else is in on both.
        statuses: ids.map((_, i) => (i === 0 ? ["unavailable", "available"] : ["available", "available"])),
      });

      const friday = getLineupBuild(db, { day: FRIDAY });
      const saturday = getLineupBuild(db, { day: SATURDAY });

      expect(friday.day).toBe(FRIDAY);
      expect(friday.ledger.unavailable.map((p) => p.playerId)).toEqual([ids[0]]);
      expect(friday.ledger.available.map((p) => p.playerId)).not.toContain(ids[0]);
      expect(friday.eligibleCount).toBe(7);

      expect(saturday.ledger.unavailable).toEqual([]);
      expect(saturday.ledger.available.map((p) => p.playerId)).toContain(ids[0]);
      expect(saturday.eligibleCount).toBe(8);
    } finally {
      sqlite.close();
    }
  });

  it("keeps uncertain and unrecorded out of every court AND in their own ledger buckets", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 4);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      seedAvailabilityMatrix(db, {
        players: ids,
        days: [SATURDAY],
        statuses: [["available"], ["unavailable"], ["uncertain"], [null]],
      });

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.ledger.available.map((p) => p.playerId)).toEqual([ids[0]]);
      expect(build.ledger.unavailable.map((p) => p.playerId)).toEqual([ids[1]]);
      expect(build.ledger.uncertain.map((p) => p.playerId)).toEqual([ids[2]]);
      expect(build.ledger.unrecorded.map((p) => p.playerId)).toEqual([ids[3]]);
      // The case that would pass if all three absences were collapsed into one bucket.
      expect(build.eligibleCount).toBe(1);
      for (const scenario of build.scenarios) {
        const placed = scenario.courts.flatMap((c) => c.players.map((p) => p.playerId));
        expect(placed).toEqual([ids[0]]);
      }
    } finally {
      sqlite.close();
    }
  });

  it("refuses a stored availability status our own writer could never have produced", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 3);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids, [SATURDAY]);
      // Hand-corrupted, the way only a direct edit could produce — a status outside the three
      // silently belongs to no ledger bucket, so the player would vanish from the page entirely.
      db.update(availability).set({ status: "maybe" }).where(eq(availability.playerId, ids[0]!)).run();

      expect(() => getLineupBuild(db, { day: SATURDAY })).toThrow(InvalidAvailabilityStatusError);
    } finally {
      sqlite.close();
    }
  });
});

describe("getLineupBuild — the roster", () => {
  useTnDbPath();

  it("builds over the REGISTERED field, not the season roster", () => {
    const { db, sqlite } = freshDb();
    try {
      const registered = TEN.slice(0, 7);
      const fixture = seedBuild(db, { season: TEN, registered, format: FORMAT });
      allAvailable(db, TEN.map((n) => fixture.ids[n]!));

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.rosterSource).toBe("registered");
      expect(build.registeredCount).toBe(7);
      expect(build.seasonCount).toBe(10);
      expect(build.rosterSize).toBe(7);
      const ledgerIds = [
        ...build.ledger.available,
        ...build.ledger.unavailable,
        ...build.ledger.uncertain,
        ...build.ledger.unrecorded,
      ].map((p) => p.playerId);
      expect(ledgerIds.sort((a, b) => a - b)).toEqual(registered.map((n) => fixture.ids[n]!).sort((a, b) => a - b));
      for (const name of TEN.slice(7)) expect(ledgerIds).not.toContain(fixture.ids[name]!);
    } finally {
      sqlite.close();
    }
  });

  it("a soft-retired member reaches neither the ledger nor a court", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 5);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);

      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, ids[0]!))
        .run();

      const build = getLineupBuild(db, { day: SATURDAY });

      const everyone = [
        ...build.ledger.available,
        ...build.ledger.unavailable,
        ...build.ledger.uncertain,
        ...build.ledger.unrecorded,
      ].map((p) => p.playerId);
      expect(everyone).not.toContain(ids[0]);
      expect(build.rosterSize).toBe(4);
      for (const scenario of build.scenarios) {
        const placed = scenario.courts.flatMap((c) => c.players.map((p) => p.playerId));
        expect(placed).not.toContain(ids[0]);
      }
    } finally {
      sqlite.close();
    }
  });

  // The double-derivation class PR #134 closed three times over. Asserted by COUNTING the membership
  // selects through `openDb`'s `verbose` seam — the same technique test/query-roster.test.ts uses —
  // because a second resolution returns the same answer here and only the count distinguishes them.
  it("resolves the roster EXACTLY once, and hands that one resolution to every reader", () => {
    runMigrations();
    const statements: string[] = [];
    const { db, sqlite } = openDb(process.env.TN_DB_PATH, { verbose: (m) => statements.push(String(m)) });
    try {
      const names = TEN.slice(0, 6);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);

      statements.length = 0;
      const build = getLineupBuild(db, { day: SATURDAY });
      expect(build.rosterSize).toBe(6);

      const membershipSelects = statements.filter((s) => /select/i.test(s) && /team_memberships/i.test(s));
      expect(membershipSelects).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  // The event is resolved ONCE and threaded down — never re-resolved by name inside a helper, the
  // shape `getLineupPlan`'s `ResolvedEvent` brand exists to hold shut. Counted the same way, and
  // each of the three reads is named so a FOURTH has to be argued for rather than slipped in.
  it("reads the events table exactly three times: the day lookup, the resolution, and the day range", () => {
    runMigrations();
    const statements: string[] = [];
    const { db, sqlite } = openDb(process.env.TN_DB_PATH, { verbose: (m) => statements.push(String(m)) });
    try {
      const names = TEN.slice(0, 6);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      allAvailable(db, names.map((n) => fixture.ids[n]!));

      statements.length = 0;
      getLineupBuild(db, { day: SATURDAY });

      const eventSelects = statements.filter((s) => /select/i.test(s) && /from "events"/i.test(s));
      expect(eventSelects).toHaveLength(3);
    } finally {
      sqlite.close();
    }
  });

  it("names the event the DAY resolved to, and fields that event's courts — not another event's", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 7);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      allAvailable(db, names.map((n) => fixture.ids[n]!));
      // A second event, different courts, a range that does NOT cover the target day.
      addEvent(db, {
        name: "Some Other Event",
        kind: "league",
        startsOn: "2026-05-01",
        endsOn: "2026-05-02",
        format: "S1:singles,S2:singles",
      });

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.event).toEqual({ id: fixture.eventId, name: EVENT });
      expect(build.slotSet.map((c) => c.slot)).toEqual(["S1", "D1", "D2", "D3"]);
      for (const scenario of build.scenarios) {
        expect(scenario.courts.map((c) => c.slot)).toEqual(["S1", "D1", "D2", "D3"]);
      }
    } finally {
      sqlite.close();
    }
  });
});

describe("getLineupBuild — the evidence is this team's own", () => {
  useTnDbPath();

  it("a pair's matches together for ANOTHER team read 0, and are reported as excluded", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 8);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);

      // Two players with a long partnership — for a DIFFERENT team. This is the PR #47 defect: read
      // by player id alone it would report a confident "6 matches together" for a pair that has
      // never once played together for us.
      const otherTeam = db.insert(teams).values({ name: "Their Other Team" }).returning().get();
      const theirOpponent = db.insert(teams).values({ name: "Their Other Opponent" }).returning().get();
      const theirMatch = db
        .insert(teamMatches)
        .values({ homeTeamId: otherTeam.id, visitingTeamId: theirOpponent.id, sourceMatchId: "theirs-1" })
        .returning()
        .get();
      playDoubles(db, [ids[0]!, ids[1]!], 6, theirMatch.id);
      // And one real partnership of ours, so the zero above is legible as a scoped zero rather than
      // as an empty database.
      playDoubles(db, [ids[2]!, ids[3]!], 3, fixture.ourMatch.id);

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.excludedOtherTeamMatches).toBe(6);
      expect(build.observedCourtMatches).toBe(3);

      // The counterfactual, stated as the assertion: read by player id alone, (0,1)'s SIX borrowed
      // matches would beat (2,3)'s three and take D1. Scoped to our own team matches, D1 is (2,3).
      const history = build.scenarios.find((s) => s.strategies.includes("history-first"))!;
      const d1 = history.courts.find((c) => c.slot === "D1")!;
      expect(d1.players.map((p) => p.playerId).sort((a, b) => a - b)).toEqual(
        [ids[2]!, ids[3]!].sort((a, b) => a - b),
      );
      expect(d1.sharedMatches).toBe(3);

      // And nowhere in any scenario does a borrowed partnership surface as shared history: 3 is the
      // only positive count on the whole page.
      const positive = build.scenarios
        .flatMap((s) => s.courts.map((c) => c.sharedMatches))
        .filter((n): n is number => n !== null && n > 0);
      expect([...new Set(positive)]).toEqual([3]);
    } finally {
      sqlite.close();
    }
  });

  it("a pair who played together AGAINST us, in one of our own matches, reads 0 — not a partnership", () => {
    // Codex adversarial review of PR #137, class A. "This court match is ours" and "this player was
    // on our side of it" are different facts. Two players who are on our roster NOW may have played
    // a court under one of our team matches for the OPPONENT — they changed teams between seasons —
    // and they share the opposing side with each other, so an unfiltered row lets `partnerFrequency`
    // count a partnership formed against us. `history-first` would then print it as "N matches
    // together" under a rule whose own sentence says "for this team".
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 8);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);

      // Six courts under OUR OWN team match, with this pair on the OPPONENT's side.
      playDoubles(db, [ids[0]!, ids[1]!], 6, fixture.ourMatch.id, "visiting");
      // And three on our side, so a scoped zero above is legible rather than an empty database.
      playDoubles(db, [ids[2]!, ids[3]!], 3, fixture.ourMatch.id, "home");
      // THE FIXTURE DETAIL THAT MAKES THIS TEST MEAN ANYTHING, and it was got wrong first time.
      // Without singles history the whole roster is unrated, so `history-first`'s S1 falls through to
      // the lowest playerId and takes ids[0] — which removes half the contaminated pair from the pool
      // before any doubles court is chosen, and the assertion below then passes whether or not the
      // side filter exists. Giving ids[7] the singles history sends S1 there instead and leaves
      // (0,1) free to be picked, so the filter is the only thing that can keep them off D1. These
      // rows sit on OUR side, so they steer S1 identically with and without the fix.
      playSingles(db, ids[7]!, 2, fixture.ourMatch.id);

      const build = getLineupBuild(db, { day: SATURDAY });

      // Every one of these courts IS ours, so none is "excluded" — which is exactly why the
      // team-linkage restriction alone cannot catch this case, and why the side filter is a second,
      // independent guard rather than a tightening of the first.
      expect(build.excludedOtherTeamMatches).toBe(0);
      // The evidence line counts what SURVIVED the side filter — the three doubles courts on our
      // side plus the two singles — not all eleven of our courts. Reporting 11 here would offer six
      // courts as support for counts they contributed nothing to (Codex final pass, class A: a
      // defect in the fix that added the filter). The six are not dropped, they move to their own
      // counter, which is a different fact from `excludedOtherTeamMatches` and stays separate.
      expect(build.observedCourtMatches).toBe(5);
      expect(build.excludedOpposingSideMatches).toBe(6);
      const history0 = build.scenarios.find((s) => s.strategies.includes("history-first"))!;
      expect(history0.courts.find((c) => c.slot === "S1")!.players.map((p) => p.playerId)).toEqual([ids[7]!]);

      // The counterfactual, stated as the assertion: counted without the side filter, (0,1)'s SIX
      // against-us courts beat (2,3)'s three and would take D1.
      const history = build.scenarios.find((s) => s.strategies.includes("history-first"))!;
      const d1 = history.courts.find((c) => c.slot === "D1")!;
      expect(d1.players.map((p) => p.playerId).sort((a, b) => a - b)).toEqual(
        [ids[2]!, ids[3]!].sort((a, b) => a - b),
      );
      expect(d1.sharedMatches).toBe(3);

      // 3 is the only positive shared count anywhere on the page — the 6 never becomes a partnership.
      const positive = build.scenarios
        .flatMap((s) => s.courts.map((c) => c.sharedMatches))
        .filter((n): n is number => n !== null && n > 0);
      expect([...new Set(positive)]).toEqual([3]);
    } finally {
      sqlite.close();
    }
  });

  it("a court kept only by a NON-roster player on our side is not evidence either", () => {
    // Codex fix-verification pass 3, class A — the same defect one step sideways, which is what
    // moved the fix from "filter harder" to "ask a different question". `courtMatchRowsForPlayers`
    // pre-joins EVERY participant, so a court retained because a roster member played it on the
    // OPPOSING side can still keep a NON-roster team-mate of ours on our side. A predicate of "did
    // the filter leave anybody standing" counts that court as evidence; it contributes to nothing,
    // because every count on the page is computed over this roster's ids.
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 6);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);

      // Somebody who plays for us but is NOT on this roster — no `team_memberships` row at all.
      const outsider = db.insert(players).values({ canonicalName: "Zed Zephyr" }).returning().get();
      backfillNameKeys(db);

      // Two courts under OUR match: a roster member on the opponent's side, the outsider on ours.
      // Retained because ids[0] is in the query set; emptied of roster members by the side filter;
      // still non-empty, because the outsider survives it.
      playDoubles(db, [ids[0]!, ids[1]!], 2, fixture.ourMatch.id, "visiting");
      const court = upsertCourtMatch(db, {
        teamMatchId: fixture.ourMatch.id,
        slot: "D1",
        discipline: "doubles",
        winnerSide: "home",
        score: "6-1 6-1",
        leagueContext: "40+ 3.5",
        playedOn: "2026-05-02",
        sourceMatchId: "outsider-court",
      });
      upsertCourtMatchPlayers(db, { courtMatchId: court.id, playerId: ids[0]!, side: "visiting" });
      upsertCourtMatchPlayers(db, { courtMatchId: court.id, playerId: outsider.id, side: "home" });

      const build = getLineupBuild(db, { day: SATURDAY });

      // Three of our courts are retained; NONE of them puts one of these players on our side, so
      // none is evidence. Counting the outsider's court would offer support for a count nobody made.
      expect(build.observedCourtMatches).toBe(0);
      expect(build.excludedOpposingSideMatches).toBe(3);
      expect(build.excludedOtherTeamMatches).toBe(0);
      const positive = build.scenarios
        .flatMap((s) => s.courts.map((c) => c.sharedMatches))
        .filter((n): n is number => n !== null && n > 0);
      expect(positive).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("a roster with NO court-match history at all still produces scenarios — it does not refuse", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 7);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);

      // The refusal `getLineupPlan` carries and this must NOT inherit: availability is the input,
      // history is a soft signal, and refusing here would fail on exactly the newly-assembled
      // roster this feature exists to serve.
      let build: ReturnType<typeof getLineupBuild> | undefined;
      expect(() => {
        build = getLineupBuild(db, { day: SATURDAY });
      }).not.toThrow();
      expect(() => getLineupBuild(db, { day: SATURDAY })).not.toThrow(NoCourtMatchHistoryError);

      expect(build!.observedCourtMatches).toBe(0);
      expect(build!.scenarios.length).toBeGreaterThan(0);
      for (const scenario of build!.scenarios) {
        for (const court of scenario.courts.filter((c) => c.discipline === "doubles")) {
          expect(court.sharedMatches).toBe(0);
        }
      }
    } finally {
      sqlite.close();
    }
  });

  it("ranks within one rating source and names it", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 7);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);
      const values = [4.5, 4.4, 4.2, 4.0, 3.9, 3.7, 3.5];
      ids.forEach((id, i) => rate(db, id, values[i]!));

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.ratingSource).toBe("tr_dynamic");
      expect(build.ratedEligible).toBe(7);
      const strength = build.scenarios.find((s) => s.strategies.includes("strength-first"))!;
      expect(strength.courts[0]!.players.map((p) => p.playerId)).toEqual([ids[0]]);
      expect(strength.courts[0]!.players[0]!.rating).toBe(4.5);
    } finally {
      sqlite.close();
    }
  });
});

describe("getLineupBuild — captain notes", () => {
  useTnDbPath();

  it("surfaces a player note and a pairing note, and drops one about a season-only player", () => {
    const { db, sqlite } = freshDb();
    try {
      const registered = TEN.slice(0, 6);
      const fixture = seedBuild(db, { season: TEN, registered, format: FORMAT });
      const ids = registered.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);

      addCaptainNote(db, { playerId: ids[0]!, text: "serves big under pressure" });
      addCaptainNote(db, { playerId: ids[1]!, pairPlayerId: ids[2]!, text: "great net chemistry" });
      // A season-roster player who did not register: the writer accepts the note (any current
      // membership), the event-scoped reader does not show it. The known writer/reader asymmetry,
      // pinned here so it is documented rather than surprising.
      const seasonOnly = fixture.ids[TEN[9]!]!;
      addCaptainNote(db, { playerId: seasonOnly, text: "not registered for this one" });

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.captainNotes.player.map((n) => n.playerId)).toEqual([ids[0]]);
      expect(build.captainNotes.pairing).toHaveLength(1);
      expect(build.captainNotes.pairing[0]!.playerId).toBe(ids[1]);
      expect(build.captainNotes.pairing[0]!.pairPlayerId).toBe(ids[2]);
      expect(build.captainNotes.player.map((n) => n.playerId)).not.toContain(seasonOnly);
    } finally {
      sqlite.close();
    }
  });
});

// #149 Task 3/4: `plays` joins into the roster exactly as `ageRange` already does, decoded
// fail-closed by `readPlays`, and threaded into `buildDayScenarios` alongside `status`. These cover
// the part the pure-layer tests (`test/query-derive-lineup-build.test.ts`) cannot see — that a value
// actually written by `setPlays` reaches the derivation THROUGH the real roster join, and that a
// hand-corrupted column is refused the same way a corrupted `availability.status` already is.
describe("getLineupBuild — the doubles-only constraint (#149)", () => {
  useTnDbPath();

  it("refuses a stored plays value our own writer could never have produced (readPlays fails closed)", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 3);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids, [SATURDAY]);
      // Hand-corrupted, the way only a direct edit could produce.
      db.update(players).set({ plays: "singles-only" }).where(eq(players.id, ids[0]!)).run();

      expect(() => getLineupBuild(db, { day: SATURDAY })).toThrow(InvalidPlaysError);
    } finally {
      sqlite.close();
    }
  });

  it("a doubles-only player's constraint, written through setPlays, reaches buildDayScenarios through the roster join", () => {
    const { db, sqlite } = freshDb();
    try {
      // 8 available for the format's 7 seats (S1 + D1-D3) — strictly more bodies than seats, so
      // the placement below cannot be explained by the existing shortfall path
      // (test/query-derive-lineup-build.test.ts's own "the fixture trap" note applies here too).
      const names = TEN.slice(0, 8);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);
      const values = [4.5, 4.4, 4.2, 4.0, 3.9, 3.7, 3.5, 3.3];
      ids.forEach((id, i) => rate(db, id, values[i]!));
      // The strongest player on file is doubles-only.
      setPlays(db, { player: names[0]!, plays: "doubles-only" });

      const build = getLineupBuild(db, { day: SATURDAY });

      const strength = build.scenarios.find((s) => s.strategies.includes("strength-first"))!;
      // S1 must skip the strongest (doubles-only) player and go to the next strongest instead —
      // the placement is only explicable if `setPlays`'s write actually reached the derivation.
      expect(strength.courts[0]!.players.map((p) => p.playerId)).toEqual([ids[1]]);
      expect(strength.courts[0]!.constraintOverride).toBeNull();

      const holding = strength.courts.find((c) => c.players.some((p) => p.playerId === ids[0]));
      expect(holding?.discipline).toBe("doubles");
      // #149: `singlesEligibleCount` is derived once in `buildDayScenarios` (derive-lineup-build.ts)
      // but has to be THREADED through `getLineupBuild`'s own return shape to reach a presenter or
      // the `lineup_build` MCP tool (which returns this object verbatim) — a defect found while
      // implementing the presenter's day-level line, which reads exactly this field.
      expect(build.singlesEligibleCount).toBe(7); // 8 eligible minus the one doubles-only player
    } finally {
      sqlite.close();
    }
  });

  it("singlesEligibleCount reaches getLineupBuild's own result as 0 when every available player is doubles-only", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 3);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);
      for (const name of names) setPlays(db, { player: name, plays: "doubles-only" });

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.singlesEligibleCount).toBe(0);
      expect(build.eligibleCount).toBe(3);
    } finally {
      sqlite.close();
    }
  });
});

describe("getLineupBuild — refusals, one class per reason", () => {
  useTnDbPath();

  it("no home team designated (NoHomeTeamError)", () => {
    const { db, sqlite } = freshDb();
    try {
      addEvent(db, {
        name: EVENT,
        kind: "tournament",
        startsOn: FRIDAY,
        endsOn: "2026-08-30",
        format: FORMAT,
      });
      expect(() => getLineupBuild(db, { day: SATURDAY })).toThrow(NoHomeTeamError);
    } finally {
      sqlite.close();
    }
  });

  it("a malformed day, including one that is well-shaped but not a real date (InvalidAvailabilityDayError)", () => {
    const { db, sqlite } = freshDb();
    try {
      seedBuild(db, { season: TEN.slice(0, 4), format: FORMAT });
      expect(() => getLineupBuild(db, { day: "2026-02-31" })).toThrow(InvalidAvailabilityDayError);
      expect(() => getLineupBuild(db, { day: "banana" })).toThrow(InvalidAvailabilityDayError);
    } finally {
      sqlite.close();
    }
  });

  it("a day inside no event (NoEventForDayError)", () => {
    const { db, sqlite } = freshDb();
    try {
      seedBuild(db, { season: TEN.slice(0, 4), format: FORMAT });
      expect(() => getLineupBuild(db, { day: "2099-01-01" })).toThrow(NoEventForDayError);
    } finally {
      sqlite.close();
    }
  });

  it("a day inside two events with no name given (AmbiguousEventForDayError)", () => {
    const { db, sqlite } = freshDb();
    try {
      seedBuild(db, { season: TEN.slice(0, 4), format: FORMAT });
      addEvent(db, {
        name: "Overlapping League",
        kind: "league",
        startsOn: "2026-08-01",
        endsOn: "2026-09-30",
        format: FORMAT,
      });
      expect(() => getLineupBuild(db, { day: SATURDAY })).toThrow(AmbiguousEventForDayError);
      // ...and naming one resolves it, which is what makes the refusal a disambiguator.
      expect(getLineupBuild(db, { day: SATURDAY, eventName: "Overlapping League" }).event.name).toBe(
        "Overlapping League",
      );
    } finally {
      sqlite.close();
    }
  });

  it("a named event that does not cover the day (EventDoesNotCoverDayError)", () => {
    const { db, sqlite } = freshDb();
    try {
      seedBuild(db, { season: TEN.slice(0, 4), format: FORMAT });
      addEvent(db, {
        name: "May League",
        kind: "league",
        startsOn: "2026-05-01",
        endsOn: "2026-05-02",
        format: FORMAT,
      });
      expect(() => getLineupBuild(db, { day: SATURDAY, eventName: "May League" })).toThrow(EventDoesNotCoverDayError);
    } finally {
      sqlite.close();
    }
  });

  it("a named event nothing on file carries (UnknownEventError)", () => {
    const { db, sqlite } = freshDb();
    try {
      seedBuild(db, { season: TEN.slice(0, 4), format: FORMAT });
      expect(() => getLineupBuild(db, { day: SATURDAY, eventName: "No Such Event" })).toThrow(UnknownEventError);
    } finally {
      sqlite.close();
    }
  });

  it("an event with no format on file (EventHasNoFormatError)", () => {
    const { db, sqlite } = freshDb();
    try {
      seedBuild(db, { season: TEN.slice(0, 4) });
      expect(() => getLineupBuild(db, { day: SATURDAY })).toThrow(EventHasNoFormatError);
    } finally {
      sqlite.close();
    }
  });
});

describe("getLineupBuild — shortfall and disclosure", () => {
  useTnDbPath();

  it("reports a shortfall rather than double-booking to fill the courts", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 6);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      allAvailable(db, ids);

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.bodiesNeeded).toBe(7);
      expect(build.eligibleCount).toBe(6);
      expect(build.shortfall).toBe(1);
      for (const scenario of build.scenarios) {
        expect(scenario.unfilledSlots).toEqual(["D3"]);
        const placed = scenario.courts.flatMap((c) => c.players.map((p) => p.playerId));
        expect(new Set(placed).size).toBe(placed.length);
      }
    } finally {
      sqlite.close();
    }
  });

  it("nobody available at all: every slot unfilled, everyone in the ledger, no refusal", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 4);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      const ids = names.map((n) => fixture.ids[n]!);
      for (const id of ids) setAvailability(db, { playerId: id, day: SATURDAY, status: "unavailable" });

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.eligibleCount).toBe(0);
      expect(build.shortfall).toBe(7);
      expect(build.ledger.unavailable).toHaveLength(4);
      for (const scenario of build.scenarios) {
        expect(scenario.unfilledSlots).toEqual(["S1", "D1", "D2", "D3"]);
      }
    } finally {
      sqlite.close();
    }
  });

  it("a home team with NO roster at all still builds: empty ledger, every slot unfilled, no refusal", () => {
    const { db, sqlite } = freshDb();
    try {
      seedBuild(db, { season: [], format: FORMAT });

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.rosterSize).toBe(0);
      expect(build.eligibleCount).toBe(0);
      expect(build.shortfall).toBe(7);
      expect(build.ratingSource).toBeNull();
      expect(build.observedCourtMatches).toBe(0);
      expect(build.excludedOtherTeamMatches).toBe(0);
      expect(build.captainNotes).toEqual({ player: [], pairing: [] });
      for (const bucket of Object.values(build.ledger)) expect(bucket).toEqual([]);
      for (const scenario of build.scenarios) {
        expect(scenario.unfilledSlots).toEqual(["S1", "D1", "D2", "D3"]);
      }
    } finally {
      sqlite.close();
    }
  });

  it("carries the team, the day, and the roster provenance a presenter has to state", () => {
    const { db, sqlite } = freshDb();
    try {
      const names = TEN.slice(0, 7);
      const fixture = seedBuild(db, { season: names, format: FORMAT });
      allAvailable(db, names.map((n) => fixture.ids[n]!));

      const build = getLineupBuild(db, { day: SATURDAY });

      expect(build.teamId).toBe(fixture.teamId);
      expect(build.teamName).toBe(fixture.teamName);
      expect(build.day).toBe(SATURDAY);
      expect(build.event.name).toBe(EVENT);
      expect(build.rosterSource).toBe("season");
      expect(build.seasonCount).toBe(7);
      // Names, never raw ids — the defect #16 shipped into a printed dossier.
      expect(JSON.stringify(build)).not.toMatch(/player #\d/);
    } finally {
      sqlite.close();
    }
  });
});
