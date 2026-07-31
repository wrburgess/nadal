import { describe, expect, it } from "vitest";
import { sixMonthsAgo } from "../src/cli/window.js";

describe("sixMonthsAgo", () => {
  it("subtracts six calendar months in UTC", () => {
    expect(sixMonthsAgo(new Date("2026-07-30T12:00:00Z"))).toBe("2026-01-30");
  });

  it("rolls over a year boundary", () => {
    expect(sixMonthsAgo(new Date("2026-03-01T00:00:00Z"))).toBe("2025-09-01");
  });

  it("clamps a month-end date the way JS Date normalization does (Aug 31 - 6mo -> Mar 3, not Mar 31)", () => {
    // Feb 2026 has 28 days, so Date.UTC(2026, 1, 31) overflows into March — documenting the exact
    // behavior rather than asserting a value that would silently start passing/failing on a
    // different implementation of the subtraction.
    expect(sixMonthsAgo(new Date("2026-08-31T00:00:00Z"))).toBe("2026-03-03");
  });

  it("defaults to the current time when no argument is given", () => {
    const result = sixMonthsAgo();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
