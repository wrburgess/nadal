import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { events, players, teamMemberships, teams } from "../src/db/schema.js";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
}

function seedPlayerAndTeam(db: ReturnType<typeof openDb>["db"]) {
  db.insert(players).values({ canonicalName: "Jane Doe" }).run();
  db.insert(teams).values({ name: "Team A" }).run();
  const player = db.select().from(players).all()[0]!;
  const team = db.select().from(teams).all()[0]!;
  return { player, team };
}

describe("team_memberships uniqueness", () => {
  it("rejects inserting the same (team, player) pair twice when event_id is NULL", () => {
    // event_id is deliberately nullable — a roster pulled outside an event is the NORMAL path,
    // not an edge case — and spec requires idempotent upserts. SQLite treats NULLs as distinct
    // by default, so a plain 3-column UNIQUE(player_id, team_id, event_id) fails OPEN here: two
    // identical (team, player, NULL) rows both insert without error.
    const path = freshDbPath();
    runMigrations(path);
    const { db, sqlite } = openDb(path);
    try {
      const { player, team } = seedPlayerAndTeam(db);
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
      expect(() =>
        db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run(),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("still allows the same (team, player) pair across two distinct non-NULL events", () => {
    const path = freshDbPath();
    runMigrations(path);
    const { db, sqlite } = openDb(path);
    try {
      const { player, team } = seedPlayerAndTeam(db);
      db.insert(events).values([
        { name: "Event One", kind: "league" },
        { name: "Event Two", kind: "league" },
      ]).run();
      const [eventOne, eventTwo] = db.select().from(events).all();

      db.insert(teamMemberships)
        .values({ playerId: player.id, teamId: team.id, eventId: eventOne!.id })
        .run();
      expect(() =>
        db.insert(teamMemberships)
          .values({ playerId: player.id, teamId: team.id, eventId: eventTwo!.id })
          .run(),
      ).not.toThrow();

      const rows = db.select().from(teamMemberships).all();
      expect(rows).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("still rejects a duplicate (team, player, event) triple for a non-NULL event", () => {
    const path = freshDbPath();
    runMigrations(path);
    const { db, sqlite } = openDb(path);
    try {
      const { player, team } = seedPlayerAndTeam(db);
      db.insert(events).values({ name: "Event One", kind: "league" }).run();
      const event = db.select().from(events).all()[0]!;

      db.insert(teamMemberships)
        .values({ playerId: player.id, teamId: team.id, eventId: event.id })
        .run();
      expect(() =>
        db.insert(teamMemberships)
          .values({ playerId: player.id, teamId: team.id, eventId: event.id })
          .run(),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });
});
