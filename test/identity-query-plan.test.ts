// Issue #32 — the guard the statement-count suite could not provide.
//
// Codex's adversarial review of PR #40 (rated high) showed test/identity-query-count.test.ts is a
// FALSE GREEN on its own: it counts SQL *statements*, and reverting the indexed lookups to
// `db.select().from(players).all()` still issues a constant number of statements, so those
// assertions stay green while resolution loads the whole table again — the exact regression this
// issue exists to prevent.
//
// The fix is to observe what the statements DO, not how many there are. This suite captures the SQL
// the production code actually executes (via the same `verbose` seam) and asserts each one's
// EXPLAIN QUERY PLAN, so the assertion is bound to the real query text rather than to a hand-copied
// duplicate that could drift from it.
//
// The assertion is "no SCAN", NOT "mentions the expected index" — deliberately. SQLite reports the
// reverted full-table read as `SCAN players USING COVERING INDEX players_name_key_length_idx`: it
// NAMES the index while still scanning every row, so an "includes the intended index" assertion
// would pass on precisely the reversion this file exists to catch. Verified against SQLite 3.53.2
// before this test was written.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { players, teams } from "../src/db/schema.js";
import { findPlayerByName, resolvePlayer, resolveTeam } from "../src/ingest/identity.js";
import { resolvePlayerTarget } from "../src/query/player-profile.js";
import { buildNamePool } from "./helpers/players.js";

type Db = ReturnType<typeof openDb>["db"];

/** The tables whose full-table reads this issue exists to eliminate. */
const KEYED_TABLES = ["players", "player_aliases", "teams"];

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-query-plan-")), "test.db");
}

/**
 * Runs `operation` against a seeded DB, capturing every statement it executes, and returns the
 * EXPLAIN QUERY PLAN of each captured SELECT that touches a keyed table.
 */
function plansFor(operation: (db: Db) => void, playerCount = 40): { sql: string; plan: string }[] {
  const path = freshDbPath();
  runMigrations(path);
  {
    const { db, sqlite } = openDb(path);
    const pool = buildNamePool();
    const names = Array.from({ length: playerCount }, (_, i) => `${pool[i % pool.length]} ${i}`);
    db.insert(players).values(names.map((n) => ({ canonicalName: n, nameKey: nameKey(n) }))).run();
    db.insert(teams).values(names.map((n) => ({ name: `Team ${n}`, nameKey: nameKey(`Team ${n}`) }))).run();
    sqlite.close();
  }

  const captured: string[] = [];
  const { db, sqlite } = openDb(path, { verbose: (message) => captured.push(String(message)) });
  try {
    captured.length = 0;
    operation(db);
  } finally {
    sqlite.close();
  }

  // A second, plain connection: EXPLAIN must not itself be counted or recursively captured.
  const { db: explainDb, sqlite: explainSqlite } = openDb(path);
  try {
    return captured
      .filter((sql) => /^\s*select/i.test(sql))
      .filter((sql) => KEYED_TABLES.some((t) => new RegExp(`\\b${t}\\b`, "i").test(sql)))
      .map((sql) => ({
        sql,
        plan: explainDb.all<{ detail: string }>(`explain query plan ${sql}` as never)
          .map((r) => r.detail)
          .join(" ; "),
      }));
  } finally {
    explainSqlite.close();
  }
}

function expectNoScans(entries: { sql: string; plan: string }[]): void {
  // Guard against a false green of this suite's own: if nothing was captured, the loop below
  // asserts nothing and passes vacuously.
  expect(entries.length).toBeGreaterThan(0);

  for (const { sql, plan } of entries) {
    const scansAKeyedTable = KEYED_TABLES.some((t) => new RegExp(`SCAN\\s+${t}\\b`, "i").test(plan));
    // Name the offending statement AND its plan in the failure message: a bare `false === true`
    // here would send the next reader hunting for which of a dozen statements regressed.
    expect(scansAKeyedTable, `full-table scan reintroduced:\n  SQL:  ${sql}\n  PLAN: ${plan}`).toBe(false);
  }
}

describe("identity resolution never full-table-scans a keyed table", () => {
  it("resolvePlayer (name only — tiers 2 and 3) issues no scan of players or player_aliases", () => {
    expectNoScans(plansFor((db) => {
      resolvePlayer(db, { name: "A Query That Matches No One At All" });
    }));
  });

  it("resolveTeam (name only) issues no scan of teams", () => {
    expectNoScans(plansFor((db) => {
      resolveTeam(db, { name: "A Query Team That Matches No One At All" });
    }));
  });

  it("findPlayerByName issues no scan of players", () => {
    expectNoScans(plansFor((db) => {
      findPlayerByName(db, "A Query That Matches No One At All");
    }));
  });

  it("resolvePlayerTarget (the query layer's name/alias path) issues no scan", () => {
    expectNoScans(plansFor((db) => {
      resolvePlayerTarget(db, "A Query That Matches No One At All");
    }));
  });

  it("the fuzzy band itself is index-backed, not a scan filtered in JS", () => {
    // A probe close enough to real corpus names to actually enter tier 3 with a non-empty band,
    // so this exercises the banded read rather than an early exact-tier return.
    const entries = plansFor((db) => {
      findPlayerByName(db, `${buildNamePool()[0]} 0x`);
    });
    expectNoScans(entries);
    // And the band query specifically must be served by the length index. Selected by its RANGE
    // PREDICATE, not by a bare `name_key_length` mention: drizzle's `select()` lists that column in
    // every projection, so the looser match picked the exact-tier query instead. Selecting by the
    // predicate also keeps this non-circular — the entry is chosen by what it asks for, not by the
    // plan being asserted.
    const band = entries.find((e) => /name_key_length["'`\]\s]*>=/i.test(e.sql));
    expect(band, "no name_key_length band query was issued at all").toBeDefined();
    expect(band?.plan).toMatch(/USING INDEX players_name_key_length_idx/i);
  });
});
