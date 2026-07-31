import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { playerAliases, players, teams } from "../src/db/schema.js";
import { NameKeyNotBackfilledError, findPlayerByName, resolvePlayer } from "../src/ingest/identity.js";
import { buildLegacyMigrationsFolder } from "./helpers/legacy-migrations.js";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
}

describe("db-name-key-backfill — an existing local DB survives migration 0004", () => {
  it("backfills every row's name_key on upgrade, and resolution works afterward", () => {
    const path = freshDbPath();

    // Simulate a DB that was migrated up through 0003 (pre-#32) and already has data. Raw SQL,
    // not drizzle's `.insert(players).values(...)` — drizzle's insert builder always names every
    // column the CURRENT schema.ts declares (including `name_key`, which migration 0004 hasn't
    // added yet at this point), so it would fail against the legacy (pre-0004) table shape.
    const { sqlite: legacySqlite } = openDb(path);
    migrate(drizzle(legacySqlite), { migrationsFolder: buildLegacyMigrationsFolder(3) });
    legacySqlite.prepare("INSERT INTO players (canonical_name) VALUES (?)").run("Jane Doe");
    const seededPlayerId = legacySqlite
      .prepare("SELECT id FROM players WHERE canonical_name = ?")
      .get("Jane Doe") as { id: number };
    legacySqlite
      .prepare("INSERT INTO player_aliases (player_id, alias) VALUES (?, ?)")
      .run(seededPlayerId.id, "JD");
    legacySqlite.prepare("INSERT INTO teams (name) VALUES (?)").run("Norbury, Nova");
    legacySqlite.close();

    // Upgrade to the current (0000-0004) migrations, which backfills name_key afterward.
    runMigrations(path);

    const { db, sqlite } = openDb(path);
    try {
      const playerRows = db.select().from(players).all();
      expect(playerRows).toHaveLength(1);
      expect(playerRows[0]?.nameKey).toBe(nameKey("Jane Doe"));

      const aliasRows = db.select().from(playerAliases).all();
      expect(aliasRows).toHaveLength(1);
      expect(aliasRows[0]?.nameKey).toBe(nameKey("JD"));

      const teamRows = db.select().from(teams).all();
      expect(teamRows).toHaveLength(1);
      expect(teamRows[0]?.nameKey).toBe(nameKey("Norbury, Nova"));

      // Resolution actually works post-backfill, via the indexed tier-2 lookup.
      const resolved = resolvePlayer(db, { name: "jane doe" });
      expect(resolved.kind).toBe("matched");
      if (resolved.kind === "matched") expect(resolved.row.id).toBe(seededPlayerId.id);

      const found = findPlayerByName(db, "jane doe");
      expect(found.kind).toBe("found");
    } finally {
      sqlite.close();
    }
  });

  it("backfill is idempotent — running migrate again changes nothing", () => {
    const path = freshDbPath();
    runMigrations(path);
    const { db: seedDb, sqlite: seedSqlite } = openDb(path);
    seedDb.insert(players).values({ canonicalName: "Ellis Eastwick" }).run();
    seedDb.insert(teams).values({ name: "Team A" }).run();
    seedSqlite.close();

    // First backfill happens implicitly at insert time? No — name_key is only set by the
    // application write paths (task 5) or by backfillNameKeys, so run migrations again to trigger
    // the backfill pass over these freshly-inserted-without-a-key rows.
    runMigrations(path);
    const { db: db1, sqlite: sqlite1 } = openDb(path);
    const afterFirstBackfill = {
      players: db1.select().from(players).all(),
      teams: db1.select().from(teams).all(),
    };
    sqlite1.close();

    runMigrations(path);
    const { db: db2, sqlite: sqlite2 } = openDb(path);
    const afterSecondBackfill = {
      players: db2.select().from(players).all(),
      teams: db2.select().from(teams).all(),
    };
    sqlite2.close();

    expect(afterSecondBackfill).toEqual(afterFirstBackfill);
    expect(afterFirstBackfill.players[0]?.nameKey).toBe(nameKey("Ellis Eastwick"));
    expect(afterFirstBackfill.teams[0]?.nameKey).toBe(nameKey("Team A"));
  });

  it("FAIL-CLOSED: a NULL name_key forced into a row makes resolvePlayer throw rather than create a duplicate", () => {
    const path = freshDbPath();
    runMigrations(path);
    const { db, sqlite } = openDb(path);
    try {
      db.insert(players).values({ canonicalName: "Jane Doe", nameKey: nameKey("Jane Doe") }).run();
      // Force an unbackfilled row directly, bypassing every write path (simulating a DB that
      // skipped `tn db migrate`'s backfill somehow — the scenario the probe exists to catch).
      new Database(path).prepare("UPDATE players SET name_key = NULL WHERE canonical_name = 'Jane Doe'").run();

      expect(() => resolvePlayer(db, { name: "Jane Doe" })).toThrow(NameKeyNotBackfilledError);
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
