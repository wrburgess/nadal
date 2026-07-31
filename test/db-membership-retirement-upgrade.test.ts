import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/client.js";
import { buildLegacyMigrationsFolder } from "./helpers/legacy-migrations.js";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
}

/**
 * Applies ONLY migrations 0000-0005 — i.e. the schema as it existed immediately BEFORE issue #49's
 * migration adds `retired_at` — reproducing "a database that was created and used before this PR"
 * without freezing a second, permanent copy of the pre-#49 schema anywhere in the repo. Mirrors
 * `test/db-membership-unique-upgrade.test.ts`'s `applyV0Schema` shape, generalized via
 * `buildLegacyMigrationsFolder` (already used the same way by `test/db-name-key-backfill.test.ts`).
 */
function applyPre0006Schema(dbPath: string): void {
  const legacyDir = buildLegacyMigrationsFolder(5);
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: legacyDir });
  } finally {
    sqlite.close();
  }
}

describe("upgrading an existing pre-#49 database gains a nullable retired_at, backfilled to current", () => {
  it("adds the column and every pre-existing membership row reads as current (retired_at IS NULL)", () => {
    const dbPath = freshDbPath();
    applyPre0006Schema(dbPath);

    const seed = new Database(dbPath);
    seed.exec(`INSERT INTO players (canonical_name) VALUES ('Jane Doe')`);
    seed.exec(`INSERT INTO players (canonical_name) VALUES ('John Roe')`);
    seed.exec(`INSERT INTO teams (name) VALUES ('Team A')`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (2, 1, NULL)`);
    seed.close();

    // Before this migration exists, `team_memberships` has no `retired_at` column at all — this is
    // the RED half of the test: it must fail for "no such column", not pass by accident.
    expect(() => runMigrations(dbPath)).not.toThrow();

    const after = new Database(dbPath);
    try {
      const columns = after.prepare("PRAGMA table_info(team_memberships)").all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain("retired_at");

      const rows = after
        .prepare("SELECT retired_at FROM team_memberships ORDER BY id")
        .all() as Array<{ retired_at: string | null }>;
      expect(rows).toHaveLength(2);
      // The backfill invents no departure date — every row that existed before this migration reads
      // as a CURRENT member, not a retroactively retired one.
      expect(rows.every((r) => r.retired_at === null)).toBe(true);
    } finally {
      after.close();
    }
  });

  // Issue #49, Codex adversarial review round 5. The PRECONDITION half of that finding: an upgraded
  // database has no roster provenance for any pre-existing team. The consequence half — that a team
  // with no baseline must not be treated as authoritative — is pinned in
  // test/ingest-team-pull.test.ts ("a team with no established baseline ...").
  it("leaves every pre-existing team WITHOUT a roster provenance baseline (both watermarks NULL)", () => {
    const dbPath = freshDbPath();
    applyPre0006Schema(dbPath);

    const seed = new Database(dbPath);
    seed.exec(`INSERT INTO players (canonical_name) VALUES ('Jane Doe')`);
    seed.exec(`INSERT INTO teams (name) VALUES ('Team A')`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`);
    seed.close();

    runMigrations(dbPath);

    const after = new Database(dbPath);
    try {
      const columns = (after.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toContain("roster_observed_at");
      expect(columns).toContain("roster_observed_url");

      const row = after
        .prepare("SELECT roster_observed_at, roster_observed_url FROM teams WHERE name = 'Team A'")
        .get() as { roster_observed_at: string | null; roster_observed_url: string | null };
      // Nothing is invented here either — but it means a legacy team's FIRST pull cannot be trusted
      // to assert departures, which is what the ingest-side guard turns on.
      expect(row.roster_observed_at).toBeNull();
      expect(row.roster_observed_url).toBeNull();
    } finally {
      after.close();
    }
  });

  it("is idempotent — running the migration a second time changes nothing and does not throw", () => {
    const dbPath = freshDbPath();
    applyPre0006Schema(dbPath);
    runMigrations(dbPath);

    const before = new Database(dbPath);
    const beforeColumns = before.prepare("PRAGMA table_info(team_memberships)").all();
    before.close();

    expect(() => runMigrations(dbPath)).not.toThrow();

    const after = new Database(dbPath);
    try {
      const afterColumns = after.prepare("PRAGMA table_info(team_memberships)").all();
      expect(afterColumns).toEqual(beforeColumns);
    } finally {
      after.close();
    }
  });

  it("accepts a raw insert that omits retired_at — the compile/runtime contract ~20 existing test files depend on", () => {
    const dbPath = freshDbPath();
    runMigrations(dbPath);

    const sqlite = new Database(dbPath);
    try {
      sqlite.exec(`INSERT INTO players (canonical_name) VALUES ('Jane Doe')`);
      sqlite.exec(`INSERT INTO teams (name) VALUES ('Team A')`);
      expect(() =>
        sqlite.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`),
      ).not.toThrow();

      const row = sqlite.prepare("SELECT retired_at FROM team_memberships").get() as { retired_at: string | null };
      expect(row.retired_at).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
