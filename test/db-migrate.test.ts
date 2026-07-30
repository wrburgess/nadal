import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/client.js";

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
