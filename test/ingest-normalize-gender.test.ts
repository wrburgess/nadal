import { describe, expect, it } from "vitest";
import { genderWrite, normalizeGender } from "../src/ingest/normalize-gender.js";

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

/**
 * The WRITER-side rule, which is the same rule the backfill implements: never downgrade knowledge.
 * `undefined` is what `upsertPlayer` treats as "leave this field alone" — so an unrecognised source
 * value can never enter the column AND can never erase a value already in it.
 *
 * Codex adversarial review round 2 on PR #138 found the gap this closes: round 1's fix taught the
 * backfill to preserve an unmapped value, and the write path would then destroy that same value on
 * the next pull, making the preservation rationale true of one half of the system and false of the
 * other.
 */
describe("genderWrite", () => {
  it.each([
    ["MALE", "Male"],
    ["FEMALE", "Female"],
    ["Male", "Male"],
    ["female", "Female"],
    ["Competition Category: MALE", "Male"],
  ] as const)("maps %j to %j, exactly as normalizeGender does", (input, expected) => {
    expect(genderWrite(input)).toBe(expected);
  });

  it.each([[""], ["   "], [null], [undefined], ["Mixed"], ["M"], ["Non-binary"]] as const)(
    "returns undefined (leave it alone) rather than null (erase it) for %j",
    (input) => {
      // The distinction is the whole point: `upsertPlayer` assigns `gender` only when it is not
      // `undefined`, so `null` here would overwrite whatever the row already held.
      expect(genderWrite(input)).toBeUndefined();
      expect(genderWrite(input)).not.toBeNull();
    },
  );
});
