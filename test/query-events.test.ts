// Defect 2 (#17 PR B): nothing in production ever wrote the `events` table — only tests inserted
// events, and `team pull` writes `eventId: null` at both of its call sites. `setAvailability`
// resolves its `event_id` from an event whose range contains the day, so `tn player avail` — shipped
// in PR A — could never succeed: every real invocation exited `NoEventForDayError`. Availability is
// what spec § Domain model calls the thing "lineup planning depends on", which makes this phase the
// one that owns the fix.
//
// The closing-the-loop test at the bottom is the one that matters: a unit test of `addEvent` alone
// would pass while the dead path stayed dead.

import Database from "better-sqlite3";
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
import { InvalidEventFormatError, readEventFormat } from "../src/query/event-format.js";
import { InvalidLeagueScopeError, readLeagueScope } from "../src/query/league-scope.js";
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

// #63: `events.format` shipped in the schema with zero writers, zero readers, and zero tests. This
// is the closing-the-loop suite for THAT column, the same shape as the block above closed the loop
// for `starts_on`/`ends_on`.
describe("addEvent's format", () => {
  useTnDbPath();

  it("stores a format, returned as the parsed court list", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = addEvent(db, { ...SPRINGFIELD, format: "S1:singles,D1:doubles,D2:doubles,D3:doubles" });
      expect(result.format).toEqual([
        { slot: "S1", discipline: "singles" },
        { slot: "D1", discipline: "doubles" },
        { slot: "D2", discipline: "doubles" },
        { slot: "D3", discipline: "doubles" },
      ]);

      // The column is plain `text`, so the stored value is the encoded string — asserted THROUGH
      // `readEventFormat` rather than against a hand-written literal, so this test also pins that
      // what `addEvent` writes is exactly what the only reader accepts.
      const stored = db.select().from(events).all()[0]!;
      expect(readEventFormat(stored.format)).toEqual(result.format);
    } finally {
      sqlite.close();
    }
  });

  it("has no format when none is ever given", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = addEvent(db, SPRINGFIELD);
      expect(result.format).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("preserves a stored format when a repeat add OMITS the format argument — never clobbers with null", () => {
    const { db, sqlite } = freshDb();
    try {
      addEvent(db, { ...SPRINGFIELD, format: "S1:singles,D1:doubles" });
      // A routine date correction, format not mentioned.
      const second = addEvent(db, { ...SPRINGFIELD, endsOn: "2026-08-31" });

      expect(second.format, "an omitted format must not null out what was already stored").toEqual([
        { slot: "S1", discipline: "singles" },
        { slot: "D1", discipline: "doubles" },
      ]);
      expect(second.endsOn).toBe("2026-08-31");
    } finally {
      sqlite.close();
    }
  });

  // The preserve branch reads the stored value, so it needs the SAME fail-closed guard the reader
  // uses. Casting instead would copy a corrupted value forward AND hand it back typed
  // `EventCourt[]`, which the CLI then renders as `undefined:undefined` — a guard applied on one
  // read path and skipped on the other is not a guard.
  it("refuses rather than copying forward a corrupted stored format when the format argument is omitted", () => {
    const { db, sqlite } = freshDb();
    try {
      // Raw sql, not `db.insert`: drizzle's writer would encode whatever it is handed, so only
      // bytes written outside the ORM reproduce a hand-edited database.
      sqlite
        .prepare("INSERT INTO events (name, kind, starts_on, ends_on, format) VALUES (?,?,?,?,?)")
        .run(SPRINGFIELD.name, "tournament", "2026-08-28", "2026-08-30", "not json at all");

      expect(() => addEvent(db, { ...SPRINGFIELD, endsOn: "2026-08-31" })).toThrow(InvalidEventFormatError);

      // And the refusal left the row untouched, like every other refusal in this module.
      const row = sqlite.prepare("SELECT ends_on, format FROM events WHERE name = ?").get(SPRINGFIELD.name) as {
        ends_on: string;
        format: string;
      };
      expect(row.ends_on).toBe("2026-08-30");
      expect(row.format).toBe("not json at all");
    } finally {
      sqlite.close();
    }
  });

  it("replaces a stored format when a repeat add SUPPLIES a different one", () => {
    const { db, sqlite } = freshDb();
    try {
      addEvent(db, { ...SPRINGFIELD, format: "S1:singles,D1:doubles" });
      const second = addEvent(db, { ...SPRINGFIELD, format: "S1:singles,D1:doubles,D2:doubles" });

      expect(second.format).toEqual([
        { slot: "S1", discipline: "singles" },
        { slot: "D1", discipline: "doubles" },
        { slot: "D2", discipline: "doubles" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("refuses an invalid format, and the row is left completely unchanged (created path)", () => {
    const { db, sqlite } = freshDb();
    try {
      expect(() => addEvent(db, { ...SPRINGFIELD, format: "garbage" })).toThrow(InvalidEventFormatError);
      expect(db.select().from(events).all(), "a refusal must write nothing").toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("refuses an invalid format on an update too, leaving the previously-stored row untouched", () => {
    const { db, sqlite } = freshDb();
    try {
      addEvent(db, { ...SPRINGFIELD, format: "S1:singles" });
      expect(() => addEvent(db, { ...SPRINGFIELD, endsOn: "2026-08-31", format: "garbage" })).toThrow(
        InvalidEventFormatError,
      );

      const stored = db.select().from(events).all()[0]!;
      expect(stored.endsOn, "the refused update must not have applied ANY of its fields").toBe("2026-08-30");
      expect(readEventFormat(stored.format)).toEqual([{ slot: "S1", discipline: "singles" }]);
    } finally {
      sqlite.close();
    }
  });

  it("validates the format BEFORE the transaction — the invalid-kind check and an invalid format both leave the table untouched, in combination", () => {
    const { db, sqlite } = freshDb();
    try {
      expect(() => addEvent(db, { ...SPRINGFIELD, kind: "sectionals", format: "garbage" })).toThrow();
      expect(db.select().from(events).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});

// #97: `events.league_scope` is the second structured column on this table, and it gets the same
// closing-the-loop suite the block above gives `format` — deliberately mirroring it case for case,
// because the two share one write rule and a rule honored on one column and forgotten on the other
// is this repo's most-recorded failure mode (docs/findings.md).
describe("addEvent's league scope", () => {
  useTnDbPath();

  it("stores a scope, returned as the parsed value and readable back off the column", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = addEvent(db, { ...SPRINGFIELD, leagueScope: "exclude:Mixed" });
      expect(result.leagueScope).toEqual({ mode: "exclude", prefixes: ["Mixed"] });

      const stored = db.select().from(events).all()[0]!;
      expect(readLeagueScope(stored.leagueScope)).toEqual(result.leagueScope);
    } finally {
      sqlite.close();
    }
  });

  it("stores the exact inverse for a mixed-doubles event over the same rows", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = addEvent(db, {
        name: "September Mixed",
        kind: "tournament",
        startsOn: "2026-09-12",
        endsOn: "2026-09-13",
        leagueScope: "only:Mixed",
      });
      expect(result.leagueScope).toEqual({ mode: "only", prefixes: ["Mixed"] });
    } finally {
      sqlite.close();
    }
  });

  it("has no scope when none is ever given — the pre-#97 behavior, reported rather than assumed", () => {
    const { db, sqlite } = freshDb();
    try {
      expect(addEvent(db, SPRINGFIELD).leagueScope).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("preserves a stored scope when a repeat add OMITS it — never clobbers with null", () => {
    const { db, sqlite } = freshDb();
    try {
      addEvent(db, { ...SPRINGFIELD, leagueScope: "exclude:Mixed" });
      // A routine date correction, scope not mentioned. Silently dropping it here would not produce
      // a visibly wrong dossier — it would produce one that quietly went back to counting every
      // league, which is the defect #97 closes, reintroduced by an unrelated command.
      const second = addEvent(db, { ...SPRINGFIELD, endsOn: "2026-08-31" });

      expect(second.leagueScope, "an omitted scope must not null out what was already stored").toEqual({
        mode: "exclude",
        prefixes: ["Mixed"],
      });
      expect(second.endsOn).toBe("2026-08-31");
    } finally {
      sqlite.close();
    }
  });

  it("preserves the scope when only the FORMAT is being corrected, and vice versa", () => {
    const { db, sqlite } = freshDb();
    try {
      addEvent(db, { ...SPRINGFIELD, format: "S1:singles", leagueScope: "exclude:Mixed" });

      const formatOnly = addEvent(db, { ...SPRINGFIELD, format: "S1:singles,D1:doubles" });
      expect(formatOnly.leagueScope).toEqual({ mode: "exclude", prefixes: ["Mixed"] });
      expect(formatOnly.format).toHaveLength(2);

      const scopeOnly = addEvent(db, { ...SPRINGFIELD, leagueScope: "only:Mixed" });
      expect(scopeOnly.format, "correcting the scope must not delete the court list").toHaveLength(2);
      expect(scopeOnly.leagueScope).toEqual({ mode: "only", prefixes: ["Mixed"] });
    } finally {
      sqlite.close();
    }
  });

  it("replaces a stored scope when a repeat add SUPPLIES a different one", () => {
    const { db, sqlite } = freshDb();
    try {
      addEvent(db, { ...SPRINGFIELD, leagueScope: "exclude:Mixed" });
      const second = addEvent(db, { ...SPRINGFIELD, leagueScope: "exclude:Mixed,Combo" });
      expect(second.leagueScope).toEqual({ mode: "exclude", prefixes: ["Mixed", "Combo"] });
    } finally {
      sqlite.close();
    }
  });

  it("refuses rather than copying forward a corrupted stored scope when the argument is omitted", () => {
    const { db, sqlite } = freshDb();
    try {
      // Hand-corrupt the column, the case the fail-closed reader exists for — only `addEvent` writes
      // it in production, but SQLite enforces no shape on a text column.
      sqlite
        .prepare("INSERT INTO events (name, kind, starts_on, ends_on, league_scope) VALUES (?,?,?,?,?)")
        .run(SPRINGFIELD.name, "tournament", "2026-08-28", "2026-08-30", "not json at all");

      expect(() => addEvent(db, { ...SPRINGFIELD, endsOn: "2026-08-31" })).toThrow(InvalidLeagueScopeError);

      const row = sqlite.prepare("SELECT ends_on, league_scope FROM events WHERE name = ?").get(SPRINGFIELD.name) as {
        ends_on: string;
        league_scope: string;
      };
      // The refusal left the row exactly as it was — the date correction did not land either.
      expect(row.ends_on).toBe("2026-08-30");
      expect(row.league_scope).toBe("not json at all");
    } finally {
      sqlite.close();
    }
  });

  it("refuses an invalid scope, and the row is left completely unchanged (created path)", () => {
    const { db, sqlite } = freshDb();
    try {
      expect(() => addEvent(db, { ...SPRINGFIELD, leagueScope: "garbage" })).toThrow(InvalidLeagueScopeError);
      expect(db.select().from(events).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("refuses an invalid scope on an update too, leaving the previously-stored row untouched", () => {
    const { db, sqlite } = freshDb();
    try {
      addEvent(db, { ...SPRINGFIELD, leagueScope: "exclude:Mixed" });
      expect(() => addEvent(db, { ...SPRINGFIELD, endsOn: "2026-08-31", leagueScope: "drop:Mixed" })).toThrow(
        InvalidLeagueScopeError,
      );

      const stored = db.select().from(events).all()[0]!;
      expect(stored.endsOn).toBe("2026-08-30");
      expect(readLeagueScope(stored.leagueScope)).toEqual({ mode: "exclude", prefixes: ["Mixed"] });
    } finally {
      sqlite.close();
    }
  });

  it("validates the scope BEFORE the transaction, alongside every other input check", () => {
    const { db, sqlite } = freshDb();
    try {
      expect(() => addEvent(db, { ...SPRINGFIELD, kind: "sectionals", leagueScope: "garbage" })).toThrow();
      expect(db.select().from(events).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("reports the FORMAT's refusal first when both columns are given garbage — the order they are typed in", () => {
    const { db, sqlite } = freshDb();
    try {
      expect(() => addEvent(db, { ...SPRINGFIELD, format: "garbage", leagueScope: "garbage" })).toThrow(
        InvalidEventFormatError,
      );
      expect(db.select().from(events).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
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
      // Built explicitly rather than by spreading `other` (an AddEventResult, not an AddEventInput):
      // `other.format` is `EventCourt[] | null`, not the `string | undefined` `addEvent` accepts, so
      // spreading it here would forward a value the writer's own input type does not admit.
      expect(
        addEvent(db, { name: "Some Other Event", kind: other.kind, startsOn: "2026-04-01", endsOn: "2026-04-02" })
          .created,
      ).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

// Found by the independent Codex review of PR #47 round 12, rated high: the range guard above is a
// read-then-write, and `better-sqlite3` being synchronous only rules out interleaving within ONE
// event loop. nadal runs an MCP server against the same WAL database a CLI invocation uses, so an
// agent chat writing availability and a terminal correcting event dates are genuinely concurrent
// PROCESSES — and an availability row committed between the guard's read and the upsert would be
// stranded by the very update the guard was meant to police.
describe("addEvent's range guard is atomic against another process", () => {
  const dbFixture = useTnDbPath();

  it("holds the write lock across the check and the update, so a concurrent writer cannot slip between them", () => {
    runMigrations();

    // A SECOND connection to the same file — a different process, for locking purposes.
    const other = new Database(dbFixture.path());
    other.pragma("journal_mode = WAL");
    other.pragma("busy_timeout = 0"); // fail fast rather than waiting, so the test cannot hang

    let sawBegin = false;
    let attempted = false;
    let interleavedWriteSucceeded: boolean | null = null;

    // `openDb`'s `verbose` hook is the observation seam (see its doc comment in src/db/client.ts).
    // better-sqlite3 invokes it JUST BEFORE each statement runs, so the write lock is not held yet
    // while `BEGIN IMMEDIATE` itself is being announced — the injection has to happen on the NEXT
    // statement, by which point the transaction is genuinely open and the guard is mid-read. (The
    // first draft of this test injected on the BEGIN itself, saw the write succeed, and would have
    // reported a real fix as broken.)
    const { db, sqlite } = openDb(dbFixture.path(), {
      verbose: (message) => {
        if (attempted || typeof message !== "string") return;
        if (!sawBegin) {
          sawBegin = message.toLowerCase().includes("begin immediate");
          return;
        }
        attempted = true;
        try {
          other.prepare("insert into events (name, kind, starts_on, ends_on) values (?,?,?,?)").run(
            "Injected By Another Process",
            "league",
            "2026-01-01",
            "2026-01-02",
          );
          interleavedWriteSucceeded = true;
        } catch {
          interleavedWriteSucceeded = false;
        }
      },
    });

    try {
      addEvent(db, SPRINGFIELD);

      expect(sawBegin, "the transaction must actually be BEGIN IMMEDIATE, not deferred").toBe(true);
      expect(attempted, "the interleaving must actually have been attempted mid-transaction").toBe(true);
      expect(
        interleavedWriteSucceeded,
        "another process must NOT be able to commit a write while the guard's transaction is open",
      ).toBe(false);

      // And the legitimate write still landed.
      expect(db.select().from(events).all().map((e) => e.name)).toEqual(["Springfield Sectionals 2026"]);
    } finally {
      sqlite.close();
      other.close();
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
