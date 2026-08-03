import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { players, teams } from "../src/db/schema.js";
import { resolvePlayer, resolveTeam } from "../src/ingest/identity.js";
import { useTnDbPath } from "./helpers/tn-db.js";

// See test/name-key.test.ts for why these are escapes and never literal bytes.
const RLO = "‮"; // RIGHT-TO-LEFT OVERRIDE
const ZWSP = "​"; // ZERO WIDTH SPACE

/**
 * Issue #62 as a caller meets it, rather than as the fold sees it.
 *
 * `test/name-key.test.ts` pins the fold's own behavior. This file exists because the fold is not the
 * thing that was broken for a user — the IDENTITY LADDER was, and it fails in two different ways
 * depending on a count the fold never sees. Measured against a real migrated database before the
 * fix, for both `resolvePlayer` and `resolveTeam`:
 *
 *   0 format characters -> `matched`    (tier-2 exact key hit)
 *   1-2                 -> `ambiguous`  (tier 2 misses; tier 3's editDistance of 1-2 is inside
 *                                        FUZZY_MAX_DISTANCE, so the near-miss tier catches it —
 *                                        wrong, but loud, and it halts a pull to ask the HC about a
 *                                        player already on file)
 *   3 or more           -> `created`    (editDistance 3 > 2, so it falls past EVERY tier and the
 *                                        ladder writes a second row, silently — the issue's headline)
 *
 * A hostile page or a broken upstream template picks that count for free, so the silent branch is
 * the reachable one, not the unlikely one. Both rows are asserted here: the row COUNT is what makes
 * these real regressions rather than kind-checks, since a fold that returned the right `kind` while
 * still inserting would pass a kind-only assertion.
 */
describe("identity ladder — category-Cf format characters in a scraped name (#62)", () => {
  useTnDbPath();

  function freshDb() {
    runMigrations();
    return openDb();
  }

  describe("resolvePlayer", () => {
    it("ONE format character resolves to the player already on file (was: a spurious `ambiguous`)", () => {
      const { db, sqlite } = freshDb();
      try {
        const created = resolvePlayer(db, { name: "Anna Versteeg" });
        expect(created.kind).toBe("created");

        const again = resolvePlayer(db, { name: "Anna Vers" + RLO + "teeg" });
        expect(again.kind).toBe("matched");
        if (again.kind === "matched" && created.kind === "created") {
          expect(again.row.id).toBe(created.row.id);
        }
        expect(db.select().from(players).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });

    it("THREE format characters resolve to the same player — the silent duplicate is gone", () => {
      const { db, sqlite } = freshDb();
      try {
        const created = resolvePlayer(db, { name: "Anna Versteeg" });
        expect(created.kind).toBe("created");

        const forked = resolvePlayer(db, { name: "Anna V" + RLO + "e" + RLO + "r" + RLO + "steeg" });
        expect(forked.kind).toBe("matched");
        // The assertion that actually pins the defect: one person, one row.
        expect(db.select().from(players).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });

    it("resolves through the ALIAS table too, so tier 1 sees the folded spelling", () => {
      const { db, sqlite } = freshDb();
      try {
        // resolvePlayer records the creating spelling as an alias, so this exercises the alias key
        // (player_aliases.name_key) rather than players.name_key.
        const created = resolvePlayer(db, { name: "Jerry Martin", ustaUaid: "u-1" });
        expect(created.kind).toBe("created");

        const viaAlias = resolvePlayer(db, { name: "Jerry" + ZWSP + " Mar" + RLO + "tin" });
        expect(viaAlias.kind).toBe("matched");
        expect(db.select().from(players).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });

    it("folds a full-width transcription to the same player (docs/findings.md:319)", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(resolvePlayer(db, { name: "Nova Norbury" }).kind).toBe("created");
        expect(resolvePlayer(db, { name: "Ｎｏｖａ Ｎｏｒｂｕｒｙ" }).kind).toBe("matched");
        expect(db.select().from(players).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });

    it("SAD PATH: a genuinely different name still creates a second row", () => {
      // Without this, every assertion above would also pass if the fold collapsed everything to one
      // key — an over-merge, which spec § Ingestion forbids outright and which is silent.
      const { db, sqlite } = freshDb();
      try {
        expect(resolvePlayer(db, { name: "Anna Versteeg" }).kind).toBe("created");
        expect(resolvePlayer(db, { name: "Brett Halloran" }).kind).toBe("created");
        expect(db.select().from(players).all()).toHaveLength(2);
      } finally {
        sqlite.close();
      }
    });

    it("SAD PATH: the fuzzy tier still reports a real near-miss as ambiguous", () => {
      // The fold must not have made tier 3 unreachable by folding away the distance it measures.
      const { db, sqlite } = freshDb();
      try {
        // A real one-character typo (measured distance 1, inside FUZZY_MAX_DISTANCE), NOT a name
        // differing only by invisible characters — that is the whole point of the pairing.
        expect(resolvePlayer(db, { name: "Anna Versteeg" }).kind).toBe("created");
        expect(resolvePlayer(db, { name: "Anna Versteig" }).kind).toBe("ambiguous");
        expect(db.select().from(players).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });
  });

  describe("resolveTeam", () => {
    it("ONE format character resolves to the team already on file (was: a spurious `ambiguous`)", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(resolveTeam(db, { name: "Springfield A" }).kind).toBe("created");
        expect(resolveTeam(db, { name: "Spring" + RLO + "field A" }).kind).toBe("matched");
        expect(db.select().from(teams).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });

    it("THREE format characters resolve to the same team — the silent duplicate is gone", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(resolveTeam(db, { name: "Springfield A" }).kind).toBe("created");
        const forked = resolveTeam(db, {
          name: "S" + RLO + "p" + RLO + "r" + RLO + "ingfield A",
        });
        expect(forked.kind).toBe("matched");
        expect(db.select().from(teams).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });

    it("SAD PATH: a genuinely different team still creates a second row", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(resolveTeam(db, { name: "Springfield A" }).kind).toBe("created");
        expect(resolveTeam(db, { name: "Clayview Country Club" }).kind).toBe("created");
        expect(db.select().from(teams).all()).toHaveLength(2);
      } finally {
        sqlite.close();
      }
    });
  });
});
