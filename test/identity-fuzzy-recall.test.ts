// Issue #32, Testing Strategy suite C — the load-bearing new test. Tier 3 of the identity ladder
// narrows to a length-banded candidate set BEFORE running Levenshtein, on the claim that the band
// is a NECESSARY condition for distance <= FUZZY_MAX_DISTANCE (each edit changes length by at most
// 1), so it can never drop a true candidate. This suite is what makes "recall provably unchanged" a
// CHECKED claim rather than an argument: every banded result is asserted to equal exactly what an
// unabridged brute-force scan over the whole corpus finds — not merely spot-checked examples.
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { editDistance, FUZZY_MAX_DISTANCE, nameKey, nameKeyLength } from "../src/db/name-key.js";
import { players } from "../src/db/schema.js";
import { findPlayerByName, resolvePlayer } from "../src/ingest/identity.js";
import { buildNamePool } from "./helpers/players.js";
import { useTnDbPath } from "./helpers/tn-db.js";

/** The reference implementation: no length band, no index — every candidate in `corpus` checked
 * against `probe` by the exact same `editDistance` the production code uses. */
function bruteForceFuzzyMatches(corpus: string[], probe: string): string[] {
  return corpus
    .filter((name) => {
      const distance = editDistance(name, probe);
      return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
    })
    .sort();
}

function seedCorpus(db: ReturnType<typeof openDb>["db"], corpus: string[]): void {
  db.insert(players)
    .values(corpus.map((name) => ({ canonicalName: name, nameKey: nameKey(name) })))
    .run();
}

describe("identity fuzzy recall — banded tier-3 matches brute force exactly", () => {
  useTnDbPath();

  it("EQUIVALENCE: every probe's banded candidate set equals the brute-force candidate set, over a ~70-name corpus", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const corpus = buildNamePool();
      seedCorpus(db, corpus);

      // One-character-appended mutation of every corpus name (guaranteed distance 1, never an
      // exact match), plus a few probes chosen for the extremes the band handles differently: a
      // short probe (where the band is proportionally widest) and a long probe that matches
      // nothing closely at all (exercises "banded set is empty, and so is brute force's").
      const probes = [
        ...corpus.map((name) => `${name}x`),
        "Zq",
        "Élx",
        "A Very Long Probe Name That Matches Nothing In The Corpus At All Closely",
      ];

      for (const probe of probes) {
        // Guard the fixture: every probe here is constructed to miss the exact tier, so a banded
        // "ambiguous" result and a brute-force scan are comparing the same tier. If this ever
        // fails, the probe list (not the production code) needs a look.
        expect(corpus.some((name) => nameKey(name) === nameKey(probe))).toBe(false);

        const banded = findPlayerByName(db, probe);
        const bandedNames = banded.kind === "ambiguous" ? banded.candidates.map((p) => p.canonicalName).sort() : [];
        expect(bandedNames).toEqual(bruteForceFuzzyMatches(corpus, probe));
      }
    } finally {
      sqlite.close();
    }
  });

  it("BAND BOUNDARY: a candidate exactly 2 characters longer (edit distance exactly 2) is INSIDE the band and returned", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const base = "Bartholomew";
      const plusTwo = "Bartholomewxy"; // +2 length via two appended characters => edit distance 2
      expect(plusTwo.length - base.length).toBe(2);
      expect(editDistance(base, plusTwo)).toBe(FUZZY_MAX_DISTANCE);

      seedCorpus(db, [plusTwo]);
      const result = findPlayerByName(db, base);

      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.candidates.map((p) => p.canonicalName)).toEqual([plusTwo]);
      }
    } finally {
      sqlite.close();
    }
  });

  it("BAND BOUNDARY: a candidate exactly 3 characters longer (edit distance exactly 3) is OUTSIDE the band and excluded — brute force agrees, since a length-3 gap forces distance >= 3", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const base = "Bartholomew";
      const plusThree = "Bartholomewxyz"; // +3 length => edit distance 3, one past the radius
      expect(plusThree.length - base.length).toBe(3);
      expect(editDistance(base, plusThree)).toBe(FUZZY_MAX_DISTANCE + 1);

      seedCorpus(db, [plusThree]);
      const result = findPlayerByName(db, base);

      // Both the band (length diff 3 > FUZZY_MAX_DISTANCE 2) AND the real Levenshtein distance (3
      // > 2) exclude this candidate — the band did not drop a true match, there simply isn't one.
      expect(result.kind).toBe("not-found");
      expect(bruteForceFuzzyMatches([plusThree], base)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  // Regression, found by the self-review adversarial pass on PR #40 and reproduced before it was
  // fixed. The band's target length was measured with JS's `.length` (UTF-16 code units) while the
  // stored `name_key_length` it is compared against is SQLite's `length()` (code points). The two
  // agree for every BMP name — i.e. for the whole rest of this suite — and diverge by one per
  // astral character, so a name carrying enough of them shifted the band past its own true
  // candidates. The visible symptom was the worst one available: `not-found` where brute force says
  // `ambiguous`, which makes `resolvePlayer` create a second row for a player already on file.
  it("ASTRAL-PLANE UNITS: a true fuzzy candidate whose name is outside the BMP is still found — the band is measured in code points, not UTF-16 units", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // CJK Extension B, chosen because NFKC leaves it alone. The original fixture here was
      // MATHEMATICAL DOUBLE-STRUCK (`𝕁𝕠𝕙`), which NFKC decomposes to ASCII `joh` — so when #62 moved
      // `nameKey` from NFC to NFKC this test's subject stopped being an astral name at all. The
      // premise guard below is what caught that; see test/helpers/players.ts for the same fix
      // applied to the shared corpus.
      const stored = "𠀀𠀁𠀂"; // 3 code points, 6 UTF-16 units
      const probe = "𠀀𠀁𠀂n"; // 4 code points, 7 UTF-16 units — a genuine distance-1 near-miss

      // Guard the premise: if these ever stop disagreeing, this test is no longer exercising the
      // defect it was written for and must not keep passing as if it were.
      expect(nameKey(stored).length).not.toBe(nameKeyLength(nameKey(stored)));
      expect(editDistance(stored, probe)).toBe(1);

      seedCorpus(db, [stored]);

      const banded = findPlayerByName(db, probe);
      expect(banded.kind).toBe("ambiguous");
      const bandedNames = banded.kind === "ambiguous" ? banded.candidates.map((p) => p.canonicalName).sort() : [];
      expect(bandedNames).toEqual(bruteForceFuzzyMatches([stored], probe));

      // The consequence that makes this a correctness bug rather than a performance one: a dropped
      // candidate silently becomes a duplicate player.
      const before = db.select().from(players).all().length;
      expect(resolvePlayer(db, { name: probe }).kind).toBe("ambiguous");
      expect(db.select().from(players).all()).toHaveLength(before);
    } finally {
      sqlite.close();
    }
  });

  it("SHORT-NAME EDGE: 2-3 character names (where a length band is proportionally widest) still match exactly what brute force finds", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const shortCorpus = ["Al", "Bo", "Cy", "Ann", "Ben", "Coe"];
      seedCorpus(db, shortCorpus);

      for (const probe of ["Al", "An", "Bx", "Zz", "Any"]) {
        const exactMatch = shortCorpus.find((name) => nameKey(name) === nameKey(probe));
        const banded = findPlayerByName(db, probe);

        if (exactMatch !== undefined) {
          expect(banded.kind).toBe("found");
          if (banded.kind === "found") expect(banded.row.canonicalName).toBe(exactMatch);
          continue;
        }

        const bandedNames = banded.kind === "ambiguous" ? banded.candidates.map((p) => p.canonicalName).sort() : [];
        expect(bandedNames).toEqual(bruteForceFuzzyMatches(shortCorpus, probe));
      }
    } finally {
      sqlite.close();
    }
  });
});
