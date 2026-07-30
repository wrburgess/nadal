import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const V0_TAG = "0000_fuzzy_wolf_cub";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
}

/**
 * Applies ONLY the original (v0) migration to `dbPath`, by pointing drizzle's migrator at a temp
 * folder containing just that one migration's journal entry + .sql file — reproducing "a database
 * that was created and used before this PR's partial-unique-index migration existed" without
 * needing a second, permanently-frozen copy of the v0 schema anywhere in the repo.
 */
function applyV0Schema(dbPath: string): void {
  const v0Dir = mkdtempSync(join(tmpdir(), "tn-v0-migrations-"));
  mkdirSync(join(v0Dir, "meta"));

  const journal = JSON.parse(readFileSync(join(REPO_ROOT, "drizzle/meta/_journal.json"), "utf8"));
  const v0Entry = journal.entries.find((e: { tag: string }) => e.tag === V0_TAG);
  writeFileSync(join(v0Dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: [v0Entry] }));
  copyFileSync(join(REPO_ROOT, "drizzle", `${V0_TAG}.sql`), join(v0Dir, `${V0_TAG}.sql`));

  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: v0Dir });
  } finally {
    sqlite.close();
  }
}

describe("upgrading an existing v0 database (Codex round-1 finding on PR #20)", () => {
  it("does not fail CREATE UNIQUE INDEX when the v0 database already has duplicate NULL-event memberships", () => {
    // The v0 schema's 3-column UNIQUE(player_id, team_id, event_id) is exactly the bug item 3
    // fixes: SQLite treats NULLs as distinct, so a real v0 database could already contain
    // (team, player, NULL) duplicates. A migration that just adds
    // `CREATE UNIQUE INDEX ... WHERE event_id IS NULL` with no reconciliation step would fail on
    // any such database, leaving `tn db migrate` permanently unusable for it.
    const dbPath = freshDbPath();
    applyV0Schema(dbPath);

    const seed = new Database(dbPath);
    seed.exec(`INSERT INTO players (canonical_name) VALUES ('Jane Doe')`);
    seed.exec(`INSERT INTO teams (name) VALUES ('Team A')`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`);
    seed.close();

    expect(() => runMigrations(dbPath)).not.toThrow();

    const after = new Database(dbPath);
    try {
      const rows = after.prepare("SELECT * FROM team_memberships").all();
      // The pre-existing duplicate is reconciled (one survivor), not silently left in place —
      // dropping to zero rows or leaving both would both be wrong.
      expect(rows).toHaveLength(1);
    } finally {
      after.close();
    }
  });

  it("does not touch non-NULL-event rows, including ones that share a (team, player) pair with a NULL-event row", () => {
    const dbPath = freshDbPath();
    applyV0Schema(dbPath);

    const seed = new Database(dbPath);
    seed.exec(`INSERT INTO players (canonical_name) VALUES ('Jane Doe')`);
    seed.exec(`INSERT INTO teams (name) VALUES ('Team A')`);
    seed.exec(`INSERT INTO events (name, kind) VALUES ('Event One', 'league')`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, 1)`);
    seed.close();

    expect(() => runMigrations(dbPath)).not.toThrow();

    const after = new Database(dbPath);
    try {
      const rows = after.prepare("SELECT * FROM team_memberships").all() as Array<{ event_id: number | null }>;
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.event_id === null)).toHaveLength(1);
      expect(rows.filter((r) => r.event_id === 1)).toHaveLength(1);
    } finally {
      after.close();
    }
  });
});
