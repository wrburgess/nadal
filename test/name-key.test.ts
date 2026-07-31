import { describe, expect, it } from "vitest";
import { editDistance, FUZZY_MAX_DISTANCE, nameKey, namesEqual } from "../src/db/name-key.js";

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

  it("is idempotent for every case above", () => {
    const cases = ["Élodie", "Élodie".normalize("NFD"), "ÉLODIE", "élodie", "  Jane Doe  ", "Jane   Doe"];
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
});

describe("FUZZY_MAX_DISTANCE", () => {
  it("is the near-identical (one- or two-character) typo radius used by the identity ladder", () => {
    expect(FUZZY_MAX_DISTANCE).toBe(2);
  });
});
