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
import { NameKeyNotBackfilledError, resolvePlayer, resolveTeam } from "../src/ingest/identity.js";
import { buildLegacyMigrationsFolder } from "./helpers/legacy-migrations.js";

const RLO = "‮"; // RIGHT-TO-LEFT OVERRIDE — see test/name-key.test.ts for why this is an escape

/**
 * The fold that shipped BEFORE #62, written out literally.
 *
 * This is deliberately a hand-copy rather than an import or a parameterised `nameKey`. A test that
 * derived the "old" key by calling the current `nameKey` would assert that the fold equals itself,
 * which is true no matter how broken the migration is — the test would go green on a migration that
 * did nothing at all.
 */
function oldFold(s: string): string {
  return s.trim().normalize("NFC").toLowerCase();
}

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-refold-")), "test.db");
}

/**
 * Issue #62's migration half: changing `nameKey` invalidates every key already stored under the old
 * fold, and NOTHING IN THE CODEBASE DETECTS THAT. `backfillNameKeys` only fills keys that are
 * `NULL`, and the fail-closed probe in `src/ingest/identity.ts` likewise only refuses on `NULL`, so
 * a key written under an older fold is non-null, wrong, and silently trusted.
 *
 * The consequence is measured below rather than asserted in the abstract, because it is worse than
 * it first looks. A stale key is not always caught by tier 3: the fuzzy band pre-filters candidates
 * on `name_key_length` within ±`FUZZY_MAX_DISTANCE`, and a stored key holding three stripped
 * characters is 3 longer than the target's new key — outside the band — so the row is never even a
 * candidate, and the ladder creates a duplicate SILENTLY. That is the exact defect #62 is closing,
 * reintroduced by the fix for it, which is why migration 0010 is not optional.
 */
describe("db-name-key-refold — an existing DB keyed under the OLD fold upgrades past migration 0010", () => {
  /** A DB migrated up through 0009 (the last migration before #62) carrying old-fold keys. */
  function seedLegacyDb(): { path: string; ids: { player: number; team: number; alias: number } } {
    const path = freshDbPath();
    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    migrate(drizzle(sqlite), { migrationsFolder: buildLegacyMigrationsFolder(9) });

    // Names a pre-fix pull would really have stored: one carrying three invisible overrides (the
    // silent-fork case), one full-width (docs/findings.md:319), and one plain ASCII whose key the
    // new fold leaves completely unchanged — the control, so a migration that simply rewrote every
    // key to a constant could not pass.
    const forked = "Anna V" + RLO + "e" + RLO + "r" + RLO + "steeg";
    const fullWidth = "Ｎｏｖａ Ｎｏｒｂｕｒｙ";
    const plain = "Brett Halloran";

    const insertPlayer = sqlite.prepare("INSERT INTO players (canonical_name, name_key) VALUES (?, ?)");
    insertPlayer.run(forked, oldFold(forked));
    insertPlayer.run(fullWidth, oldFold(fullWidth));
    insertPlayer.run(plain, oldFold(plain));

    const playerId = (
      sqlite.prepare("SELECT id FROM players WHERE canonical_name = ?").get(forked) as { id: number }
    ).id;
    sqlite
      .prepare("INSERT INTO player_aliases (player_id, alias, name_key) VALUES (?, ?, ?)")
      .run(playerId, "A. Vers" + RLO + "teeg", oldFold("A. Vers" + RLO + "teeg"));
    const aliasId = (
      sqlite.prepare("SELECT id FROM player_aliases WHERE player_id = ?").get(playerId) as { id: number }
    ).id;

    const teamName = "S" + RLO + "p" + RLO + "r" + RLO + "ingfield A";
    sqlite.prepare("INSERT INTO teams (name, name_key) VALUES (?, ?)").run(teamName, oldFold(teamName));
    const teamId = (
      sqlite.prepare("SELECT id FROM teams WHERE name = ?").get(teamName) as { id: number }
    ).id;

    sqlite.close();
    return { path, ids: { player: playerId, team: teamId, alias: aliasId } };
  }

  it("SANITY: the seeded keys really are stale — the old fold and the new one disagree", () => {
    // Without this, every assertion below could pass against a seed the new fold happened to agree
    // with, and the suite would prove nothing about re-keying.
    const forked = "Anna V" + RLO + "e" + RLO + "r" + RLO + "steeg";
    expect(oldFold(forked)).not.toBe(nameKey(forked));
    expect(oldFold("Ｎｏｖａ Ｎｏｒｂｕｒｙ")).not.toBe(nameKey("Ｎｏｖａ Ｎｏｒｂｕｒｙ"));
    // ...and the control really is unaffected, so it is a control and not a second positive case.
    expect(oldFold("Brett Halloran")).toBe(nameKey("Brett Halloran"));
  });

  it("re-keys every row across all three keyed tables, without touching the source names", () => {
    const { path, ids } = seedLegacyDb();
    runMigrations(path);

    const { db, sqlite } = openDb(path);
    try {
      const playerRows = db.select().from(players).all();
      expect(playerRows).toHaveLength(3);
      for (const row of playerRows) {
        expect(row.nameKey).toBe(nameKey(row.canonicalName));
      }

      const aliasRows = db.select().from(playerAliases).all();
      expect(aliasRows).toHaveLength(1);
      for (const row of aliasRows) {
        expect(row.nameKey).toBe(nameKey(row.alias));
      }

      const teamRows = db.select().from(teams).all();
      expect(teamRows).toHaveLength(1);
      for (const row of teamRows) {
        expect(row.nameKey).toBe(nameKey(row.name));
      }

      // The migration rewrites DERIVED data only. The canonical names — the thing a downgrade would
      // have to re-derive from, and the only irreplaceable half — are byte-identical.
      const forked = playerRows.find((r) => r.id === ids.player);
      expect(forked?.canonicalName).toBe("Anna V" + RLO + "e" + RLO + "r" + RLO + "steeg");
      expect(db.select().from(teams).all()[0]?.name).toBe("S" + RLO + "p" + RLO + "r" + RLO + "ingfield A");
    } finally {
      sqlite.close();
    }
  });

  it("resolution finds the re-keyed rows instead of forking them a SECOND time", () => {
    const { path, ids } = seedLegacyDb();
    runMigrations(path);

    const { db, sqlite } = openDb(path);
    try {
      // The clean spelling of a row stored with three overrides. Against a stale key this fell
      // outside the tier-3 length band entirely and created a duplicate; it must now match.
      const player = resolvePlayer(db, { name: "Anna Versteeg" });
      expect(player.kind).toBe("matched");
      if (player.kind === "matched") expect(player.row.id).toBe(ids.player);

      const team = resolveTeam(db, { name: "Springfield A" });
      expect(team.kind).toBe("matched");
      if (team.kind === "matched") expect(team.row.id).toBe(ids.team);

      const fullWidth = resolvePlayer(db, { name: "Nova Norbury" });
      expect(fullWidth.kind).toBe("matched");

      // No row was added by any of the three lookups.
      expect(db.select().from(players).all()).toHaveLength(3);
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("is idempotent — re-running migrations changes nothing", () => {
    const { path } = seedLegacyDb();
    runMigrations(path);

    const { db: firstDb, sqlite: firstSqlite } = openDb(path);
    const afterFirst = firstDb.select().from(players).all().map((r) => r.nameKey);
    firstSqlite.close();

    runMigrations(path);
    runMigrations(path);

    const { db, sqlite } = openDb(path);
    try {
      expect(db.select().from(players).all().map((r) => r.nameKey)).toEqual(afterFirst);
      expect(db.select().from(players).all()).toHaveLength(3);
    } finally {
      sqlite.close();
    }
  });

  it("SAD PATH: a crash between the UPDATE and the backfill self-heals on the next migrate", () => {
    // Migration 0010 NULLs the keys and `backfillNameKeys` re-derives them, which are two steps. If
    // the process dies between them the DB is left with NULL keys — and 0010 will NOT re-run, since
    // the journal already records it. The recovery therefore rests entirely on `backfillNameKeys`
    // running unconditionally on every `runMigrations`, so that is what this pins.
    //
    // It also confirms the window fails CLOSED rather than open: the probe refuses on a NULL key
    // instead of resolving against it, so the interrupted state cannot quietly create duplicates.
    const { path } = seedLegacyDb();
    runMigrations(path);

    const crashed = new Database(path);
    crashed.prepare("UPDATE players SET name_key = NULL").run();
    crashed.close();

    const { db: brokenDb, sqlite: brokenSqlite } = openDb(path);
    try {
      expect(() => resolvePlayer(brokenDb, { name: "Anna Versteeg" })).toThrow(NameKeyNotBackfilledError);
    } finally {
      brokenSqlite.close();
    }

    runMigrations(path);

    const { db, sqlite } = openDb(path);
    try {
      for (const row of db.select().from(players).all()) {
        expect(row.nameKey).toBe(nameKey(row.canonicalName));
      }
      expect(resolvePlayer(db, { name: "Anna Versteeg" }).kind).toBe("matched");
    } finally {
      sqlite.close();
    }
  });
});
