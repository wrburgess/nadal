import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { availability, events, players, teamMemberships, teams } from "../src/db/schema.js";
import {
  AmbiguousEventForDayError,
  EventDoesNotCoverDayError,
  UnknownEventError,
  InvalidAvailabilityDayError,
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

  // `status` was validated from the start; `day` was not — and `day` is half of this table's
  // upsert key. The event lookup compares TEXT, so a malformed day that merely SORTS inside the
  // event's range matched and was persisted verbatim: "2026-08-28 ", "2026-08-28xyz" and
  // "2026-08-2900" each stored a SEPARATE row alongside the real "2026-08-28", defeating the
  // idempotent upsert the unique index exists to provide and inventing days that no per-event-day
  // read (lineup planning, #17 PR B) will ever match. Byte-for-byte the `upsertTeamMatch` shape
  // docs/findings.md records four review rounds on: a key assembled without normalizing its input
  // domain. Reproduced against a real DB before being fixed.
  describe("day validation", () => {
    const malformed = [
      ["a trailing space", "2026-08-28 "],
      ["a trailing suffix", "2026-08-28xyz"],
      ["extra digits", "2026-08-2900"],
      ["a leading space", " 2026-08-28"],
      ["a non-padded month", "2026-8-28"],
      ["a datetime rather than a day", "2026-08-28T00:00:00Z"],
      ["not a date at all", "tuesday"],
      ["empty", ""],
    ] as const;

    for (const [label, day] of malformed) {
      it(`rejects ${label} (${JSON.stringify(day)}) and writes nothing`, () => {
        const { db, sqlite } = freshDb();
        try {
          const fixture = seedHomeTeamFixture(db);
          expect(() => setAvailability(db, { playerId: fixture.playerId, day, status: "available" })).toThrow(
            InvalidAvailabilityDayError,
          );
          expect(rows(db)).toHaveLength(0);
        } finally {
          sqlite.close();
        }
      });
    }

    it("rejects a well-shaped day that is not a real calendar date", () => {
      // Regex-shaped but nonexistent — the guard has to be a real date check, not just a pattern.
      const { db, sqlite } = freshDb();
      try {
        const fixture = seedHomeTeamFixture(db);
        expect(() =>
          setAvailability(db, { playerId: fixture.playerId, day: "2026-02-31", status: "available" }),
        ).toThrow(InvalidAvailabilityDayError);
        expect(rows(db)).toHaveLength(0);
      } finally {
        sqlite.close();
      }
    });

    it("the same real day cannot be split across rows by respelling it", () => {
      // The defect this whole block exists for, asserted end to end: before the fix these four
      // calls produced FOUR rows for one day.
      const { db, sqlite } = freshDb();
      try {
        const fixture = seedHomeTeamFixture(db);
        setAvailability(db, { playerId: fixture.playerId, day: "2026-08-29", status: "available" });
        for (const respelling of ["2026-08-29 ", "2026-08-29xyz", "2026-08-2900"]) {
          expect(() =>
            setAvailability(db, { playerId: fixture.playerId, day: respelling, status: "unavailable" }),
          ).toThrow(InvalidAvailabilityDayError);
        }
        const all = rows(db);
        expect(all).toHaveLength(1);
        expect(all[0]!.day).toBe("2026-08-29");
        expect(all[0]!.status).toBe("available");
      } finally {
        sqlite.close();
      }
    });
  });
});

// Found by the independent Codex review of PR #47 (rated high). Overlapping event ranges are a
// NORMAL domain state — a district league season runs Mar-Jun and a districts tournament sits
// inside it in May — so every day in that window resolves to two events. Before #17 PR B nothing
// wrote the `events` table, so day-only resolution could never hit the overlap and its refusal
// looked theoretical; `addEvent` made it the first thing a real setup hits, and availability was
// simply unusable on those days.
describe("setAvailability with overlapping events", () => {
  useTnDbPath();

  function seedOverlap() {
    const { db, sqlite } = freshDb();
    const team = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    setHomeTeam(db, team.id);
    const player = db.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    const league = db
      .insert(events)
      .values({ name: "HOA 40&over3.5M Spring 2026", kind: "league", startsOn: "2026-03-01", endsOn: "2026-06-30" })
      .returning()
      .get();
    const districts = db
      .insert(events)
      .values({ name: "Heart of America Districts", kind: "tournament", startsOn: "2026-05-15", endsOn: "2026-05-17" })
      .returning()
      .get();
    return { db, sqlite, playerId: player.id, league, districts };
  }

  it("still refuses an overlapping day with no event named, and says to name one", () => {
    const { db, sqlite, playerId } = seedOverlap();
    try {
      expect(() => setAvailability(db, { playerId, day: "2026-05-16", status: "available" })).toThrow(
        AmbiguousEventForDayError,
      );
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("writes against the named event when the day is ambiguous — the case that was impossible", () => {
    const { db, sqlite, playerId, districts } = seedOverlap();
    try {
      const result = setAvailability(db, {
        playerId,
        day: "2026-05-16",
        status: "available",
        eventName: "Heart of America Districts",
      });
      expect(result.eventId).toBe(districts.id);
      expect(rows(db)).toHaveLength(1);
      expect(rows(db)[0]).toMatchObject({ eventId: districts.id, day: "2026-05-16" });
    } finally {
      sqlite.close();
    }
  });

  it("can name the OTHER overlapping event and get that one — not a fixed preference", () => {
    const { db, sqlite, playerId, league } = seedOverlap();
    try {
      const result = setAvailability(db, {
        playerId,
        day: "2026-05-16",
        status: "available",
        eventName: "HOA 40&over3.5M Spring 2026",
      });
      expect(result.eventId).toBe(league.id);
    } finally {
      sqlite.close();
    }
  });

  it("keeps the two events' rows separate for the same player and day", () => {
    const { db, sqlite, playerId, league, districts } = seedOverlap();
    try {
      setAvailability(db, { playerId, day: "2026-05-16", status: "available", eventName: league.name });
      setAvailability(db, { playerId, day: "2026-05-16", status: "unavailable", eventName: districts.name });
      const all = rows(db);
      expect(all, "the unique index is (player, event, day) — two events, two rows").toHaveLength(2);
      expect(all.find((r) => r.eventId === league.id)?.status).toBe("available");
      expect(all.find((r) => r.eventId === districts.id)?.status).toBe("unavailable");
    } finally {
      sqlite.close();
    }
  });

  it("refuses a named event that exists but does not cover the day — distinctly from an unknown one", () => {
    const { db, sqlite, playerId } = seedOverlap();
    try {
      expect(() =>
        setAvailability(db, {
          playerId,
          day: "2026-06-20",
          status: "available",
          eventName: "Heart of America Districts",
        }),
      ).toThrow(EventDoesNotCoverDayError);
      expect(() =>
        setAvailability(db, { playerId, day: "2026-05-16", status: "available", eventName: "No Such Event" }),
      ).toThrow(UnknownEventError);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  // Silently ignoring a name the caller went out of their way to supply is the same
  // "accepted but not honored" failure the grammar's unrecognized-flag rule exists to prevent.
  it("honors the event name even when the day is unambiguous, rather than ignoring it", () => {
    const { db, sqlite, playerId, league } = seedOverlap();
    try {
      // 2026-04-01 is inside the league only.
      expect(setAvailability(db, { playerId, day: "2026-04-01", status: "available", eventName: league.name }).eventId).toBe(
        league.id,
      );
      expect(() =>
        setAvailability(db, {
          playerId,
          day: "2026-04-01",
          status: "available",
          eventName: "Heart of America Districts",
        }),
      ).toThrow(EventDoesNotCoverDayError);
    } finally {
      sqlite.close();
    }
  });
});
