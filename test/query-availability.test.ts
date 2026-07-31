import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { availability, events, players, teamMemberships, teams } from "../src/db/schema.js";
import {
  AmbiguousEventForDayError,
  InvalidAvailabilityStatusError,
  NoEventForDayError,
  NoHomeTeamError,
  PlayerNotOnHomeRosterError,
  setAvailability,
} from "../src/query/availability.js";
import { setHomeTeam } from "../src/query/home-team.js";
import { seedHomeTeamFixture } from "./helpers/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

function rows(db: Db) {
  return db.select().from(availability).all();
}

describe("setAvailability", () => {
  useTnDbPath();

  it("writes a row for (player, event, day, status) on the home team's roster", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const result = setAvailability(db, { playerId: fixture.playerId, day: "2026-08-29", status: "available" });
      expect(result.eventId).toBe(fixture.eventId);

      const all = rows(db);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        playerId: fixture.playerId,
        eventId: fixture.eventId,
        day: "2026-08-29",
        status: "available",
      });
    } finally {
      sqlite.close();
    }
  });

  it("idempotence: the same call twice writes one row, and the second status wins", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      setAvailability(db, { playerId: fixture.playerId, day: "2026-08-29", status: "available" });
      setAvailability(db, { playerId: fixture.playerId, day: "2026-08-29", status: "unavailable" });

      const all = rows(db);
      expect(all).toHaveLength(1);
      expect(all[0]?.status).toBe("unavailable");
    } finally {
      sqlite.close();
    }
  });

  describe("day-boundary resolution", () => {
    // Its own fixture built for the assertion (rules/testing.md: "the tell is a fixture built for
    // realism rather than for the assertion") — an event whose starts_on/ends_on make the
    // inclusive-both-ends boundary distinguishable from the day immediately outside it.
    function seedBoundaryFixture(db: Db) {
      return seedHomeTeamFixture(db, { eventStartsOn: "2026-08-28", eventEndsOn: "2026-08-30" });
    }

    it("a day equal to starts_on resolves", () => {
      const { db, sqlite } = freshDb();
      try {
        const fixture = seedBoundaryFixture(db);
        expect(() =>
          setAvailability(db, { playerId: fixture.playerId, day: "2026-08-28", status: "available" }),
        ).not.toThrow();
      } finally {
        sqlite.close();
      }
    });

    it("a day equal to ends_on resolves", () => {
      const { db, sqlite } = freshDb();
      try {
        const fixture = seedBoundaryFixture(db);
        expect(() =>
          setAvailability(db, { playerId: fixture.playerId, day: "2026-08-30", status: "available" }),
        ).not.toThrow();
      } finally {
        sqlite.close();
      }
    });

    it("the day before starts_on does not resolve", () => {
      const { db, sqlite } = freshDb();
      try {
        const fixture = seedBoundaryFixture(db);
        expect(() =>
          setAvailability(db, { playerId: fixture.playerId, day: "2026-08-27", status: "available" }),
        ).toThrow(NoEventForDayError);
      } finally {
        sqlite.close();
      }
    });

    it("the day after ends_on does not resolve", () => {
      const { db, sqlite } = freshDb();
      try {
        const fixture = seedBoundaryFixture(db);
        expect(() =>
          setAvailability(db, { playerId: fixture.playerId, day: "2026-08-31", status: "available" }),
        ).toThrow(NoEventForDayError);
      } finally {
        sqlite.close();
      }
    });
  });

  it("an unknown status is rejected (InvalidAvailabilityStatusError), asserted by class", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      expect(() =>
        setAvailability(db, { playerId: fixture.playerId, day: "2026-08-29", status: "maybe" }),
      ).toThrow(InvalidAvailabilityStatusError);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("a day matching no event errors naming the reason (NoEventForDayError)", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      expect(() =>
        setAvailability(db, { playerId: fixture.playerId, day: "2099-01-01", status: "available" }),
      ).toThrow(NoEventForDayError);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("a day matching more than one event errors listing every candidate (AmbiguousEventForDayError)", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db, { eventStartsOn: "2026-08-01", eventEndsOn: "2026-08-31" });
      db.insert(events)
        .values({ name: "Overlapping Event", kind: "league", startsOn: "2026-08-15", endsOn: "2026-09-15" })
        .run();

      let caught: unknown;
      try {
        setAvailability(db, { playerId: fixture.playerId, day: "2026-08-20", status: "available" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AmbiguousEventForDayError);
      const candidates = (caught as AmbiguousEventForDayError).candidates.map((c) => c.name).sort();
      expect(candidates).toEqual(["Overlapping Event", "Springfield Sectionals 2026"]);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("an event with a null starts_on/ends_on never matches any day (a null range must not swallow every date)", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      db.insert(events).values({ name: "Undated Event", kind: "league" }).run();

      // Still resolves uniquely to the dated fixture event, not ambiguously against the undated one.
      const result = setAvailability(db, { playerId: fixture.playerId, day: "2026-08-29", status: "available" });
      expect(result.eventId).toBe(fixture.eventId);
    } finally {
      sqlite.close();
    }
  });

  it("no home team designated at all refuses (NoHomeTeamError)", () => {
    const { db, sqlite } = freshDb();
    try {
      const event = db
        .insert(events)
        .values({ name: "Event", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
        .returning()
        .get();
      const player = db.insert(players).values({ canonicalName: "Nobody's Home" }).returning().get();
      const team = db.insert(teams).values({ name: "Not Home" }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: event.id }).run();

      expect(() =>
        setAvailability(db, { playerId: player.id, day: "2026-08-29", status: "available" }),
      ).toThrow(NoHomeTeamError);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("a player not on the home team's roster refuses (PlayerNotOnHomeRosterError)", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const otherTeam = db.insert(teams).values({ name: "Opponent" }).returning().get();
      const otherPlayer = db.insert(players).values({ canonicalName: "Opponent Player" }).returning().get();
      db.insert(teamMemberships)
        .values({ playerId: otherPlayer.id, teamId: otherTeam.id, eventId: fixture.eventId })
        .run();

      expect(() =>
        setAvailability(db, { playerId: otherPlayer.id, day: "2026-08-29", status: "available" }),
      ).toThrow(PlayerNotOnHomeRosterError);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("a home-team roster row with a NULL event_id (the shape real pulls actually write) still qualifies", () => {
    // team-pull.ts always passes eventId: null (docs/findings.md, #15) — a roster check that
    // required an exact event_id match would refuse availability for every player ever pulled by
    // the real ingest pipeline, which is exactly the "ships broken over an empty table" scope risk
    // the assessment named.
    const { db, sqlite } = freshDb();
    try {
      const team = db.insert(teams).values({ name: "Home Team" }).returning().get();
      setHomeTeam(db, team.id);
      db.insert(events)
        .values({ name: "Event", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
        .run();
      const player = db.insert(players).values({ canonicalName: "Pulled Player" }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();

      expect(() =>
        setAvailability(db, { playerId: player.id, day: "2026-08-29", status: "available" }),
      ).not.toThrow();
    } finally {
      sqlite.close();
    }
  });
});
