import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { namesEqual } from "../src/db/name-key.js";
import { players, teams } from "../src/db/schema.js";
import { resolvePlayer, resolveTeam } from "../src/ingest/identity.js";
import { useTnDbPath } from "./helpers/tn-db.js";

// Escapes, never literal bytes — and this file is why the rule is written down rather than assumed.
// An earlier draft inlined the control characters directly and they did not survive being written:
// U+0000/U+001B/U+007F/U+0090 arrived as PLAIN SPACES, so the loop below silently asserted something
// about spaces while reading as though it covered control characters. A `\u` escape is ordinary ASCII
// in the file, so it cannot be mangled in transit and cannot flip the file's binary classification
// (which would drop it from every recursive grep — the trap `src/ingest/upsert.ts` sets for this repo).
const RLO = "\u202E"; // RIGHT-TO-LEFT OVERRIDE
const ZWSP = "\u200B"; // ZERO WIDTH SPACE
const NUL = "\u0000";
const ESC = "\u001B";
const DEL = "\u007F";
const C1 = "\u0090"; // DEVICE CONTROL STRING — a C1 control, invisible
const VS1 = "\uFE00"; // VARIATION SELECTOR-1
const CGJ = "\u034F"; // COMBINING GRAPHEME JOINER — Mn, reached only by Default_Ignorable
const HANGUL_FILLER = "\u3164"; // Lo, likewise

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

    it("the ADJACENT invisible classes no longer fork either — Cc and variation selectors", () => {
      // The permanent review lens found these after the Cf-only fold was green: every one of them
      // created a second row against a live DB, exactly as Cf had. Measured the same way — by the
      // row count, not the result kind.
      const { db, sqlite } = freshDb();
      try {
        expect(resolvePlayer(db, { name: "Anna Versteeg" }).kind).toBe("created");
        const invisibles = [NUL, ESC, DEL, C1, VS1];
        for (const ch of invisibles) {
          const probe = "Anna V" + ch + "ers" + ch + "te" + ch + "eg";
          expect(resolvePlayer(db, { name: probe }).kind).toBe("matched");
        }
        expect(db.select().from(players).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });

    it("U+034F COMBINING GRAPHEME JOINER no longer forks — the round-1 reviewer's exact trace", () => {
      // Reproduced before being accepted: this returned `created` with 2 player rows. U+034F is
      // category `Mn` and NFKC-stable, so Cc/Cf/Variation_Selector all miss it, and three of them
      // push the key length 3 past the ±FUZZY_MAX_DISTANCE band — the silent-duplicate branch again.
      const { db, sqlite } = freshDb();
      try {
        expect(resolvePlayer(db, { name: "Anna Versteeg" }).kind).toBe("created");
        expect(resolvePlayer(db, { name: "Anna V" + CGJ + "e" + CGJ + "r" + CGJ + "steeg" }).kind).toBe("matched");
        expect(db.select().from(players).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });

    it("HANGUL FILLER U+3164 no longer forks — the residual an earlier revision wrongly accepted", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(resolvePlayer(db, { name: "Anna Versteeg" }).kind).toBe("created");
        const filled = "Anna V" + HANGUL_FILLER + "e" + HANGUL_FILLER + "r" + HANGUL_FILLER + "steeg";
        expect(resolvePlayer(db, { name: filled }).kind).toBe("matched");
        expect(db.select().from(players).all()).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });

    it("SAD PATH: a name differing by RENDERED whitespace is NOT silently merged", () => {
      // The other side of the same boundary, at the ladder rather than the fold. A TAB renders, so
      // `Anna<TAB>Versteeg` and `AnnaVersteeg` are different names and the fold must not merge them.
      // Without this, the tests above would also pass on a fold that stripped whitespace too.
      //
      // The ladder's answer here is `ambiguous`, not `created`, and that is CORRECT rather than a
      // near miss: tier 2 finds no key match (the fold kept them distinct — the property under
      // test), and tier 3 then reports a genuine distance-1 near-miss for a human to settle. What
      // matters is the pair of outcomes it rules out — a silent merge onto the existing row, and a
      // silent second row — so both are asserted directly.
      const { db, sqlite } = freshDb();
      try {
        expect(resolvePlayer(db, { name: "AnnaVersteeg" }).kind).toBe("created");
        expect(namesEqual("AnnaVersteeg", "Anna\tVersteeg")).toBe(false); // the fold keeps them apart
        expect(resolvePlayer(db, { name: "Anna\tVersteeg" }).kind).toBe("ambiguous"); // asked, not merged
        expect(db.select().from(players).all()).toHaveLength(1); // and nothing was silently written
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

    it("U+034F no longer forks a TEAM either — the reviewer asked for both ladders", () => {
      const { db, sqlite } = freshDb();
      try {
        expect(resolveTeam(db, { name: "Springfield A" }).kind).toBe("created");
        const joined = "S" + CGJ + "p" + CGJ + "r" + CGJ + "ingfield A";
        expect(resolveTeam(db, { name: joined }).kind).toBe("matched");
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
