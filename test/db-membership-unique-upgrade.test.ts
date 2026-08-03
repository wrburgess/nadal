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
    // THREE duplicates, not two (#64). With two rows, "the survivor is id 1" and "the survivor is
    // whichever row the DELETE happened to leave" are indistinguishable half the time; with three,
    // MIN(id)=1, MAX(id)=3 and an arbitrary pick=2 are three different answers, so the assertion
    // below can only pass for the behavior the migration comment actually promises.
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`);
    seed.exec(`INSERT INTO team_memberships (player_id, team_id, event_id) VALUES (1, 1, NULL)`);
    seed.close();

    expect(() => runMigrations(dbPath)).not.toThrow();

    const after = new Database(dbPath);
    try {
      const rows = after.prepare("SELECT * FROM team_memberships").all() as Array<{ id: number }>;
      // The pre-existing duplicates are reconciled (one survivor), not silently left in place —
      // dropping to zero rows or leaving several would both be wrong.
      expect(rows).toHaveLength(1);
      // ...and it is specifically the LOWEST id, which is what drizzle/0001_awesome_korg.sql's
      // comment promises ("Keeps the lowest id per duplicate pair") and what its `MIN(id)`
      // subquery implements. Row count alone cannot see the difference between MIN and MAX, so
      // the comment was an unenforced claim until this line existed (#64, docs/findings.md).
      // Which row survives is not cosmetic: `id` is the foreign key any future membership-scoped
      // row would point at, and the lowest id is the earliest-recorded membership.
      expect(rows[0]?.id).toBe(1);
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
      const rows = after.prepare("SELECT * FROM team_memberships").all() as Array<{
        id: number;
        event_id: number | null;
      }>;
      expect(rows).toHaveLength(2);
      const nullEventRows = rows.filter((r) => r.event_id === null);
      expect(nullEventRows).toHaveLength(1);
      // Same survivor-identity assertion as the test above (#64): the NULL-event row that survives
      // is id 1, not id 2. Asserting only the count here would leave this test unable to tell a
      // MIN(id) dedup from a MAX(id) one either.
      expect(nullEventRows[0]?.id).toBe(1);
      const eventRows = rows.filter((r) => r.event_id === 1);
      expect(eventRows).toHaveLength(1);
      // The untouched non-NULL row keeps its own id — this test's subject is that the DELETE's
      // `WHERE event_id IS NULL` really does exclude it, and an id check says so directly.
      expect(eventRows[0]?.id).toBe(3);
    } finally {
      after.close();
    }
  });
});
