import { describe, expect, it } from "vitest";
import { editDistance, FUZZY_MAX_DISTANCE, nameKey, nameKeyLength, namesEqual } from "../src/db/name-key.js";

// Category-Cf (format) characters, written as escapes and never as literal bytes. Two reasons, both
// load-bearing: a literal would be invisible in this source (the very property under test), and a
// literal NUL-adjacent control character can flip a file's binary classification so that grep drops
// it from recursive searches entirely — the trap `src/ingest/upsert.ts` already sets for this repo.
const RLO = "‮"; // RIGHT-TO-LEFT OVERRIDE — the bidi spoof this issue is named for
const ZWSP = "​"; // ZERO WIDTH SPACE
const ZWNJ = "‌"; // ZERO WIDTH NON-JOINER
const ZWJ = "‍"; // ZERO WIDTH JOINER
const SHY = "­"; // SOFT HYPHEN
const BOM = "﻿"; // ZERO WIDTH NO-BREAK SPACE / BOM

describe("nameKey", () => {
  it("folds a composed accented name and its NFD-decomposed spelling to the same key", () => {
    const composed = "Élodie"; // U+00C9 (precomposed)
    const decomposed = composed.normalize("NFD"); // "E" + combining acute accent (U+0301)
    expect(composed).not.toBe(decomposed); // sanity: the two source strings really do differ
    expect(nameKey(composed)).toBe(nameKey(decomposed));
  });

  it("case-folds beyond ASCII, where SQLite's own lower() fails", () => {
    // `select lower('ÉLODIE')` in SQLite returns 'Élodie', not 'élodie' — this is the defect
    // the JS fold exists to avoid reproducing.
    expect(nameKey("ÉLODIE")).toBe(nameKey("élodie"));
  });

  it("trims leading and trailing whitespace but leaves interior whitespace alone", () => {
    expect(nameKey("  Jane Doe  ")).toBe("jane doe");
    // Interior whitespace is NOT collapsed — pinned down explicitly so a future change to this
    // behavior is a deliberate edit, not an accident.
    expect(nameKey("Jane   Doe")).toBe("jane   doe");
  });

  it("strips category-Cf format characters, so an invisible override cannot fork an identity (#62)", () => {
    // The headline case. `Versteeg` and `Versteeg<RLO>` render identically to a human but produced
    // two different keys, hence two different identities, hence a silent duplicate row.
    expect(nameKey("Vers" + RLO + "teeg")).toBe(nameKey("Versteeg"));
    expect(nameKey("Versteeg" + RLO)).toBe(nameKey("Versteeg"));
  });

  it("strips MULTIPLE format characters — the case that fell past the fuzzy tier entirely", () => {
    // Measured before the fix: one or two format characters left an editDistance of 1-2, inside
    // FUZZY_MAX_DISTANCE, so tier 3 caught them and returned `ambiguous` (wrong, but loud). THREE
    // pushed the distance to 3, past the band, so the ladder created a second row and said nothing.
    // A hostile page controls that count for free, so the silent branch is the reachable one.
    expect(nameKey("V" + RLO + "e" + RLO + "r" + RLO + "steeg")).toBe(nameKey("Versteeg"));
  });

  it("strips every Cf member the scraped-name path can plausibly carry, not just the bidi override", () => {
    // Derived from the Unicode general category, not enumerated by hand — this asserts the property
    // holds for members the implementation never names.
    for (const invisible of [RLO, ZWSP, ZWNJ, ZWJ, SHY, BOM]) {
      expect(nameKey("Nova" + invisible + "Norbury")).toBe(nameKey("NovaNorbury"));
    }
  });

  it("BOUNDARY: the strip runs BEFORE the trim, so a leading format character cannot block it", () => {
    // Order is load-bearing and the failure is silent. Trim-then-strip leaves " name" (the RLO holds
    // the leading space against the trim, and stripping it afterwards is too late), which is a THIRD
    // key for the same human-visible name — the same defect class the fix is closing.
    expect(nameKey(" " + RLO + " Name ")).toBe("name");
    expect(nameKey(RLO + "  Jane Doe  " + RLO)).toBe("jane doe");
  });

  it("BOUNDARY: a name of nothing but format characters folds to the empty string, not to NULL", () => {
    // Same invariant as the whitespace-only case below: "" is a legitimate key and NULL means "not
    // yet backfilled" (backfillNameKeys / the fail-closed probe in src/ingest/identity.ts). A fold
    // that gained a new route to a null-ish value would make the probe's guarantee untrue.
    expect(nameKey(RLO + ZWSP + BOM)).toBe("");
    expect(nameKey(RLO + "   " + ZWSP)).toBe("");
    expect(nameKey(RLO + ZWSP + BOM)).not.toBeNull();
  });

  it("folds Unicode COMPATIBILITY variants too — NFKC, not NFC (docs/findings.md:319)", () => {
    // The sibling defect in this same one-line function, found during #18 and logged rather than
    // fixed: NFC composes combining marks but does not fold full-width forms, so a vision model
    // transcribing a scorecard photo as full-width produced a second identity for one person.
    expect(nameKey("Ｎｏｒｂｕｒｙ")).toBe(nameKey("Norbury"));
    expect(nameKey("ﬁnnegan")).toBe(nameKey("finnegan")); // U+FB01 LATIN SMALL LIGATURE FI
    expect(nameKey("Ⅳ")).toBe(nameKey("IV")); // U+2163 ROMAN NUMERAL FOUR
  });

  it("NFKC does NOT subsume the Cf strip — both halves of the fold are load-bearing", () => {
    // Checked rather than assumed. If NFKC alone removed format characters, the strip would be dead
    // code and this test would be the thing that told us.
    expect(("Vers" + RLO + "teeg").normalize("NFKC")).not.toBe("Versteeg");
    expect(nameKey("Vers" + RLO + "teeg")).toBe("versteeg");
  });

  it("is NOT over-greedy: distinct names stay distinct under the wider fold", () => {
    // The dangerous direction. A fold that splits one person is loud — the ladder reports
    // `ambiguous`. A fold that MERGES two people is silent, and spec § Ingestion forbids it
    // outright. Nothing else in this suite would catch an over-merge, so it is asserted directly.
    expect(namesEqual("Ｏ’Brien", "O'Brien")).toBe(false); // curly vs straight apostrophe: a different class, deliberately not folded
    expect(namesEqual("Anne-Marie", "Anne" + SHY + "Marie")).toBe(false); // real hyphen vs soft hyphen
    expect(namesEqual("Alex Stone", "Alex Stove")).toBe(false);
    expect(namesEqual("Nova Norbury", "Nova Norbery")).toBe(false);
    // HOMOGLYPHS stay distinct — asserted because the module doc claims it, and a doc claim the
    // tests do not enforce is the failure shape this repo has logged repeatedly. Folding these
    // would need a Unicode confusables skeleton, which is a materially different false-merge risk
    // profile and deliberately out of scope for #62.
    expect(namesEqual("Аnna Versteeg", "Anna Versteeg")).toBe(false); // Cyrillic А (U+0410) vs Latin A
    expect(namesEqual("Οscar Wilde", "Oscar Wilde")).toBe(false); // Greek Ο (U+039F) vs Latin O
  });

  it("is idempotent for every case above", () => {
    const cases = [
      "Élodie",
      "Élodie".normalize("NFD"),
      "ÉLODIE",
      "élodie",
      "  Jane Doe  ",
      "Jane   Doe",
      "Vers" + RLO + "teeg",
      "V" + RLO + "e" + RLO + "r" + RLO + "steeg",
      " " + RLO + " Name ",
      RLO + ZWSP + BOM,
      "Ｎｏｒｂｕｒｙ",
      "ﬁnnegan",
      "Ⅳ",
    ];
    for (const value of cases) {
      expect(nameKey(nameKey(value))).toBe(nameKey(value));
    }
  });

  it("BOUNDARY: an empty or whitespace-only name produces the empty string, distinct from SQL NULL", () => {
    // NULL means "not yet backfilled" (src/db/client.ts's backfillNameKeys). No non-null input —
    // including one that folds to nothing — may ever produce that same sentinel by another route,
    // so "" (a real, non-null value) is asserted here rather than left implicit.
    expect(nameKey("")).toBe("");
    expect(nameKey("   ")).toBe("");
    expect(nameKey("")).not.toBeNull();
    expect(nameKey("   ")).not.toBeNull();
  });

  it("namesEqual agrees with nameKey equality on every case above", () => {
    expect(namesEqual("Élodie", "Élodie".normalize("NFD"))).toBe(true);
    expect(namesEqual("ÉLODIE", "élodie")).toBe(true);
    expect(namesEqual("  Jane Doe  ", "Jane Doe")).toBe(true);
    expect(namesEqual("Jane   Doe", "Jane Doe")).toBe(false);
    expect(namesEqual("", "   ")).toBe(true);
    expect(namesEqual("Alex Stone", "Alex Stove")).toBe(false);
    expect(namesEqual("Vers" + RLO + "teeg", "Versteeg")).toBe(true);
    expect(namesEqual("Ｎｏｒｂｕｒｙ", "Norbury")).toBe(true);
    expect(namesEqual(RLO + ZWSP, "")).toBe(true);
  });
});

describe("editDistance", () => {
  it("is 0 for names equal under nameKey, even across composed/decomposed spelling", () => {
    expect(editDistance("Élodie", "Élodie".normalize("NFD"))).toBe(0);
  });

  it("counts a single substitution as distance 1", () => {
    expect(editDistance("Alex Stone", "Alex Stone")).toBe(0);
    expect(editDistance("Alex Stone", "Alex Stona")).toBe(1);
  });

  it("is 0 across format characters, so tier 3 no longer burns its budget on invisible ones (#62)", () => {
    // Before the fix these measured 1 and 3 respectively — the first inside FUZZY_MAX_DISTANCE (a
    // spurious `ambiguous` on a name already on file) and the second outside it (a silent duplicate).
    // Both are now 0, which is what "the same name" has to mean for the ladder to work at all.
    expect(editDistance("Versteeg", "Vers" + RLO + "teeg")).toBe(0);
    expect(editDistance("Versteeg", "V" + RLO + "e" + RLO + "r" + RLO + "steeg")).toBe(0);
    // The fuzzy radius still does its real job for a genuine typo (measured, not assumed).
    expect(editDistance("Anna Versteeg", "Anna Versteig")).toBe(1);
    expect(editDistance("Jhon Smyth", "John Smith")).toBe(3); // outside the radius — two transpositions plus a substitution
  });
});

describe("FUZZY_MAX_DISTANCE", () => {
  it("is the near-identical (one- or two-character) typo radius used by the identity ladder", () => {
    expect(FUZZY_MAX_DISTANCE).toBe(2);
  });
});

describe("nameKeyLength", () => {
  // The unit this returns has to be the unit SQLite's `length()` counts, because the tier-3 band
  // compares one against the other. For every BMP name the two are identical, which is exactly why
  // a divergence here is easy to ship and hard to see.
  it("counts code points, not UTF-16 code units, so it matches SQLite's length()", () => {
    expect(nameKeyLength("john")).toBe(4);
    expect(nameKeyLength("élodie")).toBe(6);
    expect(nameKeyLength("𠀀𠀁𠀂𠀃")).toBe(4); // SQLite length() == 4; JS .length == 8
  });

  it("diverges from JS .length by exactly one per astral character", () => {
    expect("𠀀𠀁𠀂𠀃".length - nameKeyLength("𠀀𠀁𠀂𠀃")).toBe(4);
    expect("john".length - nameKeyLength("john")).toBe(0);
  });

  it("NFKC decides WHICH astral names still reach the band as astral (#62)", () => {
    // Not a curiosity — it invalidated this suite's own fixtures. `nameKeyLength` is unfolded and
    // counts whatever it is handed, but the band hands it `nameKey(name)`, and NFKC
    // compatibility-decomposes MATHEMATICAL DOUBLE-STRUCK letters all the way down to ASCII. So a
    // name spelled `𝕁𝕠𝕙𝕟` is a BMP name by the time any length is compared, while a CJK Extension B
    // name is not. Pinned here because the distinction is invisible at the call site and silently
    // decides whether an astral-plane fixture tests anything at all.
    expect(nameKeyLength(nameKey("𝕁𝕠𝕙𝕟"))).toBe(4);
    expect(nameKey("𝕁𝕠𝕙𝕟")).toBe("john"); // folded to BMP — the units no longer diverge
    expect(nameKey("𝕁𝕠𝕙𝕟").length).toBe(nameKeyLength(nameKey("𝕁𝕠𝕙𝕟")));

    expect(nameKey("𠀀𠀁𠀂𠀃")).toBe("𠀀𠀁𠀂𠀃"); // NFKC-stable — still astral, units still diverge
    expect(nameKey("𠀀𠀁𠀂𠀃").length).not.toBe(nameKeyLength(nameKey("𠀀𠀁𠀂𠀃")));
  });

  it("agrees with JS .length for every name in the BMP", () => {
    for (const name of ["Nova Norbury", "Élodie Ünwin", "Al", ""]) {
      expect(nameKeyLength(name)).toBe(name.length);
    }
  });

  it("measures the STRIPPED key, so the tier-3 band cannot be shifted by invisible characters (#62)", () => {
    // The band is `nameKeyLength(target) ± FUZZY_MAX_DISTANCE` compared against the stored
    // `length(name_key)`. Both sides now count the same stripped key, so padding a name with
    // invisible characters can no longer slide it out of its own candidates' band.
    expect(nameKeyLength(nameKey("Vers" + RLO + "teeg"))).toBe(nameKeyLength(nameKey("Versteeg")));
    expect(nameKeyLength(nameKey("V" + RLO + ZWSP + RLO + "ersteeg"))).toBe(8);
  });
});
