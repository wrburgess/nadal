import { describe, expect, it } from "vitest";
import { WTN_RESCALE, spansWtnScaleBreak, wtnErasIn, wtnScaleEra } from "../src/query/rating-scale.js";

// ISS#172, Deliverable 1. ITF recalculated the World Tennis Number during the week of 2026-08-10.
// Two things are provable and no more: every observation dated 2026-08-05 is pre-recalculation (all
// 133 rows predating the re-pull carry it), and every observation dated 2026-08-19 is post- (the
// value audit re-read all 52 saved pages and confirmed 91 agree / 0 mismatch against the new-scale
// widget). Everything between is genuinely unknown, which is why this is a WINDOW with an
// indeterminate middle rather than a single cutover constant nobody measured.

describe("wtnScaleEra", () => {
  it("classifies the two dates the re-pull actually measured", () => {
    expect(wtnScaleEra("2026-08-05")).toBe("pre-rescale");
    expect(wtnScaleEra("2026-08-19")).toBe("post-rescale");
  });

  it("BOUNDARY: both edges are inclusive, and one day inside either is indeterminate", () => {
    // An off-by-one on either edge silently changes a player's era, so all four are pinned.
    expect(wtnScaleEra(WTN_RESCALE.lastKnownPre)).toBe("pre-rescale");
    expect(wtnScaleEra("2026-08-06")).toBe("indeterminate");
    expect(wtnScaleEra("2026-08-18")).toBe("indeterminate");
    expect(wtnScaleEra(WTN_RESCALE.firstKnownPost)).toBe("post-rescale");
  });

  it("classifies dates well outside the window", () => {
    expect(wtnScaleEra("2024-01-01")).toBe("pre-rescale");
    expect(wtnScaleEra("2027-06-30")).toBe("post-rescale");
  });

  it("INVALID INPUT: anything not a real ISO date is indeterminate, and never throws", () => {
    // `observed_on` is an unconstrained TEXT column, so every one of these is reachable from a
    // hand-edited or partially-migrated row.
    for (const bad of ["", "   ", "not-a-date", "2026-8-5", "20260805", "2026-13-45", "2026-02-30"]) {
      expect(() => wtnScaleEra(bad)).not.toThrow();
      expect(wtnScaleEra(bad)).toBe("indeterminate");
    }
  });

  it("INVALID INPUT: an unpadded date does not sort its way into the wrong era", () => {
    // The trap this pins: "2026-8-5" > "2026-08-19" as a STRING, so a bare comparison would call
    // a pre-rescale number post-rescale.
    expect("2026-8-5" > "2026-08-19").toBe(true);
    expect(wtnScaleEra("2026-8-5")).toBe("indeterminate");
  });
});

describe("wtnErasIn", () => {
  it("collapses a set to the eras present", () => {
    expect([...wtnErasIn(["2026-08-19", "2026-08-19"])]).toEqual(["post-rescale"]);
    expect([...wtnErasIn(["2026-08-05", "2026-08-19"]).values()].sort()).toEqual([
      "post-rescale",
      "pre-rescale",
    ]);
  });

  it("DUPLICATES: a repeated date does not become a second era", () => {
    // `rating_obs_unique` makes a same player/source/date duplicate unreachable from a real pull,
    // but these functions are pure and a hand-built input can produce one.
    expect(wtnErasIn(["2026-08-19", "2026-08-19", "2026-08-19"]).size).toBe(1);
  });

  it("is empty for an empty input rather than throwing", () => {
    expect(wtnErasIn([]).size).toBe(0);
  });
});

describe("spansWtnScaleBreak", () => {
  it("HAPPY PATH: one era does not span", () => {
    expect(spansWtnScaleBreak(["2026-08-19", "2026-08-19", "2026-08-19"])).toBe(false);
    expect(spansWtnScaleBreak(["2026-08-05", "2026-08-05"])).toBe(false);
  });

  it("PLANTED DEFECT: a roster mixing the two measured dates spans", () => {
    expect(spansWtnScaleBreak(["2026-08-19", "2026-08-05", "2026-08-19"])).toBe(true);
  });

  it("PLANTED DEFECT: one date inside the window spans, even beside a uniform cohort", () => {
    expect(spansWtnScaleBreak(["2026-08-19", "2026-08-12"])).toBe(true);
  });

  it("PLANTED DEFECT: a blank observed_on spans", () => {
    expect(spansWtnScaleBreak(["2026-08-19", ""])).toBe(true);
  });

  it("PLANTED DEFECT: an ALL-indeterminate set spans — absence of evidence is not comparability", () => {
    // The case most likely to be "simplified" away later: every member is in the unknown window, so
    // they are not provably on one scale, and the guard must fail closed rather than pass because
    // it found only one era.
    expect(spansWtnScaleBreak(["2026-08-12", "2026-08-13"])).toBe(true);
    expect(wtnErasIn(["2026-08-12", "2026-08-13"]).size).toBe(1); // one era — and still spanning
  });

  it("an empty set does not span: there is nothing to be incomparable with", () => {
    expect(spansWtnScaleBreak([])).toBe(false);
  });

  it("REGRESSION: the verdict comes from the DECLARED break, not from something incidental", () => {
    // Revert-the-guard check. If the window were widened so both measured dates fall on one side,
    // the mixed roster must STOP spanning. Without this, "mixed roster spans" could pass for a
    // reason unrelated to the declared break — `docs/findings.md` records three false greens in one
    // pull request caught exactly this way.
    const mixed = ["2026-08-05", "2026-08-19"];
    expect(spansWtnScaleBreak(mixed)).toBe(true);
    expect(spansWtnScaleBreak(mixed, { lastKnownPre: "2026-08-19", firstKnownPost: "2026-08-20" })).toBe(false);
  });
});
