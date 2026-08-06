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
  const tnDb = useTnDbPath();

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

  // The REACHABLE way a registered player ends up with no current season row: they registered
  // while on the season roster (the only way `setEventRoster` permits — it requires a current
  // `event_id IS NULL` membership), and a LATER `tn team pull` retired that season row. Their
  // registration correctly stands. An earlier revision of this test seeded a player who had ONLY
  // ever had an event row, called it a "late add", and thereby asserted reader behavior on a state
  // no writer can produce (Codex adversarial review of PR #121, round 1, finding 4 [low]).
  it("a registered player whose season row was later retired stays in members, and is not also listed as absent", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season: SEASON_20,
        registered: { eventName: "Springfield Sectionals 2026", names: REGISTERED_9 },
      });

      // The team pull: this player is no longer on the roster page, so their SEASON row retires.
      // Their event registration is untouched — `retireAbsentMemberships` is `event_id IS NULL`.
      const departedId = fixture.seasonPlayerIds.get(REGISTERED_9[0]!)!;
      db.update(teamMemberships)
        .set({ retiredAt: "2026-08-06T00:00:00.000Z" })
        .where(
          and(
            eq(teamMemberships.playerId, departedId),
            eq(teamMemberships.teamId, fixture.teamId),
            isNull(teamMemberships.eventId),
          ),
        )
        .run();

      const roster = resolveRoster(db, { teamId: fixture.teamId, eventId: fixture.eventId });

      expect(roster.source).toBe("registered");
      // Still registered — 9 of them — even though only 19 season rows remain current.
      expect(roster.registeredCount).toBe(9);
      expect(roster.seasonCount).toBe(19);
      expect(roster.members.map((m) => m.canonicalName)).toContain(REGISTERED_9[0]);
      expect(roster.members.filter((m) => m.canonicalName === REGISTERED_9[0])).toHaveLength(1);
      // No current season row, so they cannot also be reported as a season player who did not
      // register — the two lists must stay disjoint however the counts move.
      expect(roster.absent.some((m) => m.canonicalName === REGISTERED_9[0])).toBe(false);
      expect(roster.absent).toHaveLength(11);
    } finally {
      sqlite.close();
    }
  });

  // `resolveRoster` reads BOTH scopes in ONE statement so they cannot come from two different
  // database snapshots (finding 2). Asserted by COUNTING the membership selects through `openDb`'s
  // `verbose` seam — the same observation seam #32 added and #117 reused — because the defect is an
  // interleaving no single-process test can stage: two queries would still return the right answer
  // here, and only the count distinguishes them.
  it("reads both scopes in ONE statement, so the two cannot come from different snapshots", () => {
    runMigrations();
    const statements: string[] = [];
    const { db, sqlite } = openDb(tnDb.path(), { verbose: (message) => statements.push(String(message)) });
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season: SEASON_20,
        registered: { eventName: "Springfield Sectionals 2026", names: REGISTERED_9 },
      });

      statements.length = 0;
      const roster = resolveRoster(db, { teamId: fixture.teamId, eventId: fixture.eventId });

      expect(roster.source).toBe("registered");
      const membershipSelects = statements.filter((s) => /select/i.test(s) && /team_memberships/i.test(s));
      expect(membershipSelects).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
