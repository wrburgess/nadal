import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { players } from "../src/db/schema.js";
import { buildLegacyMigrationsFolder } from "./helpers/legacy-migrations.js";

const EXPECTED_TABLES = [
  "players", "player_aliases", "teams", "team_memberships", "events",
  "team_matches", "court_matches", "court_match_players",
  "rating_observations", "availability", "captain_notes", "request_log",
];

describe("tn db migrate", () => {
  it("creates every table in the domain model plus request_log", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
    runMigrations(dbPath);
    const sqlite = new Database(dbPath);
    const names = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%drizzle%' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
    sqlite.close();
  });

  it("is idempotent — running twice changes nothing and does not throw", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
    runMigrations(dbPath);
    expect(() => runMigrations(dbPath)).not.toThrow();
  });
});

// #149 Task 9/20: `players.plays` is migration 0013's own column, added on top of a database that
// may already have real rows in it — the legacy-upgrade path every prior column-addition migration
// in this file's siblings (test/db-name-key-backfill.test.ts, test/db-wtn-observed-on-migration.test.ts)
// already exercises for ITS OWN column. This is the same shape one migration later.
describe("tn db migrate — an existing local DB survives migration 0013 (#149)", () => {
  it("upgrades a database migrated through 0012 to current: players.plays exists and is NULL on every pre-existing row", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");

    // Simulate a DB migrated up through 0012_wandering_moondragon (the last migration before #149's
    // 0013 added `players.plays`) and already carrying a real row. Raw SQL, not drizzle's
    // `.insert(players).values(...).returning()` — drizzle's insert/returning builder always names
    // every column the CURRENT schema.ts declares (including `plays`, which this legacy table shape
    // does not have yet), so it would fail against it — the identical trap this file's siblings
    // already document for their own pre-migration column.
    const { sqlite: legacySqlite } = openDb(dbPath, { create: true });
    migrate(drizzle(legacySqlite), { migrationsFolder: buildLegacyMigrationsFolder(12) });
    legacySqlite.prepare("INSERT INTO players (canonical_name) VALUES (?)").run("Legacy Player");
    const seeded = legacySqlite
      .prepare("SELECT id FROM players WHERE canonical_name = ?")
      .get("Legacy Player") as { id: number };
    legacySqlite.close();

    // Upgrade to the CURRENT migrations (through 0013), which adds `players.plays`.
    runMigrations(dbPath);

    const { db, sqlite } = openDb(dbPath);
    try {
      const row = db.select({ plays: players.plays }).from(players).where(eq(players.id, seeded.id)).get();
      expect(row, "the pre-existing row must survive the upgrade").toBeDefined();
      // NULL, not a placeholder default: nobody has recorded a play-style constraint for this row,
      // and NULL is independently the correct value for that (see schema.ts's own comment on `plays`).
      expect(row?.plays).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

// #149 Task 9: pins the invariant `applyMigrations` (src/db/client.ts) actually depends on — its
// watermark check is `Number(watermark.createdAt) < migration.folderMillis`, i.e. STRICTLY greater,
// not merely non-decreasing. Migration 0012_wandering_moondragon's own `when` (1786682000000) is a
// FUTURE date (2026-08-14T04:33:20Z), already recorded as the watermark in every database migrated
// through it — measured directly against throwaway databases: a migration timestamped honestly at
// "now" (drizzle-kit generate's own value, which was earlier than 0012's future date) sorted BEFORE
// that watermark and was silently SKIPPED — the column it added was never created, and
// `applyMigrations` still reported success. That is why 0013_doubles_only's own `when`
// (1786682000001) is one millisecond past 0012's rather than its own honest "now": the journal
// cannot be fixed by editing 0012's entry, because that value is already committed to every
// migrated database's own `__drizzle_migrations` table, so rewriting the SOURCE journal would not
// change what is already on disk. Every future migration must be timestamped after 1786682000000
// until wall-clock time actually passes it.
describe("tn db migrate — the migration journal's timestamps are strictly increasing (#149 Task 9)", () => {
  it("every drizzle/meta/_journal.json entry's 'when' is strictly greater than the previous entry's", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    expect(entries.length, "sanity: the journal must not be empty for this check to mean anything").toBeGreaterThan(1);

    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const curr = entries[i]!;
      expect(
        curr.when,
        `drizzle/meta/_journal.json: "${curr.tag}"'s "when" (${curr.when}) is not strictly greater than ` +
          `the previous entry "${prev.tag}"'s (${prev.when}). applyMigrations (src/db/client.ts) skips ` +
          `any migration whose folderMillis is not STRICTLY GREATER than the watermark already recorded ` +
          `in __drizzle_migrations, so a non-increasing "when" means your new migration is SILENTLY ` +
          `SKIPPED on every already-migrated database — no error, no column, applyMigrations still ` +
          `reports success. Fix: do not edit an existing entry's "when" (0012_wandering_moondragon's is ` +
          `1786682000000, a future date already committed to every migrated database — editing the ` +
          `source journal cannot undo that). Instead give YOUR new migration a "when" strictly greater ` +
          `than the previous entry's: run \`drizzle-kit generate\` and, if the timestamp it assigns still ` +
          `sorts before the previous entry (true until wall-clock time passes 2026-08-14T04:33:20Z), bump ` +
          `it by hand to one more than the previous entry's "when".`,
      ).toBeGreaterThan(prev.when);
    }
  });
});
