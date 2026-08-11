import { describe, expect, it } from "vitest";
import { normalizeGender } from "../src/ingest/normalize-gender.js";

/**
 * Issue #130. `players.gender` holds the source LABEL on all 77 rows that have a gender at all —
 * the literal string `Competition Category: MALE`, written raw by `src/ingest/archived.ts`. This
 * is the ONE meeting point spec's "ingest decision, made once where both sources meet, not twice
 * inside two parsers" (`src/parsers/usta/profile.ts`'s doc comment) describes but never built.
 *
 * Fails closed by design: anything this function does not recognise returns `null` rather than
 * the raw input, so a future label a source starts printing cannot reach the column un-mapped —
 * the exact failure mode #130 is. `contains("MALE")` would pass against the buggy
 * `"Competition Category: MALE"` value and certify nothing; every assertion below is exact-equality
 * on the whole returned string (or `null`).
 */
describe("normalizeGender", () => {
  it.each([
    ["MALE", "Male"],
    ["FEMALE", "Female"],
    ["Male", "Male"],
    ["female", "Female"],
    ["Competition Category: MALE", "Male"],
    ["Competition Category: FEMALE", "Female"],
  ] as const)("normalizes %j to %j", (input, expected) => {
    expect(normalizeGender(input)).toBe(expected);
  });

  it.each([[""], ["   "], [null], ["Mixed"], ["M"], ["F"], ["unknown"]] as const)(
    "fails closed on %j — returns null rather than a raw or partially-mapped value",
    (input) => {
      expect(normalizeGender(input)).toBeNull();
    },
  );

  it("is idempotent — normalizing an already-normalized value returns it unchanged", () => {
    for (const input of ["MALE", "FEMALE", "Male", "female", "Competition Category: MALE", "Mixed", "", null]) {
      const once = normalizeGender(input);
      expect(normalizeGender(once)).toBe(once);
    }
  });
});
