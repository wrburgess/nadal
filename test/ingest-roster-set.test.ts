// The event-scoped roster writer (Task 4, #113). `setEventRoster` is the ONE service both
// `tn roster set` and the `roster_set` MCP tool call — proven here directly, against a real
// on-disk database, so Task 5/6's presenters can stay thin wrappers around it.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { events, players, teamMemberships, teams } from "../src/db/schema.js";
import { rosterPayloadSchema } from "../src/ingest/roster-payload.js";
import { setEventRoster } from "../src/ingest/roster-set.js";
import type { SetEventRosterResult } from "../src/ingest/roster-set.js";
import { seedTeamWithRosters } from "./helpers/roster.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

/** Every `team_memberships` row for `teamId`, sorted for deterministic comparison. */
function membershipRows(db: Db, teamId: number) {
  return db
    .select()
    .from(teamMemberships)
    .where(eq(teamMemberships.teamId, teamId))
    .all()
    .sort((a, b) => a.id - b.id);
}

function ok(result: SetEventRosterResult): Extract<SetEventRosterResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok:true, got refusal ${JSON.stringify(result)}`);
  return result;
}

describe("setEventRoster", () => {
  useTnDbPath();

  it("happy path: N memberships written with the real event_id; the season rows are byte-unchanged", () => {
    const { db, sqlite } = freshDb();
    try {
      const season = ["Alice Anders", "Bo Bramwell", "Cy Calder"];
      const fixture = seedTeamWithRosters(db, { teamName: "OK/Dickason/40&over3.5M", season });
      const event = db
        .insert(events)
        .values({ name: "Springfield Sectionals 2026", kind: "tournament" })
        .returning()
        .get();
      const beforeSeasonRows = membershipRows(db, fixture.teamId).filter((r) => r.eventId === null);

      const result = ok(
        setEventRoster(db, {
          team: "OK/Dickason/40&over3.5M",
          event: "Springfield Sectionals 2026",
          players: ["Alice Anders", "Bo Bramwell"],
        }),
      );

      expect(result.registered).toBe(2);
      expect(result.retired).toBe(0);
      expect(result.eventId).toBe(event.id);

      const eventRows = membershipRows(db, fixture.teamId).filter((r) => r.eventId === event.id);
      expect(eventRows).toHaveLength(2);
      expect(eventRows.every((r) => r.retiredAt === null)).toBe(true);
      expect(eventRows.map((r) => r.playerId).sort()).toEqual(
        [fixture.seasonPlayerIds.get("Alice Anders")!, fixture.seasonPlayerIds.get("Bo Bramwell")!].sort(),
      );

      // Byte-unchanged: identical rows, same retiredAt (null), same count.
      const afterSeasonRows = membershipRows(db, fixture.teamId).filter((r) => r.eventId === null);
      expect(afterSeasonRows).toEqual(beforeSeasonRows);
    } finally {
      sqlite.close();
    }
  });

  it("idempotent: the same payload run twice produces the same rows, no duplicates, no retirement", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, { teamName: "Team A", season: ["Alice Anders", "Bo Bramwell"] });
      db.insert(events).values({ name: "Event X", kind: "tournament" }).returning().get();
      const payload = { team: "Team A", event: "Event X", players: ["Alice Anders", "Bo Bramwell"] };

      const first = ok(setEventRoster(db, payload));
      const rowsAfterFirst = membershipRows(db, fixture.teamId);
      const second = ok(setEventRoster(db, payload));
      const rowsAfterSecond = membershipRows(db, fixture.teamId);

      expect(second.registered).toBe(first.registered);
      expect(second.retired).toBe(0);
      expect(rowsAfterSecond).toEqual(rowsAfterFirst);
    } finally {
      sqlite.close();
    }
  });

  it("replace semantics: dropping a name retires that membership; a re-run re-adding it un-retires rather than duplicating", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "Team A",
        season: ["Alice Anders", "Bo Bramwell", "Cy Calder"],
      });
      const event = db.insert(events).values({ name: "Event X", kind: "tournament" }).returning().get();

      ok(setEventRoster(db, { team: "Team A", event: "Event X", players: ["Alice Anders", "Bo Bramwell"] }));

      // Bo is dropped from the second run.
      const dropped = ok(setEventRoster(db, { team: "Team A", event: "Event X", players: ["Alice Anders"] }));
      expect(dropped.retired).toBe(1);
      const boId = fixture.seasonPlayerIds.get("Bo Bramwell")!;
      const boEventRow = membershipRows(db, fixture.teamId).find((r) => r.eventId === event.id && r.playerId === boId);
      expect(boEventRow?.retiredAt).not.toBeNull();
      // Alice's row is untouched by the retirement.
      const aliceId = fixture.seasonPlayerIds.get("Alice Anders")!;
      const aliceEventRow = membershipRows(db, fixture.teamId).find(
        (r) => r.eventId === event.id && r.playerId === aliceId,
      );
      expect(aliceEventRow?.retiredAt).toBeNull();

      // Re-adding Bo un-retires the SAME row rather than creating a second one.
      const readded = ok(
        setEventRoster(db, { team: "Team A", event: "Event X", players: ["Alice Anders", "Bo Bramwell"] }),
      );
      expect(readded.retired).toBe(0);
      const boRowsAfterReadd = membershipRows(db, fixture.teamId).filter(
        (r) => r.eventId === event.id && r.playerId === boId,
      );
      expect(boRowsAfterReadd).toHaveLength(1);
      expect(boRowsAfterReadd[0]!.id).toBe(boEventRow!.id);
      expect(boRowsAfterReadd[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("another event's roster for the same team is untouched by a write", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "Team A",
        season: ["Alice Anders", "Bo Bramwell"],
        registered: { eventName: "Event B", names: ["Alice Anders", "Bo Bramwell"] },
      });
      db.insert(events).values({ name: "Event A", kind: "tournament" }).returning().get();
      const beforeEventBRows = membershipRows(db, fixture.teamId).filter((r) => r.eventId === fixture.eventId);

      ok(setEventRoster(db, { team: "Team A", event: "Event A", players: ["Alice Anders"] }));

      const afterEventBRows = membershipRows(db, fixture.teamId).filter((r) => r.eventId === fixture.eventId);
      expect(afterEventBRows).toEqual(beforeEventBRows);
    } finally {
      sqlite.close();
    }
  });

  it("a retired EVENT membership (dropped by a prior run) that re-registers is un-retired at EVENT scope only — its season row is never touched", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, { teamName: "Team A", season: ["Alice Anders", "Bo Bramwell"] });
      const event = db.insert(events).values({ name: "Event X", kind: "tournament" }).returning().get();

      // Register both, then a second run drops Alice (Bo alone satisfies the non-empty payload
      // rule) — her EVENT row is now retired; her SEASON row is never touched by any of this.
      ok(setEventRoster(db, { team: "Team A", event: "Event X", players: ["Alice Anders", "Bo Bramwell"] }));
      ok(setEventRoster(db, { team: "Team A", event: "Event X", players: ["Bo Bramwell"] }));

      const aliceId = fixture.seasonPlayerIds.get("Alice Anders")!;
      const aliceSeasonRowBefore = membershipRows(db, fixture.teamId).find(
        (r) => r.eventId === null && r.playerId === aliceId,
      )!;
      const aliceEventRowBefore = membershipRows(db, fixture.teamId).find(
        (r) => r.eventId === event.id && r.playerId === aliceId,
      )!;
      expect(aliceSeasonRowBefore.retiredAt).toBeNull();
      expect(aliceEventRowBefore.retiredAt).not.toBeNull();

      // Alice re-registers.
      const readded = ok(
        setEventRoster(db, { team: "Team A", event: "Event X", players: ["Alice Anders", "Bo Bramwell"] }),
      );
      expect(readded.retired).toBe(0);

      const aliceSeasonRowAfter = membershipRows(db, fixture.teamId).find(
        (r) => r.eventId === null && r.playerId === aliceId,
      )!;
      const aliceEventRowsAfter = membershipRows(db, fixture.teamId).filter(
        (r) => r.eventId === event.id && r.playerId === aliceId,
      );
      // The season row is untouched throughout — same row, still never retired.
      expect(aliceSeasonRowAfter).toEqual(aliceSeasonRowBefore);
      // The event row is un-retired IN PLACE — not a second row.
      expect(aliceEventRowsAfter).toHaveLength(1);
      expect(aliceEventRowsAfter[0]!.id).toBe(aliceEventRowBefore.id);
      expect(aliceEventRowsAfter[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  describe("sad paths — nothing is written", () => {
    it("unknown team", () => {
      const { db, sqlite } = freshDb();
      try {
        seedTeamWithRosters(db, { teamName: "Team A", season: ["Alice Anders"] });
        db.insert(events).values({ name: "Event X", kind: "tournament" }).returning().get();

        const result = setEventRoster(db, { team: "No Such Team", event: "Event X", players: ["Alice Anders"] });

        expect(result).toMatchObject({ ok: false, kind: "unknown-team" });
        expect(db.select().from(teamMemberships).all().every((r) => r.eventId === null)).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it("unknown event", () => {
      const { db, sqlite } = freshDb();
      try {
        seedTeamWithRosters(db, { teamName: "Team A", season: ["Alice Anders"] });

        const result = setEventRoster(db, { team: "Team A", event: "No Such Event", players: ["Alice Anders"] });

        expect(result).toEqual({ ok: false, kind: "unknown-event", event: "No Such Event" });
        expect(db.select().from(teamMemberships).all().every((r) => r.eventId === null)).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it("duplicate names in one payload", () => {
      const { db, sqlite } = freshDb();
      try {
        seedTeamWithRosters(db, { teamName: "Team A", season: ["Alice Anders"] });
        db.insert(events).values({ name: "Event X", kind: "tournament" }).returning().get();

        const result = setEventRoster(db, {
          team: "Team A",
          event: "Event X",
          players: ["Alice Anders", "Alice Anders"],
        });

        expect(result).toEqual({ ok: false, kind: "duplicate-names", names: ["Alice Anders"] });
        expect(db.select().from(teamMemberships).all().every((r) => r.eventId === null)).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it("unresolved name (not on the team's roster at all)", () => {
      const { db, sqlite } = freshDb();
      try {
        seedTeamWithRosters(db, { teamName: "Team A", season: ["Alice Anders"] });
        db.insert(events).values({ name: "Event X", kind: "tournament" }).returning().get();

        const result = setEventRoster(db, { team: "Team A", event: "Event X", players: ["Ghost Player"] });

        expect(result).toMatchObject({
          ok: false,
          kind: "unresolved-players",
          flags: [{ name: "Ghost Player", reason: "unresolved" }],
        });
        expect(db.select().from(teamMemberships).all().every((r) => r.eventId === null)).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it("ambiguous name (two roster players share it)", () => {
      const { db, sqlite } = freshDb();
      try {
        const fixture = seedTeamWithRosters(db, { teamName: "Team A", season: [] });
        const dup1 = db.insert(players).values({ canonicalName: "Sam Smith" }).returning().get();
        const dup2 = db.insert(players).values({ canonicalName: "Sam Smith" }).returning().get();
        db.insert(teamMemberships).values({ playerId: dup1.id, teamId: fixture.teamId, eventId: null }).run();
        db.insert(teamMemberships).values({ playerId: dup2.id, teamId: fixture.teamId, eventId: null }).run();
        backfillNameKeys(db);
        db.insert(events).values({ name: "Event X", kind: "tournament" }).returning().get();

        const result = setEventRoster(db, { team: "Team A", event: "Event X", players: ["Sam Smith"] });

        expect(result.ok).toBe(false);
        if (!result.ok && result.kind === "unresolved-players") {
          expect(result.flags[0]!.reason).toBe("ambiguous");
        } else {
          throw new Error("expected kind unresolved-players");
        }
        expect(db.select().from(teamMemberships).all().every((r) => r.eventId === null)).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it("collect-all: a payload with three bad names (unresolved, ambiguous, off-roster) reports all three, not the first", () => {
      const { db, sqlite } = freshDb();
      try {
        const fixture = seedTeamWithRosters(db, { teamName: "Team A", season: ["Alice Anders"] });
        // Ambiguous pair, both on THIS team's roster.
        const dup1 = db.insert(players).values({ canonicalName: "Sam Smith" }).returning().get();
        const dup2 = db.insert(players).values({ canonicalName: "Sam Smith" }).returning().get();
        db.insert(teamMemberships).values({ playerId: dup1.id, teamId: fixture.teamId, eventId: null }).run();
        db.insert(teamMemberships).values({ playerId: dup2.id, teamId: fixture.teamId, eventId: null }).run();
        // Off-roster: a real player, but on a DIFFERENT team — reached via a prefix-ID (`tr:`), the
        // ONE tier of `resolveRosterPlayer`'s ladder that can distinguish "a real player, wrong
        // roster" from "not found at all"; a bare name off this roster is `unresolved`, not
        // `off-roster` (see that function's own doc comment).
        const otherTeam = db.insert(teams).values({ name: "Other Team" }).returning().get();
        const stranger = db
          .insert(players)
          .values({ canonicalName: "Off Roster Ollie", tennisrecordUrl: "https://tennisrecord.example/ollie" })
          .returning()
          .get();
        db.insert(teamMemberships).values({ playerId: stranger.id, teamId: otherTeam.id, eventId: null }).run();
        backfillNameKeys(db);
        db.insert(events).values({ name: "Event X", kind: "tournament" }).returning().get();

        const result = setEventRoster(db, {
          team: "Team A",
          event: "Event X",
          players: ["Ghost Player", "Sam Smith", "tr:https://tennisrecord.example/ollie"],
        });

        expect(result.ok).toBe(false);
        if (!result.ok && result.kind === "unresolved-players") {
          const byName = new Map(result.flags.map((f) => [f.name, f.reason]));
          expect(byName.get("Ghost Player")).toBe("unresolved");
          expect(byName.get("Sam Smith")).toBe("ambiguous");
          expect(byName.get("tr:https://tennisrecord.example/ollie")).toBe("off-roster");
          expect(result.flags).toHaveLength(3);
        } else {
          throw new Error("expected kind unresolved-players");
        }
        expect(db.select().from(teamMemberships).all().every((r) => r.eventId === null)).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it("empty players is refused at the schema boundary — the writer never even sees it", () => {
      const parsed = rosterPayloadSchema.safeParse({ team: "Team A", event: "Event X", players: [] });
      expect(parsed.success).toBe(false);
    });
  });
});
