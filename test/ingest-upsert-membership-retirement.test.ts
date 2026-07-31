// Issue #49, Task 2: the write primitives underneath the reconcile. `retireAbsentMemberships`'s two
// guards (empty-observed-set no-op, `retired_at IS NULL` predicate) are asserted here directly,
// against DATABASE STATE, because a future second caller inherits both from the primitive rather
// than from whichever caller happened to remember them first (rules/backend.md: put the guard where
// every caller inherits it).

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { events, players, teamMemberships, teams } from "../src/db/schema.js";
import { retireAbsentMemberships, upsertMembership } from "../src/ingest/upsert.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

function seedPlayer(db: Db, canonicalName: string) {
  return db.insert(players).values({ canonicalName }).returning().get();
}

function seedTeam(db: Db, name: string) {
  return db.insert(teams).values({ name }).returning().get();
}

function rowsFor(db: Db, teamId: number) {
  return db.select().from(teamMemberships).where(eq(teamMemberships.teamId, teamId)).all();
}

describe("retireAbsentMemberships", () => {
  useTnDbPath();

  it("retires exactly the memberships absent from observedPlayerIds; present ones keep retired_at NULL", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const staying = seedPlayer(db, "Staying Player");
      const leaving = seedPlayer(db, "Leaving Player");
      upsertMembership(db, { playerId: staying.id, teamId: team.id, eventId: null });
      upsertMembership(db, { playerId: leaving.id, teamId: team.id, eventId: null });

      const count = retireAbsentMemberships(db, {
        teamId: team.id,
        observedPlayerIds: [staying.id],
        retiredAt: "2026-07-31T00:00:00.000Z",
      });

      expect(count).toBe(1);
      const rows = rowsFor(db, team.id);
      const stayingRow = rows.find((r) => r.playerId === staying.id)!;
      const leavingRow = rows.find((r) => r.playerId === leaving.id)!;
      expect(stayingRow.retiredAt).toBeNull();
      expect(leavingRow.retiredAt).toBe("2026-07-31T00:00:00.000Z");
    } finally {
      sqlite.close();
    }
  });

  it("an empty observedPlayerIds writes NOTHING (the sad path that would otherwise wipe a roster on a page-shape change)", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const player = seedPlayer(db, "Some Player");
      upsertMembership(db, { playerId: player.id, teamId: team.id, eventId: null });

      const count = retireAbsentMemberships(db, { teamId: team.id, observedPlayerIds: [], retiredAt: "2026-07-31" });

      expect(count).toBe(0);
      // Asserted on DATABASE STATE, not merely the returned count — a guard that only skipped
      // building the WHERE clause but still ran an unconditional UPDATE would return the wrong
      // count while still corrupting every row, and only reading the row back would catch that.
      const rows = rowsFor(db, team.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("leaves event_id IS NOT NULL rows alone even when that player is absent from the observed set", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const player = seedPlayer(db, "Event Player");
      const eventRow = db.insert(events).values({ name: "Sectionals", kind: "tournament" }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: eventRow.id }).run();

      const count = retireAbsentMemberships(db, { teamId: team.id, observedPlayerIds: [], retiredAt: "2026-07-31" });

      expect(count).toBe(0);
      const rows = rowsFor(db, team.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("an already-retired row keeps its ORIGINAL retired_at across a second reconcile, and is excluded from the count", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const staying = seedPlayer(db, "Staying Player");
      const leaving = seedPlayer(db, "Leaving Player");
      upsertMembership(db, { playerId: staying.id, teamId: team.id, eventId: null });
      upsertMembership(db, { playerId: leaving.id, teamId: team.id, eventId: null });

      // `staying` is observed on every reconcile below so `observedPlayerIds` is never the empty
      // set — this test is about the retired-row TIMESTAMP invariant, not the empty-set guard
      // (that has its own dedicated test above).
      const firstCount = retireAbsentMemberships(db, {
        teamId: team.id,
        observedPlayerIds: [staying.id],
        retiredAt: "2026-07-01T00:00:00.000Z",
      });
      expect(firstCount).toBe(1);

      const secondCount = retireAbsentMemberships(db, {
        teamId: team.id,
        observedPlayerIds: [staying.id],
        retiredAt: "2026-08-01T00:00:00.000Z",
      });
      expect(secondCount).toBe(0);

      const row = rowsFor(db, team.id).find((r) => r.playerId === leaving.id)!;
      expect(row.retiredAt).toBe("2026-07-01T00:00:00.000Z");
    } finally {
      sqlite.close();
    }
  });

  it("leaves other teams' memberships untouched (the teamId scope boundary)", () => {
    const { db, sqlite } = freshDb();
    try {
      const teamA = seedTeam(db, "Team A");
      const teamB = seedTeam(db, "Team B");
      const stayingA = seedPlayer(db, "Staying On A");
      const playerA = seedPlayer(db, "Player A");
      const playerB = seedPlayer(db, "Player B");
      upsertMembership(db, { playerId: stayingA.id, teamId: teamA.id, eventId: null });
      upsertMembership(db, { playerId: playerA.id, teamId: teamA.id, eventId: null });
      upsertMembership(db, { playerId: playerB.id, teamId: teamB.id, eventId: null });

      const count = retireAbsentMemberships(db, {
        teamId: teamA.id,
        observedPlayerIds: [stayingA.id],
        retiredAt: "2026-07-31",
      });

      expect(count).toBe(1);
      expect(rowsFor(db, teamB.id)[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

describe("upsertMembership un-retires on observation", () => {
  useTnDbPath();

  it("un-retires a retired row (retired_at back to NULL) and creates no second row — no-event-id membership", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const player = seedPlayer(db, "Returning Player");
      upsertMembership(db, { playerId: player.id, teamId: team.id, eventId: null });
      // Retired directly (rather than via `retireAbsentMemberships`) so this test is about
      // `upsertMembership`'s un-retire alone, independent of the reconcile primitive above.
      db.update(teamMemberships).set({ retiredAt: "2026-07-01" }).where(eq(teamMemberships.teamId, team.id)).run();
      expect(rowsFor(db, team.id)[0]!.retiredAt).toBe("2026-07-01");

      upsertMembership(db, { playerId: player.id, teamId: team.id, eventId: null });

      const rows = rowsFor(db, team.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("un-retires a retired row for the event-scoped conflict target too, pinned against the 3-column unique index", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "Team A");
      const player = seedPlayer(db, "Event Returning Player");
      const event = db.insert(events).values({ name: "Sectionals", kind: "tournament" }).returning().get();

      upsertMembership(db, { playerId: player.id, teamId: team.id, eventId: event.id });
      db.update(teamMemberships).set({ retiredAt: "2026-07-01" }).where(eq(teamMemberships.teamId, team.id)).run();
      expect(rowsFor(db, team.id)[0]!.retiredAt).toBe("2026-07-01");

      upsertMembership(db, { playerId: player.id, teamId: team.id, eventId: event.id });

      const rows = rowsFor(db, team.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
