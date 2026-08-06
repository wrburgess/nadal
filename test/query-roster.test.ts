// Task 2 (#113): `resolveRoster` is the one choke point every roster read goes through —
// `getTeamProfile`, its `versusTeamId` opponent roster, and `getLineupPlan` all replace their own
// byte-identical roster query with a call to this. Unit-tested here in isolation, against
// hand-seeded event memberships (`seedTeamWithRosters`), before Task 3 wires the three read sites to
// it and Task 4's writer proves the production path end to end.

import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { events, teamMemberships } from "../src/db/schema.js";
import { resolveRoster } from "../src/query/roster.js";
import { seedTeamWithRosters } from "./helpers/roster.js";
import { useTnDbPath } from "./helpers/tn-db.js";

function freshDb() {
  runMigrations();
  return openDb();
}

/** OK/Dickason-shaped: 20 on the season roster, 9 registered for Springfield — the case #113 was
 * filed for. */
const SEASON_20 = Array.from({ length: 20 }, (_, i) => `Season Player ${String(i + 1).padStart(2, "0")}`);
const REGISTERED_9 = SEASON_20.slice(0, 9);

describe("resolveRoster", () => {
  useTnDbPath();

  it("a registered roster present -> source: registered, members are the 9, absent is the other 11", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season: SEASON_20,
        registered: { eventName: "Springfield Sectionals 2026", names: REGISTERED_9 },
      });

      const roster = resolveRoster(db, { teamId: fixture.teamId, eventId: fixture.eventId });

      expect(roster.source).toBe("registered");
      expect(roster.members.map((m) => m.canonicalName).sort()).toEqual([...REGISTERED_9].sort());
      expect(roster.registeredCount).toBe(9);
      expect(roster.seasonCount).toBe(20);
      const absentNames = SEASON_20.slice(9);
      expect(roster.absent.map((m) => m.canonicalName).sort()).toEqual([...absentNames].sort());
    } finally {
      sqlite.close();
    }
  });

  it("no event named -> source: season, all 20, absent empty", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, { teamName: "Team A", season: SEASON_20 });

      const roster = resolveRoster(db, { teamId: fixture.teamId, eventId: null });

      expect(roster.source).toBe("season");
      expect(roster.members).toHaveLength(20);
      expect(roster.registeredCount).toBe(0);
      expect(roster.seasonCount).toBe(20);
      expect(roster.absent).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("no event named at all (eventId undefined) reads the same as eventId null", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, { teamName: "Team A", season: SEASON_20 });

      const roster = resolveRoster(db, { teamId: fixture.teamId });

      expect(roster.source).toBe("season");
      expect(roster.members).toHaveLength(20);
    } finally {
      sqlite.close();
    }
  });

  it("event named but NO registered rows -> source: season, all 20, absent empty", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, { teamName: "Team A", season: SEASON_20 });
      const event = db.insert(events).values({ name: "Unregistered Event", kind: "tournament" }).returning().get();

      const roster = resolveRoster(db, { teamId: fixture.teamId, eventId: event.id });

      expect(roster.source).toBe("season");
      expect(roster.members).toHaveLength(20);
      expect(roster.registeredCount).toBe(0);
      expect(roster.absent).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("event named, ALL registered rows retired -> source: season (the fallback boundary)", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season: SEASON_20,
        registered: { eventName: "Springfield Sectionals 2026", names: REGISTERED_9 },
      });
      // Retire every registered (event-scoped) row — none non-retired remain.
      db.update(teamMemberships)
        .set({ retiredAt: "2026-08-01" })
        .where(and(eq(teamMemberships.teamId, fixture.teamId), eq(teamMemberships.eventId, fixture.eventId!)))
        .run();

      const roster = resolveRoster(db, { teamId: fixture.teamId, eventId: fixture.eventId });

      expect(roster.source).toBe("season");
      expect(roster.members).toHaveLength(20);
      expect(roster.registeredCount).toBe(0);
      expect(roster.absent).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("a registered player who is ALSO a retired season member appears once, not twice", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season: SEASON_20,
        registered: { eventName: "Springfield Sectionals 2026", names: REGISTERED_9 },
      });
      const retiredName = REGISTERED_9[0]!;
      const retiredPlayerId = fixture.seasonPlayerIds.get(retiredName)!;
      // Retire ONLY this player's season (event_id null) row — their event row stays current.
      db.update(teamMemberships)
        .set({ retiredAt: "2026-08-01" })
        .where(
          and(
            eq(teamMemberships.teamId, fixture.teamId),
            eq(teamMemberships.playerId, retiredPlayerId),
            isNull(teamMemberships.eventId),
          ),
        )
        .run();

      const roster = resolveRoster(db, { teamId: fixture.teamId, eventId: fixture.eventId });

      expect(roster.source).toBe("registered");
      const occurrences = roster.members.filter((m) => m.playerId === retiredPlayerId);
      expect(occurrences).toHaveLength(1);
      expect(new Set(roster.members.map((m) => m.playerId)).size).toBe(roster.members.length);
      expect(roster.members).toHaveLength(9);
      // Not double-counted into `absent` either — they are NOT a current season member (retired),
      // so the no-union guarantee means they must not reappear there.
      expect(roster.absent.some((m) => m.playerId === retiredPlayerId)).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("a registered roster on event B does not leak into a read for event A", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season: SEASON_20,
        registered: { eventName: "Event B", names: REGISTERED_9 },
      });
      const eventA = db.insert(events).values({ name: "Event A", kind: "tournament" }).returning().get();

      const roster = resolveRoster(db, { teamId: fixture.teamId, eventId: eventA.id });

      expect(roster.source).toBe("season");
      expect(roster.members).toHaveLength(20);
      expect(roster.registeredCount).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("a player registered for the event but never on the season roster is included and not double-counted", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season: SEASON_20,
        registered: { eventName: "Springfield Sectionals 2026", names: [...REGISTERED_9, "Late Add Lindqvist"] },
      });

      const roster = resolveRoster(db, { teamId: fixture.teamId, eventId: fixture.eventId });

      expect(roster.source).toBe("registered");
      expect(roster.registeredCount).toBe(10);
      expect(roster.members.map((m) => m.canonicalName)).toContain("Late Add Lindqvist");
      expect(roster.members.filter((m) => m.canonicalName === "Late Add Lindqvist")).toHaveLength(1);
      // They never had a season row, so they must not also appear in `absent`.
      expect(roster.absent.some((m) => m.canonicalName === "Late Add Lindqvist")).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
