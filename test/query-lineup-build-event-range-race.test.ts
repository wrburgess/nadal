// The event-range race in `getLineupBuild` (#127, Codex adversarial review of PR #137, class A).
//
// `getLineupBuild` reads the `events` row TWICE — once through `resolveEventForDay` to turn the day
// into an event, and again through `resolveEvent` to get the branded value carrying the court list.
// Between those two reads the row can change: `tn event add` upserts on name, and nadal genuinely
// runs `tn mcp serve` beside the CLI against one WAL file.
//
// The self-review had recorded that window as Low, reasoning that it "fails closed" because the
// second read throws `UnknownEventError`. That is true for a RENAME or a delete. It is wrong for a
// RANGE CHANGE, which is the case that produces a wrong ANSWER rather than an error: every day this
// command reports on comes from `getAvailabilityForEvent`, which enumerates the range it reads, so a
// shortened event yields a day list that no longer contains the requested day, every player reads
// `status: null`, and the command exits 0 with a confident "nobody is available".
//
// This file lives apart from `query-lineup-build.test.ts` because the mock below is module-wide and
// the rest of that suite must keep exercising the real `resolveEventForDay`. The mock is the only
// honest way to make the interleaving deterministic — the race is between two reads inside ONE
// synchronous call, so no amount of fixture setup can land a write between them. Same technique, and
// same reason, as `report-write-home-team-race.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveEventForDayMock = vi.fn();

vi.mock("../src/query/availability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/query/availability.js")>();
  return { ...actual, resolveEventForDay: resolveEventForDayMock };
});

const { eq } = await import("drizzle-orm");
const { openDb, runMigrations } = await import("../src/db/client.js");
const { events, players, teamMemberships, teams } = await import("../src/db/schema.js");
const availabilityModule = await import("../src/query/availability.js");
const { EventDoesNotCoverDayError, setAvailability } = availabilityModule;
const { addEvent } = await import("../src/query/events.js");
const { setHomeTeam } = await import("../src/query/home-team.js");
const { getLineupBuild } = await import("../src/query/lineup-build.js");
const { useTnDbPath } = await import("./helpers/tn-db.js");

const EVENT = "Springfield Sectionals 2026";
const FORMAT = "S1:singles,D1:doubles,D2:doubles,D3:doubles";
const FRIDAY = "2026-08-28";
const SATURDAY = "2026-08-29";

describe("getLineupBuild — the event's dates changing between the two reads", () => {
  useTnDbPath();

  beforeEach(() => {
    resolveEventForDayMock.mockReset();
  });

  it("refuses rather than reporting a confident empty lineup for a day the event no longer covers", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const team = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
      setHomeTeam(db, team.id);
      const event = addEvent(db, {
        name: EVENT,
        kind: "tournament",
        startsOn: FRIDAY,
        endsOn: "2026-08-30",
        format: FORMAT,
      });
      for (let i = 0; i < 8; i++) {
        const player = db
          .insert(players)
          .values({ canonicalName: `Player ${String(i + 1).padStart(2, "0")} Ashby` })
          .returning()
          .get();
        db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
        // Everyone says YES for Saturday. A correct build fields seven of them; the defect this
        // pins reported all eight as never having answered.
        setAvailability(db, { playerId: player.id, day: SATURDAY, status: "available" });
      }

      // THE RACE, deterministically. The real resolver runs first and legitimately matches Saturday
      // against 2026-08-28..30. Then a concurrent `tn event add` shortens the event to Friday only —
      // which is a legal write, since the availability rows it already holds stay inside the range
      // it is being narrowed to. `resolveEvent` is next, and it sees the SHORTENED row.
      resolveEventForDayMock.mockImplementation((...args: Parameters<typeof availabilityModule.resolveEventForDay>) => {
        const row = actualResolve(...args);
        db.update(events).set({ endsOn: FRIDAY }).where(eq(events.id, event.eventId)).run();
        return row;
      });

      expect(() => getLineupBuild(db, { day: SATURDAY })).toThrow(EventDoesNotCoverDayError);
      // The mock really did interleave — without this the test could pass for having never raced.
      expect(resolveEventForDayMock).toHaveBeenCalledTimes(1);
      expect(db.select().from(events).where(eq(events.id, event.eventId)).get()?.endsOn).toBe(FRIDAY);
    } finally {
      sqlite.close();
    }
  });
});

/** The unmocked resolver, captured before the mock replaced the module export. */
const actualResolve = (
  await vi.importActual<typeof import("../src/query/availability.js")>("../src/query/availability.js")
).resolveEventForDay;
