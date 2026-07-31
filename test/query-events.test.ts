// Defect 2 (#17 PR B): nothing in production ever wrote the `events` table — only tests inserted
// events, and `team pull` writes `eventId: null` at both of its call sites. `setAvailability`
// resolves its `event_id` from an event whose range contains the day, so `tn player avail` — shipped
// in PR A — could never succeed: every real invocation exited `NoEventForDayError`. Availability is
// what spec § Domain model calls the thing "lineup planning depends on", which makes this phase the
// one that owns the fix.
//
// The closing-the-loop test at the bottom is the one that matters: a unit test of `addEvent` alone
// would pass while the dead path stayed dead.

import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { events, players, teamMemberships, teams } from "../src/db/schema.js";
import {
  EventRangeExcludesAvailabilityError,
  EventRangeInvertedError,
  InvalidEventDayError,
  InvalidEventKindError,
  MissingEventNameError,
  addEvent,
} from "../src/query/events.js";
import { setAvailability } from "../src/query/availability.js";
import { availability } from "../src/db/schema.js";
import { setHomeTeam } from "../src/query/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

function freshDb() {
  runMigrations();
  return openDb();
}

const SPRINGFIELD = {
  name: "Springfield Sectionals 2026",
  kind: "tournament",
  startsOn: "2026-08-28",
  endsOn: "2026-08-30",
};

describe("addEvent", () => {
  useTnDbPath();

  it("writes an event with its kind and inclusive date range", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = addEvent(db, SPRINGFIELD);
      expect(result.created).toBe(true);

      const all = db.select().from(events).all();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
      });
      expect(result.eventId).toBe(all[0]!.id);
    } finally {
      sqlite.close();
    }
  });

  it("is idempotent on name: a repeat updates in place rather than duplicating", () => {
    const { db, sqlite } = freshDb();
    try {
      const first = addEvent(db, SPRINGFIELD);
      const second = addEvent(db, { ...SPRINGFIELD, endsOn: "2026-08-31" });

      expect(second.created).toBe(false);
      expect(second.eventId).toBe(first.eventId);

      const all = db.select().from(events).all();
      expect(all, "a repeat add must not grow the table").toHaveLength(1);
      expect(all[0]).toMatchObject({ endsOn: "2026-08-31" });
    } finally {
      sqlite.close();
    }
  });

  it("accepts the other known kind", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = addEvent(db, {
        name: "HOA 40&over3.5M Spring 2026",
        kind: "league",
        startsOn: "2026-03-01",
        endsOn: "2026-06-30",
      });
      expect(result.kind).toBe("league");
    } finally {
      sqlite.close();
    }
  });

  it("accepts a single-day event (starts_on === ends_on)", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = addEvent(db, { ...SPRINGFIELD, startsOn: "2026-08-28", endsOn: "2026-08-28" });
      expect(result.startsOn).toBe("2026-08-28");
      expect(result.endsOn).toBe("2026-08-28");
    } finally {
      sqlite.close();
    }
  });

  describe("refusals — asserted on error CLASS, never on message text", () => {
    it("refuses an unknown kind", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(() => addEvent(db, { ...SPRINGFIELD, kind: "sectionals" })).toThrow(InvalidEventKindError);
        expect(db.select().from(events).all(), "a refusal must write nothing").toHaveLength(0);
      } finally {
        sqlite.close();
      }
    });

    it("refuses an empty or whitespace-only name", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(() => addEvent(db, { ...SPRINGFIELD, name: "" })).toThrow(MissingEventNameError);
        expect(() => addEvent(db, { ...SPRINGFIELD, name: "   " })).toThrow(MissingEventNameError);
      } finally {
        sqlite.close();
      }
    });

    // The same input class `requireIsoDay` closes for availability: `day`/`starts_on`/`ends_on` are
    // compared as TEXT, so a malformed string that merely SORTS inside a range would match it.
    it.each([
      ["not a date at all", "tomorrow"],
      ["a real-looking but impossible date", "2026-02-31"],
      ["a trailing space", "2026-08-28 "],
      ["trailing junk", "2026-08-28xyz"],
      ["a four-digit day", "2026-08-2900"],
      ["a two-digit year", "26-08-28"],
    ])("refuses %s as starts_on", (_label, bad) => {
      const { db, sqlite } = freshDb();
      try {
        expect(() => addEvent(db, { ...SPRINGFIELD, startsOn: bad })).toThrow(InvalidEventDayError);
      } finally {
        sqlite.close();
      }
    });

    it("refuses a malformed ends_on too, not only starts_on", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(() => addEvent(db, { ...SPRINGFIELD, endsOn: "2026-13-01" })).toThrow(InvalidEventDayError);
      } finally {
        sqlite.close();
      }
    });

    it("refuses an inverted range (ends before it starts)", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(() => addEvent(db, { ...SPRINGFIELD, startsOn: "2026-08-30", endsOn: "2026-08-28" })).toThrow(
          EventRangeInvertedError,
        );
      } finally {
        sqlite.close();
      }
    });
  });
});

// Found by the independent Codex review of PR #47 (rated medium). `addEvent` promises an in-place
// update, and `setAvailability` validates day-within-range only when a row is WRITTEN — so moving or
// narrowing a range afterwards would strand availability on an event that no longer contains its
// day, invisibly, until someone read per-event-day availability and found days the event never
// covered.
describe("addEvent will not move a range off availability already recorded against it", () => {
  useTnDbPath();

  function seedWithAvailability(day: string) {
    const { db, sqlite } = freshDb();
    const team = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    setHomeTeam(db, team.id);
    const player = db.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    addEvent(db, SPRINGFIELD);
    setAvailability(db, { playerId: player.id, day, status: "available" });
    return { db, sqlite };
  }

  it("refuses an update whose new range excludes a recorded day, naming the days", () => {
    const { db, sqlite } = seedWithAvailability("2026-08-29");
    try {
      let thrown: unknown;
      try {
        addEvent(db, { ...SPRINGFIELD, startsOn: "2026-09-01", endsOn: "2026-09-03" });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(EventRangeExcludesAvailabilityError);
      expect((thrown as EventRangeExcludesAvailabilityError).orphanedDays).toEqual(["2026-08-29"]);

      // A refusal leaves BOTH tables untouched — the event keeps its original range and the
      // availability row is still valid against it.
      const event = db.select().from(events).all()[0]!;
      expect(event).toMatchObject({ startsOn: "2026-08-28", endsOn: "2026-08-30" });
      expect(db.select().from(availability).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("refuses a NARROWING that drops a boundary day, not only a wholesale move", () => {
    const { db, sqlite } = seedWithAvailability("2026-08-30");
    try {
      // 28..29 still overlaps the original range, but 08-30 falls outside it.
      expect(() => addEvent(db, { ...SPRINGFIELD, endsOn: "2026-08-29" })).toThrow(
        EventRangeExcludesAvailabilityError,
      );
    } finally {
      sqlite.close();
    }
  });

  it("allows an update that still covers every recorded day, including a widening", () => {
    const { db, sqlite } = seedWithAvailability("2026-08-29");
    try {
      const widened = addEvent(db, { ...SPRINGFIELD, startsOn: "2026-08-27", endsOn: "2026-08-31" });
      expect(widened.created).toBe(false);
      expect(widened.startsOn).toBe("2026-08-27");

      // And a no-op re-add of the identical range is still idempotent.
      expect(addEvent(db, { ...SPRINGFIELD, startsOn: "2026-08-27", endsOn: "2026-08-31" }).created).toBe(false);
      expect(db.select().from(events).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("does not block a DIFFERENT event whose range moves off an unrelated event's availability", () => {
    const { db, sqlite } = seedWithAvailability("2026-08-29");
    try {
      // The guard is scoped to the event being updated, not to availability in general.
      const other = addEvent(db, {
        name: "Some Other Event",
        kind: "league",
        startsOn: "2026-03-01",
        endsOn: "2026-06-30",
      });
      expect(other.created).toBe(true);
      expect(addEvent(db, { ...other, name: "Some Other Event", startsOn: "2026-04-01", endsOn: "2026-04-02" }).created).toBe(
        false,
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("addEvent closes the loop: tn player avail becomes reachable", () => {
  useTnDbPath();

  // This is the whole point of Defect 2. Before `addEvent` existed there was no production path to
  // an `events` row, so this sequence — the real one a user runs — always ended in
  // `NoEventForDayError`.
  it("an event added through the real writer resolves a subsequent availability write", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
      setHomeTeam(db, team.id);
      const player = db.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();

      const event = addEvent(db, SPRINGFIELD);

      const result = setAvailability(db, { playerId: player.id, day: "2026-08-29", status: "available" });
      expect(result.eventId).toBe(event.eventId);
      expect(result.eventName).toBe("Springfield Sectionals 2026");
      expect(result.status).toBe("available");
    } finally {
      sqlite.close();
    }
  });

  it("resolves availability on both inclusive boundary days of the added range", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
      setHomeTeam(db, team.id);
      const player = db.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
      addEvent(db, SPRINGFIELD);

      expect(setAvailability(db, { playerId: player.id, day: "2026-08-28", status: "available" }).status).toBe(
        "available",
      );
      expect(setAvailability(db, { playerId: player.id, day: "2026-08-30", status: "uncertain" }).status).toBe(
        "uncertain",
      );
    } finally {
      sqlite.close();
    }
  });
});
