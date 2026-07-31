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
  EventRangeInvertedError,
  InvalidEventDayError,
  InvalidEventKindError,
  MissingEventNameError,
  addEvent,
} from "../src/query/events.js";
import { setAvailability } from "../src/query/availability.js";
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
