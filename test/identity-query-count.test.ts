// Issue #32, Testing Strategy suite D (ask #4). Verifies name resolution issues a CONSTANT number
// of SQL statements regardless of table size, rather than one per row — a set-based indexed lookup
// executes as one statement whether it matches 5 rows or 200. Uses the task-7 `verbose` seam on
// `openDb` (better-sqlite3's `new Database(path, { verbose })`, which invokes `verbose` with every
// statement the connection executes) as the observation point.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { players, teams } from "../src/db/schema.js";
import { resolvePlayer, resolveTeam } from "../src/ingest/identity.js";
import { resolvePlayerTarget } from "../src/query/player-profile.js";
import { buildNamePool } from "./helpers/players.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-query-count-")), "test.db");
}

function seedPlayers(db: Db, count: number): void {
  const pool = buildNamePool();
  const names = Array.from({ length: count }, (_, i) => `${pool[i % pool.length]} ${i}`);
  db.insert(players)
    .values(names.map((name) => ({ canonicalName: name, nameKey: nameKey(name) })))
    .run();
}

function seedTeams(db: Db, count: number): void {
  const names = Array.from({ length: count }, (_, i) => `Team ${i}`);
  db.insert(teams)
    .values(names.map((name) => ({ name, nameKey: nameKey(name) })))
    .run();
}

/** Runs `operation` against a freshly migrated + seeded DB and returns the number of SQL
 * statements the connection executed during `operation` alone — the connection's own setup
 * PRAGMAs (`journal_mode`, `foreign_keys`) are excluded by clearing the log right after `openDb`,
 * and seeding itself runs on a separate, non-verbose connection so it is never counted either. */
function countStatementsFor(seed: (db: Db, count: number) => void, count: number, operation: (db: Db) => void): number {
  const path = freshDbPath();
  runMigrations(path);
  {
    const { db, sqlite } = openDb(path);
    seed(db, count);
    sqlite.close();
  }

  const statements: string[] = [];
  const { db, sqlite } = openDb(path, { verbose: (message) => statements.push(String(message)) });
  try {
    statements.length = 0;
    operation(db);
    return statements.length;
  } finally {
    sqlite.close();
  }
}

describe("identity resolution issues a constant number of SQL statements, independent of table size", () => {
  it("resolvePlayer: a 5-player DB and a 200-player DB issue the SAME statement count", () => {
    const smallCount = countStatementsFor(seedPlayers, 5, (db) => {
      resolvePlayer(db, { name: "A Query That Matches No One At All" });
    });
    const largeCount = countStatementsFor(seedPlayers, 200, (db) => {
      resolvePlayer(db, { name: "A Query That Matches No One At All" });
    });

    // Guard against a false green: a broken/unwired verbose hook would report 0 for both sizes and
    // 0 === 0 would pass trivially. Assert the counter actually observed something first.
    expect(smallCount).toBeGreaterThan(0);
    expect(largeCount).toBe(smallCount);
  });

  it("resolveTeam: a 5-team DB and a 200-team DB issue the SAME statement count", () => {
    const smallCount = countStatementsFor(seedTeams, 5, (db) => {
      resolveTeam(db, { name: "A Query Team That Matches No One At All" });
    });
    const largeCount = countStatementsFor(seedTeams, 200, (db) => {
      resolveTeam(db, { name: "A Query Team That Matches No One At All" });
    });

    expect(smallCount).toBeGreaterThan(0);
    expect(largeCount).toBe(smallCount);
  });

  it("findPlayerByNameOrAlias (via the exported resolvePlayerTarget): a 5-player DB and a 200-player DB issue the SAME statement count", () => {
    const smallCount = countStatementsFor(seedPlayers, 5, (db) => {
      resolvePlayerTarget(db, "A Query That Matches No One At All");
    });
    const largeCount = countStatementsFor(seedPlayers, 200, (db) => {
      resolvePlayerTarget(db, "A Query That Matches No One At All");
    });

    expect(smallCount).toBeGreaterThan(0);
    expect(largeCount).toBe(smallCount);
  });
});
