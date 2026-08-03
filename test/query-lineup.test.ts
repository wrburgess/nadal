// The DB assembly layer for the predicted lineup (#17 PR B). The heuristic's own behavior is
// specified exhaustively in `query-derive-lineup.test.ts` against hand-built inputs; what these
// tests check is the part that layer cannot see — that the right rows are fetched, that names are
// attached, that a duplicate membership row does not clone a player onto two courts, and that a
// team with no history refuses rather than returning an empty lineup.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { events, players, ratingObservations, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { setAvailability } from "../src/query/availability.js";
import { addEvent } from "../src/query/events.js";
import { InvalidEventFormatError } from "../src/query/event-format.js";
import {
  EventHasNoFormatError,
  NoCourtMatchHistoryError,
  UnknownEventError,
  getLineupPlan,
  resolveEventFormat,
} from "../src/query/lineup.js";
import { resolveTeamTarget } from "../src/query/team-profile.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

let nextMid = 0;

/** One doubles court match with `ours` on the home side and two anonymous opponents opposite. */
/** A `team_matches` row for `teamId`, so court matches can be linked to a real team — which is how
 * production tells "this team's match" from "a roster member's match for someone else". */
let nextOpponent = 0;
function linkTeamMatch(db: Db, teamId: number, sourceMatchId: string, side: "home" | "visiting" = "home") {
  nextOpponent += 1;
  const opponent = db.insert(teams).values({ name: `Opponent ${nextOpponent}` }).returning().get();
  return db
    .insert(teamMatches)
    .values({
      homeTeamId: side === "home" ? teamId : opponent.id,
      visitingTeamId: side === "home" ? opponent.id : teamId,
      sourceMatchId,
    })
    .returning()
    .get();
}

function playDoubles(db: Db, slot: string, ours: number[], times: number, linked?: { id: number }): void {
  for (let i = 0; i < times; i++) {
    nextMid += 1;
    const cm = upsertCourtMatch(db, {
      teamMatchId: linked?.id ?? null,
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

function playSingles(db: Db, slot: string, playerId: number, times: number, linked?: { id: number }): void {
  for (let i = 0; i < times; i++) {
    nextMid += 1;
    const cm = upsertCourtMatch(db, {
      teamMatchId: linked?.id ?? null,
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

/** Seeds the team, its roster, and ONE `team_matches` row for it — court matches must be linked to
 * a team match of this team to count as its history (see `getLineupPlan`), which is what production
 * produces: `tn team pull` writes the schedule, then each player pull links to it by `mid=`. */
function seedTeam(db: Db, names: string[]): { teamId: number; ids: Record<string, number>; ourMatch: { id: number } } {
  const team = db.insert(teams).values({ name: "IA/Versteeg/40&Over3.5M" }).returning().get();
  const ids: Record<string, number> = {};
  for (const name of names) {
    const p = db.insert(players).values({ canonicalName: name }).returning().get();
    ids[name] = p.id;
    db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
  }
  const ourMatch = linkTeamMatch(db, team.id, "seed-default");
  backfillNameKeys(db);
  return { teamId: team.id, ids, ourMatch };
}

describe("getLineupPlan", () => {
  useTnDbPath();

  it("returns a named lineup built from the roster's own court-match history", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder", "Del Duxbury", "Emory Ellerby"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 6, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 5, ourMatch);
      playDoubles(db, "D2", [ids["Del Duxbury"]!, ids["Emory Ellerby"]!], 4, ourMatch);

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
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder", "Del Duxbury"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 3, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 3, ourMatch);
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
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 2, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 2, ourMatch);
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
      expect(plan.unranked.map((p) => p.canonicalName)).toEqual(["Ada Ashby"]);
      // THE assertion: Cy (4.0, current) must outrank Bo (3.2, current). Reading Bo's stale
      // January 4.5 instead inverts this — and asserting only `unranked` above would not notice,
      // since both players are rated either way.
      expect(plan.ranked.map((p) => p.canonicalName)).toEqual(["Cy Calder", "Bo Bramwell"]);
    } finally {
      sqlite.close();
    }
  });

  it("counts a player on two event rosters once, so nobody is placed on two courts", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      // A district roster row AND a travel roster row for the same player — the normal case per
      // spec § Domain model ("rosters differ per event").
      const event = db
        .insert(events)
        .values({ name: "Springfield Sectionals 2026", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
        .returning()
        .get();
      db.insert(teamMemberships).values({ playerId: ids["Ada Ashby"]!, teamId, eventId: event.id }).run();

      playSingles(db, "S1", ids["Ada Ashby"]!, 3, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 3, ourMatch);

      const plan = getLineupPlan(db, teamId);

      expect(plan.rosterSize, "one person, two membership rows").toBe(3);
      const placedIds = plan.slots.flatMap((s) => s.players.map((p) => p.playerId));
      expect(new Set(placedIds).size).toBe(placedIds.length);
    } finally {
      sqlite.close();
    }
  });

  // Found by the independent Codex review of PR #47 (rated high). Spec § Ingestion says a player's
  // match history is ingested "including their other leagues (18+ etc.)", so a roster member's
  // court matches are NOT this team's court matches. Selecting evidence by player id alone let one
  // team's predicted lineup be built from partnerships those players formed on a DIFFERENT team —
  // a confident "8 matches together" for a pair that has never played together for this team.
  it("ignores court matches this roster played for OTHER teams", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder", "Del Duxbury", "Emory Ellerby"]);

      // This team's own history: Ada at S1, and Bo/Cy as a pair — linked to a real team match.
      playSingles(db, "S1", ids["Ada Ashby"]!, 4, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 3, ourMatch);

      // The SAME players' history for a different team: Del and Emory are an established pairing
      // over there, with more matches than anything on this roster. That must not become this
      // team's D2.
      const otherTeam = db.insert(teams).values({ name: "Some Other Club/18&Over4.0M" }).returning().get();
      const theirMatch = linkTeamMatch(db, otherTeam.id, "their-1");
      playDoubles(db, "D2", [ids["Del Duxbury"]!, ids["Emory Ellerby"]!], 9, theirMatch);

      const plan = getLineupPlan(db, teamId);

      expect(plan.slots.map((s) => s.slot), "D2 was never fielded by THIS team").toEqual(["S1", "D1"]);
      expect(plan.observedCourtMatches, "only this team's 7 court matches count").toBe(7);
      expect(plan.excludedOtherTeamMatches, "and the 9 elsewhere are reported, not hidden").toBe(9);
      // Del and Emory are on the roster with no history HERE, so they are unplaced — never placed
      // as a "high confidence" pairing on another team's evidence.
      expect(plan.unplaced.map((p) => p.canonicalName).sort()).toEqual(["Del Duxbury", "Emory Ellerby"]);
    } finally {
      sqlite.close();
    }
  });

  it("refuses a team whose roster has history only for other teams", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids } = seedTeam(db, ["Ada Ashby", "Bo Bramwell"]);
      const otherTeam = db.insert(teams).values({ name: "Some Other Club/18&Over4.0M" }).returning().get();
      const theirMatch = linkTeamMatch(db, otherTeam.id, "their-only");
      playDoubles(db, "D1", [ids["Ada Ashby"]!, ids["Bo Bramwell"]!], 6, theirMatch);

      // The refusal is the honest answer: we know these people play together, we know nothing about
      // how THIS team fields courts.
      expect(() => getLineupPlan(db, teamId)).toThrow(NoCourtMatchHistoryError);
    } finally {
      sqlite.close();
    }
  });

  it("reports zero excluded when every match belongs to this team", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 2, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 2, ourMatch);

      expect(getLineupPlan(db, teamId).excludedOtherTeamMatches).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("excludes an UNLINKED court match rather than assuming it belongs to this team", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 2, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 2, ourMatch);
      // No `team_match_id` — a history row whose team we simply do not know. Conservative on
      // purpose: assuming it belongs here is precisely how the cross-team defect happened.
      playDoubles(db, "D2", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 5);

      const plan = getLineupPlan(db, teamId);
      expect(plan.slots.map((s) => s.slot)).toEqual(["S1", "D1"]);
      expect(plan.excludedOtherTeamMatches).toBe(5);
    } finally {
      sqlite.close();
    }
  });

  it("counts a court match linked to a team match where this team is the VISITING side", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      // home/visiting are pull-perspective labels, so evidence must be found from either column.
      const away = linkTeamMatch(db, teamId, "away-1", "visiting");
      playSingles(db, "S1", ids["Ada Ashby"]!, 2, away);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 2, away);

      const plan = getLineupPlan(db, teamId);
      expect(plan.slots.map((s) => s.slot)).toEqual(["S1", "D1"]);
      expect(plan.observedCourtMatches).toBe(4);
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

  // Issue #49: the headline symptom from the issue — a departed player predicted onto a court.
  it("a retired member is absent from the predicted lineup entirely — never placed, never unplaced, never ranked", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 6, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 5, ourMatch);

      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, ids["Ada Ashby"]!))
        .run();

      const plan = getLineupPlan(db, teamId);

      expect(plan.rosterSize, "3 roster rows minus the 1 retired one").toBe(2);
      const retiredId = ids["Ada Ashby"]!;
      const everyPlacedId = plan.slots.flatMap((s) => s.players.map((p) => p.playerId));
      expect(everyPlacedId).not.toContain(retiredId);
      expect(plan.unplaced.map((p) => p.playerId)).not.toContain(retiredId);
      expect(plan.ranked.map((p) => p.playerId)).not.toContain(retiredId);
      expect(plan.unranked.map((p) => p.playerId)).not.toContain(retiredId);
    } finally {
      sqlite.close();
    }
  });

  // Issue #49: asserts the CONFIDENCE path, not just the absence — a naive fix that merely hid the
  // retired player from the printed roster while leaving their partnership evidence intact could
  // still silently substitute a phantom partner (or keep reporting "high confidence" for a pairing
  // that no longer exists). The right answer is a DEGRADE: the surviving player alone, at low
  // confidence, on a rating-only basis — never a fabricated partner and never the old confidence.
  it("a lineup whose only high-confidence pairing involved a retired member degrades rather than silently substituting", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Bo Bramwell", "Cy Calder"]);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 6, ourMatch);

      const before = getLineupPlan(db, teamId);
      expect(before.slots).toEqual([
        expect.objectContaining({ slot: "D1", confidence: "high", basis: "history", support: 6 }),
      ]);

      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, ids["Cy Calder"]!))
        .run();

      const after = getLineupPlan(db, teamId);

      expect(after.rosterSize).toBe(1);
      const slot = after.slots.find((s) => s.discipline === "doubles")!;
      expect(slot.players.map((p) => p.playerId)).toEqual([ids["Bo Bramwell"]]);
      expect(slot.confidence, "degraded, not the old high confidence").toBe("low");
      expect(slot.basis, "no fabricated partnership survives the retirement").toBe("rating");
      expect(slot.support).toBe(0);
      expect(JSON.stringify(after)).not.toContain("Cy Calder");
    } finally {
      sqlite.close();
    }
  });

  it("resolves its target through the same resolveTeamTarget every other team command uses", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 2, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 2, ourMatch);

      const resolution = resolveTeamTarget(db, "IA/Versteeg/40&Over3.5M");
      expect(resolution.kind).toBe("ok");
      if (resolution.kind !== "ok") throw new Error("expected ok");
      expect(getLineupPlan(db, resolution.teamId).teamId).toBe(teamId);
    } finally {
      sqlite.close();
    }
  });
});

// #63: `getLineupPlan`'s optional third argument — an event name, resolved by exact `events.name`
// (the same mechanism `src/ingest/match-add.ts` already uses, never inferred).
describe("getLineupPlan — an event's format overrides the derived slot set", () => {
  useTnDbPath();

  it("uses the named event's courts, in the format's order, and names the event on the result", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder", "Del Duxbury", "Emory Ellerby"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 6, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 5, ourMatch);
      playDoubles(db, "D2", [ids["Del Duxbury"]!, ids["Emory Ellerby"]!], 4, ourMatch);
      const event = addEvent(db, {
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "S1:singles,D1:doubles",
      });

      const plan = getLineupPlan(db, teamId, "Springfield Sectionals 2026");

      expect(plan.slots.map((s) => s.slot), "D2 is real history but not part of the event's format").toEqual([
        "S1",
        "D1",
      ]);
      expect(plan.slotSource).toBe("event-format");
      expect(plan.slotEvent).toEqual({ id: event.eventId, name: "Springfield Sectionals 2026" });
    } finally {
      sqlite.close();
    }
  });

  it("refuses an unknown event name", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 3, ourMatch);
      expect(() => getLineupPlan(db, teamId, "No Such Event")).toThrow(UnknownEventError);
    } finally {
      sqlite.close();
    }
  });

  it("refuses a named event that exists but has no format on file", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 3, ourMatch);
      addEvent(db, { name: "Formatless Event", kind: "league", startsOn: "2026-03-01", endsOn: "2026-06-30" });

      expect(() => getLineupPlan(db, teamId, "Formatless Event")).toThrow(EventHasNoFormatError);
    } finally {
      sqlite.close();
    }
  });

  it("fails closed (InvalidEventFormatError) when the stored format is corrupted by a raw insert", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 3, ourMatch);
      const event = db
        .insert(events)
        .values({
          name: "Corrupted Event",
          kind: "tournament",
          startsOn: "2026-08-28",
          endsOn: "2026-08-30",
          // Bypasses `addEvent`'s own writer/validator entirely — VALID JSON of a shape our own
          // writer would never produce (an object, not an array of court entries).
          format: JSON.stringify({ not: "a court list" }),
        })
        .returning()
        .get();

      expect(event.name).toBe("Corrupted Event");
      expect(() => getLineupPlan(db, teamId, "Corrupted Event")).toThrow(InvalidEventFormatError);
    } finally {
      sqlite.close();
    }
  });

  // The narrower half of the same guard, and the one that used to escape it: bytes that are not
  // JSON at all. `events.format` is a plain `text` column precisely so this decode happens in
  // `readEventFormat` and surfaces as a named refusal; under drizzle's `{ mode: "json" }` it threw a
  // raw SyntaxError out of the row mapper instead, which no caller catches and no CLI renders.
  it("fails closed (InvalidEventFormatError, not a raw SyntaxError) when the stored format is not JSON at all", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 3, ourMatch);
      // RAW sql, deliberately not `db.insert(...)`: drizzle's own writer encodes whatever it is
      // handed, so an insert THROUGH drizzle can never produce the corruption under test — it would
      // store `"\"not json at all\""`, which is valid JSON. Only bytes written outside the ORM
      // reproduce a hand-edited database, which is the whole scenario this guard exists for.
      sqlite
        .prepare("INSERT INTO events (name, kind, starts_on, ends_on, format) VALUES (?,?,?,?,?)")
        .run("Unparseable Event", "tournament", "2026-08-28", "2026-08-30", "not json at all");

      let caught: unknown;
      try {
        getLineupPlan(db, teamId, "Unparseable Event");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidEventFormatError);
      expect(caught, "a SyntaxError here would escape every CLI refusal branch").not.toBeInstanceOf(SyntaxError);
    } finally {
      sqlite.close();
    }
  });

  // The blast radius, asserted directly rather than argued in a comment. A malformed format must
  // stay confined to the format reader: `setAvailability` resolves its event through `eventsForDay`,
  // which `select()`s every column of every event whose range covers the day, so under a
  // JSON-decoding column mode ONE corrupt row would break `tn player avail` for every event sharing
  // that day — a command with nothing to do with court formats.
  it("a corrupt format on one event does not break unrelated reads of the events table", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell"]);
      db.update(teams).set({ isHome: true }).where(eq(teams.id, teamId)).run();
      // Raw sql for the same reason as the test above — see its comment.
      sqlite
        .prepare("INSERT INTO events (name, kind, starts_on, ends_on, format) VALUES (?,?,?,?,?)")
        .run("Corrupt Overlapping Event", "tournament", "2026-08-28", "2026-08-30", "not json at all");
      addEvent(db, {
        name: "Healthy Event",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "S1:singles,D1:doubles",
      });

      // Same day, two events, one of them corrupt — the availability writer must still work.
      expect(() =>
        setAvailability(db, {
          playerId: ids["Ada Ashby"]!,
          day: "2026-08-28",
          status: "available",
          eventName: "Healthy Event",
        }),
      ).not.toThrow();

      // And a plan against the healthy event still resolves, with the corrupt row sitting beside it.
      playSingles(db, "S1", ids["Ada Ashby"]!, 3, ourMatch);
      expect(getLineupPlan(db, teamId, "Healthy Event").slotSource).toBe("event-format");
    } finally {
      sqlite.close();
    }
  });

  // Codex adversarial review of PR #82, round 2, Finding 2 [medium]. The resolved value is opaque:
  // only `resolveEventFormat` can build one, and it carries the event's IDENTITY rather than a
  // second, separately-constructed provenance field — so the courts predicted and the event named
  // cannot be recombined from two different events.
  it("a resolved format carries its own event identity — the courts and the named event cannot disagree", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 3, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 3, ourMatch);
      addEvent(db, {
        name: "Two Court Event",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "S1:singles,D1:doubles",
      });
      addEvent(db, {
        name: "One Court Event",
        kind: "tournament",
        startsOn: "2026-09-01",
        endsOn: "2026-09-02",
        format: "S1:singles",
      });

      const two = resolveEventFormat(db, "Two Court Event");
      const one = resolveEventFormat(db, "One Court Event");

      for (const [resolved, courts, name] of [
        [two, 2, "Two Court Event"],
        [one, 1, "One Court Event"],
      ] as const) {
        const plan = getLineupPlan(db, teamId, resolved);
        expect(plan.slots).toHaveLength(courts);
        expect(plan.slotEvent).toEqual({ id: resolved.event.id, name });
      }

      // The value exposes no separate provenance field to swap — the presenter-facing event name is
      // derived from the same object the slot set came from.
      expect(Object.keys(two)).toEqual(["event", "slotSet"]);

      // Codex round 3 [medium]: a spread used to carry the brand, so `{ ...a, slotSet: b.slotSet }`
      // produced a value `getLineupPlan` trusted — B's courts labelled event A. The brand is now
      // non-enumerable, so the spread does not carry it, and the runtime check refuses the result.
      //
      // Asserted at RUNTIME deliberately. The natural-looking compile-time regression does not
      // exist: TypeScript models an object spread from the DECLARED type, so this expression still
      // typechecks as a `ResolvedEventFormat` (verified against this project's own tsconfig). A
      // non-enumerable brand alone would therefore have looked like a fix while changing nothing an
      // attacker-shaped caller would notice — the runtime check is the half that closes it.
      const mixed = { ...one, slotSet: two.slotSet };
      expect(Object.getOwnPropertySymbols(mixed), "a spread must not carry the brand").toHaveLength(0);
      expect(() => getLineupPlan(db, teamId, mixed)).toThrow(/not produced by resolveEventFormat/);

      // And the courts a batch is predicting across cannot be mutated between teams. `readonly` is
      // erased at runtime, so this needs a real freeze, not a type.
      expect(Object.isFrozen(two.slotSet)).toBe(true);
      expect(Object.isFrozen(two.slotSet[0])).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("no event argument -> today's result, unchanged", () => {
    const { db, sqlite } = freshDb();
    try {
      const { teamId, ids, ourMatch } = seedTeam(db, ["Ada Ashby", "Bo Bramwell", "Cy Calder"]);
      playSingles(db, "S1", ids["Ada Ashby"]!, 3, ourMatch);
      playDoubles(db, "D1", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 3, ourMatch);

      const plan = getLineupPlan(db, teamId);

      expect(plan.slotSource).toBe("observed");
      expect(plan.slotEvent).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
