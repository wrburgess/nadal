// Write service for the captain's recorded play-style constraint (#149 Task 2), mirroring
// `test/query-availability.test.ts`'s shape for `setAvailability`. `plays` is a scalar column, not
// a per-day key, so "re-write" is a plain UPDATE and there is no day/event to disambiguate.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { players, teamMemberships } from "../src/db/schema.js";
import {
  AmbiguousPlayerTargetError,
  InvalidPlaysError,
  PlayerNotOnHomeRosterError,
  UnknownPlayerTargetError,
  setPlays,
} from "../src/query/player-plays.js";
import { resolveRoster } from "../src/query/roster.js";
import { seedHomeTeamFixture } from "./helpers/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

function playsColumn(db: Db, playerId: number): string | null {
  return db.select({ plays: players.plays }).from(players).where(eq(players.id, playerId)).get()?.plays ?? null;
}

describe("setPlays", () => {
  useTnDbPath();

  it("stores 'doubles-only', and the roster join reads it back", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const result = setPlays(db, { player: fixture.playerName, plays: "doubles-only" });

      expect(result.playerId).toBe(fixture.playerId);
      expect(result.plays).toBe("doubles-only");
      expect(playsColumn(db, fixture.playerId)).toBe("doubles-only");

      // #149 Task 3: the SAME roster read `getLineupBuild` threads through — a write this join
      // cannot see is a write no downstream feature can act on.
      const roster = resolveRoster(db, { teamId: fixture.homeTeamId, eventId: fixture.eventId });
      const member = roster.members.find((m) => m.playerId === fixture.playerId);
      expect(member).toBeDefined();
      expect(member!.plays).toBe("doubles-only");
    } finally {
      sqlite.close();
    }
  });

  it("a value outside the enum is refused (InvalidPlaysError), naming the accepted values", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      let caught: unknown;
      try {
        setPlays(db, { player: fixture.playerName, plays: "singles-only" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidPlaysError);
      // "singles-only" is deliberately NOT an accepted value (#149: zero captured statements use
      // it) — the message must name what IS accepted, not just reject what was given.
      expect((caught as Error).message).toMatch(/both/);
      expect((caught as Error).message).toMatch(/doubles-only/);
      expect(playsColumn(db, fixture.playerId)).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("a player not on the home team's roster refuses (PlayerNotOnHomeRosterError)", () => {
    const { db, sqlite } = freshDb();
    try {
      seedHomeTeamFixture(db);
      const stranger = db.insert(players).values({ canonicalName: "Not Rostered Guy" }).returning().get();
      backfillNameKeys(db);

      expect(() => setPlays(db, { player: "Not Rostered Guy", plays: "doubles-only" })).toThrow(
        PlayerNotOnHomeRosterError,
      );
      expect(playsColumn(db, stranger.id)).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("re-writing with a different value overwrites — exactly one value per player", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      setPlays(db, { player: fixture.playerName, plays: "doubles-only" });
      const second = setPlays(db, { player: fixture.playerName, plays: "both" });

      expect(second.plays).toBe("both");
      expect(playsColumn(db, fixture.playerId)).toBe("both");
      // Still a scalar column on the one players row — never a second row.
      expect(db.select().from(players).all().filter((p) => p.id === fixture.playerId)).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  // Issue #49's rule, unchanged one door over: a soft-retired membership is not a CURRENT roster
  // row, so recording a play-style constraint for someone the last successful pull did not see
  // refuses exactly like `setAvailability` already does.
  it("a RETIRED member of the home team's roster refuses (PlayerNotOnHomeRosterError), matching setAvailability", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, fixture.playerId))
        .run();

      expect(() => setPlays(db, { player: fixture.playerName, plays: "doubles-only" })).toThrow(
        PlayerNotOnHomeRosterError,
      );
      expect(playsColumn(db, fixture.playerId)).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  // Two branches `setPlays` introduces by resolving its own target (unlike `setAvailability`,
  // which takes an already-resolved `playerId`) — reachable branches this file's own testing
  // discipline (see `singles-only`'s exclusion above) says must not go untested.
  it("an unknown target refuses (UnknownPlayerTargetError)", () => {
    const { db, sqlite } = freshDb();
    try {
      seedHomeTeamFixture(db);
      expect(() => setPlays(db, { player: "Nobody Nowhere", plays: "doubles-only" })).toThrow(
        UnknownPlayerTargetError,
      );
    } finally {
      sqlite.close();
    }
  });

  it("an ambiguous target refuses, listing candidates (AmbiguousPlayerTargetError)", () => {
    const { db, sqlite } = freshDb();
    try {
      seedHomeTeamFixture(db);
      // Two distinct players sharing one canonical name — a real collision `resolvePlayerTarget`
      // already refuses for every other command, not invented for this test alone.
      db.insert(players).values({ canonicalName: "Sam Smith" }).run();
      db.insert(players).values({ canonicalName: "Sam Smith" }).run();
      backfillNameKeys(db);

      let caught: unknown;
      try {
        setPlays(db, { player: "Sam Smith", plays: "doubles-only" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AmbiguousPlayerTargetError);
      expect((caught as AmbiguousPlayerTargetError).candidates.length).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});
