import { describe, expect, it } from "vitest";
import { editDistance, FUZZY_MAX_DISTANCE, nameKey, nameKeyLength, namesEqual } from "../src/db/name-key.js";

// Category-Cf (format) characters, written as escapes and never as literal bytes. Two reasons, both
// load-bearing: a literal would be invisible in this source (the very property under test), and a
// literal NUL-adjacent control character can flip a file's binary classification so that grep drops
// it from recursive searches entirely — the trap `src/ingest/upsert.ts` already sets for this repo.
const RLO = "\u202E"; // RIGHT-TO-LEFT OVERRIDE — the bidi spoof this issue is named for
const ZWSP = "\u200B"; // ZERO WIDTH SPACE
const ZWNJ = "\u200C"; // ZERO WIDTH NON-JOINER
const ZWJ = "\u200D"; // ZERO WIDTH JOINER
const SHY = "\u00AD"; // SOFT HYPHEN
const BOM = "\uFEFF"; // ZERO WIDTH NO-BREAK SPACE / BOM

// Category-Cc (control) and the variation selectors — the adjacent invisible classes. These are NOT
// Cf, so the first pass at #62 left every one of them forking an identity exactly as Cf had.
const NUL = "\u0000";
const ESC = "\u001B";
const DEL = "\u007F";
const C1 = "\u0090"; // DEVICE CONTROL STRING — a C1 control, invisible
const VS1 = "\uFE00"; // VARIATION SELECTOR-1

// Kept, deliberately: these are Cc but carry `White_Space`, so they RENDER as a space or a break.
const TAB = "\u0009";
const NEL = "\u0085"; // NEXT LINE — a C1 control, but White_Space=Yes

// Default-ignorable characters that NO general category above reaches — the round-1 reviewer finding.
// U+034F is `Mn`, the Hangul fillers are `Lo`; `\p{Default_Ignorable_Code_Point}` is the property that
// actually means "render this as nothing", and it reaches all of them without reaching one real letter.
const CGJ = "\u034F"; // COMBINING GRAPHEME JOINER
const HANGUL_FILLER = "\u3164";
const CHOSEONG_FILLER = "\u115F";
const WORD_JOINER = "\u2060";

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

  it("strips the ADJACENT invisible classes too — Cc and variation selectors, not just Cf (#62)", () => {
    // Found by the adversarial pass's permanent lens ("what class is not on this list?") after the
    // Cf-only fold was already green: nine other invisible-character classes forked an identity in
    // exactly the same way, because `\p{Cf}` names one category and the DEFECT is "a character a
    // human cannot see". A control character is every bit as attacker-controllable as a bidi
    // override and every bit as invisible on the page.
    for (const invisible of [NUL, ESC, DEL, C1, VS1]) {
      expect(nameKey("Vers" + invisible + "teeg")).toBe(nameKey("Versteeg"));
      expect(nameKey("V" + invisible + "e" + invisible + "r" + invisible + "steeg")).toBe(nameKey("Versteeg"));
    }
  });

  it("strips DEFAULT-IGNORABLE characters that no general category reaches (Codex review, #62)", () => {
    // Round-1 reviewer finding, reproduced against a live DB before being accepted. U+034F COMBINING
    // GRAPHEME JOINER is category `Mn` and NFKC-stable, so neither Cc, Cf nor Variation_Selector
    // reaches it — and three of them pushed the key length past the ±FUZZY_MAX_DISTANCE band, which
    // is the silent-duplicate branch all over again. The same hole covered U+3164 HANGUL FILLER,
    // which an earlier revision of this PR had NAMED as an accepted residual on the reasoning that
    // no derived class could reach a category-`Lo` character without reaching every real letter.
    // That reasoning was wrong: `Default_Ignorable_Code_Point` reaches both, and reaches nothing
    // visible.
    for (const invisible of [CGJ, WORD_JOINER]) {
      expect(nameKey("Vers" + invisible + "teeg")).toBe(nameKey("Versteeg"));
      expect(nameKey("V" + invisible + "e" + invisible + "r" + invisible + "steeg")).toBe(nameKey("Versteeg"));
    }
  });

  it("EXEMPTS every COMPLEX-SCRIPT invisible, not just Hangul — the boundary's final form", () => {
    // The escalation this PR reached, and the HC's ruling on it. Four revisions of the strip class
    // each fixed one script and were then shown too narrow or too wide by the next review pass:
    // Cf alone -> +Cc/VS -> +Default_Ignorable (over-merged Hangul) -> -Hangul (over-merged
    // Mongolian). Five scripts had characters in the class.
    //
    // The premise was wrong, not the list: there is no property equal to "safe to delete from a
    // name", because INVISIBILITY IS CONTEXTUAL. So the guard now asks a different question — does
    // this character BELONG to a complex script? — and strips only invisibles whose own script is
    // Common, Inherited or Latin. That eliminates the whole over-merge class instead of subtracting
    // one script per review round.
    for (const [a, b] of [
      ["ᠬᠠᠨᠠ", "ᠬᠠᠨ᠎ᠠ"], // Mongolian VOWEL SEPARATOR: a lexical break
      ["ᠭᠠᠯ", "ᠭ᠋ᠠᠯ"], // Mongolian FVS1: selects a required glyph form
      ["ᄀᅠ나", "ᄀ나"], // Hangul filler: completes a syllable block
      ["a឴b", "ab"], // Khmer INHERENT AQ
      ["a𑂽b", "ab"], // Kaithi NUMBER SIGN
      ["a𓐰b", "ab"], // Egyptian VERTICAL JOINER
    ]) {
      expect(namesEqual(a!, b!)).toBe(false);
    }
  });

  it("ANTI-BYPASS: a complex-script character elsewhere does NOT disable the strip", () => {
    // The reason the script scope is applied PER CHARACTER and not per name. Scoping per name — "if
    // the name touches a complex script, strip nothing" — reads simpler and hands an attacker a
    // one-character bypass: append an invisible Mongolian separator and the bidi override in the
    // rest of the name survives untouched, reopening #62 exactly.
    //
    // Per character, the override is stripped because ITS script is Common, while the Mongolian
    // character is kept because its script is not. Both names keep the separator; only the RLO goes.
    const MVS = "᠎";
    expect(namesEqual("Anna Vers" + RLO + "teeg" + MVS, "Anna Versteeg" + MVS)).toBe(true);
    expect(namesEqual("Anna Vers" + CGJ + "teeg" + MVS, "Anna Versteeg" + MVS)).toBe(true);
    // ...and the Mongolian character is still load-bearing between two names that differ only by it.
    expect(namesEqual("Anna Versteeg" + MVS, "Anna Versteeg")).toBe(false);
  });

  it("EXEMPTS the Hangul fillers — default-ignorable, but NOT context-free (Codex fix-verification)", () => {
    // The correction to the correction, and the reason the exclusion is `\p{Script=Hangul}` rather
    // than a hand-listed set of four code points.
    //
    // U+115F/U+1160/U+3164/U+FFA0 are `Default_Ignorable`, so the first version of the widened class
    // stripped them — and that introduced a silent OVER-merge, which is the direction that matters.
    // A Hangul filler is invisible ON ITS OWN but is a placeholder that completes a syllable block,
    // so deleting it re-groups the surrounding jamo and a Korean renderer shows a different name.
    // Reproduced exactly as the reviewer traced it: `<L,Vf><L,V>` and `<L><L,V>` both folded to
    // `U+1100 U+B098`, so tier-2 silently merged two visibly different names.
    const withFiller = "ᄀᅠ나"; // U+1100 U+1160 U+1102 U+1161 — an isolated jamo, then a syllable
    const withoutFiller = "ᄀ나"; // U+1100 U+1102 U+1161 — renders differently
    expect(namesEqual(withFiller, withoutFiller)).toBe(false);

    // U+3164 therefore forks an identity again, and that is now a NAMED residual with a real reason
    // rather than the wrong one an earlier revision gave for it.
    expect(namesEqual("Vers" + HANGUL_FILLER + "teeg", "Versteeg")).toBe(false);
    expect(namesEqual("Vers" + CHOSEONG_FILLER + "teeg", "Versteeg")).toBe(false);

    // The exemption is script-scoped, not blanket: a real Hangul letter is untouched, and every
    // non-Hangul invisible character is still stripped.
    expect(nameKey("가")).toBe("가");
    expect(nameKey("Vers" + CGJ + "teeg")).toBe(nameKey("Versteeg"));
  });

  it("GUARD COMPLETENESS: nothing a reader CAN see is stripped, checked against the catastrophic cases", () => {
    // Widening a strip class is the move most likely to cause a silent over-merge, so the widening
    // is paired with its own refutation. A combining accent is the case that would be catastrophic
    // and quiet: strip U+0301 and `Élodie` folds to `elodie`, merging it with a genuinely different
    // spelling while every other test in this file still passes.
    for (const visible of ["́", "̀", "é", "A", "ㄱ", "ั", "ִ", "ّ", "一", "\u{1F600}"]) {
      expect(nameKey("a" + visible + "b")).toBe(nameKey("a" + visible + "b"));
      expect(nameKey("a" + visible + "b")).not.toBe("ab");
    }
    // The NFD guarantee at the top of this file survives the widening.
    expect(nameKey("Élodie")).toBe(nameKey("Élodie".normalize("NFD")));
  });

  it("KEEPS the invisible characters that RENDER AS WHITESPACE — the line the strip stops at", () => {
    // The boundary is not "is it a control character", it is "does a reader see nothing". TAB and
    // NEL are Cc but carry `White_Space`, so they render as a space or a break: `Jane<TAB>Doe` reads
    // as two words and `JaneDoe` reads as one, and folding them together would be a FALSE MERGE —
    // the silent direction, forbidden outright by spec § Ingestion. So the guard subtracts
    // `\p{White_Space}` rather than hand-listing exceptions, and this pins the consequence.
    expect(namesEqual("Jane" + TAB + "Doe", "JaneDoe")).toBe(false);
    expect(namesEqual("Jane" + NEL + "Doe", "JaneDoe")).toBe(false);
    // ...and the pre-existing "interior whitespace is not collapsed" rule is untouched by all this.
    expect(namesEqual("Jane   Doe", "Jane Doe")).toBe(false);
  });

  it("GUARD COMPLETENESS: the strip DERIVES from Unicode properties and never enumerates characters", () => {
    // The property algebra is the guard, so it is asserted as an algebra. Two things must hold, and
    // the second is the one that could silently regress #62's own fix:
    //   1. every Cc character that is NOT White_Space folds away;
    //   2. subtracting White_Space removes NOTHING from the Cf class — verified across the whole
    //      code-point space, because if any Cf character were White_Space the subtraction would
    //      quietly reopen the bidi-override hole this file exists to close.
    for (let cp = 0x00; cp <= 0x9f; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!/\p{Cc}/u.test(ch)) continue;
      const shouldSurvive = /\p{White_Space}/u.test(ch);
      expect(nameKey("a" + ch + "b")).toBe(shouldSurvive ? nameKey("a" + ch + "b") : "ab");
      if (!shouldSurvive) expect(nameKey("a" + ch + "b")).toBe("ab");
    }
    const cfWhitespace: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (/\p{Cf}/u.test(ch) && /\p{White_Space}/u.test(ch)) cfWhitespace.push(ch);
    }
    expect(cfWhitespace).toEqual([]);
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
      "Vers" + NUL + "teeg",
      "Vers" + ESC + DEL + C1 + "teeg",
      "Vers" + VS1 + "teeg",
      "Jane" + TAB + "Doe",
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
