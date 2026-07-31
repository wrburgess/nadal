import { describe, expect, it } from "vitest";
import {
  formatDataGapsLine,
  formatPartnerFrequency,
  formatRatingTrajectory,
  formatRecord,
  formatSlotTendencies,
} from "../src/cli/format-profile.js";
import type { DataGapsResult, PartnerFrequencyEntry, RatingTrajectoryResult, SlotTendency, WindowedRecordResult } from "../src/query/types.js";

describe("formatRecord", () => {
  it("renders wins-losses, omitting undecided/excludedUndated when both are zero", () => {
    const r: WindowedRecordResult = { wins: 3, losses: 1, undecided: 0, excludedUndated: 0 };
    expect(formatRecord(r)).toBe("3-1");
  });

  it("appends undecided count when present", () => {
    const r: WindowedRecordResult = { wins: 2, losses: 0, undecided: 1, excludedUndated: 0 };
    expect(formatRecord(r)).toBe("2-0 (1 undecided)");
  });

  it("an all-zero record still renders (no crash, no NaN)", () => {
    const r: WindowedRecordResult = { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 };
    expect(formatRecord(r)).toBe("0-0");
  });
});

describe("formatSlotTendencies", () => {
  it("renders each slot with its count, in the given (already-sorted) order", () => {
    const slots: SlotTendency[] = [{ slot: "S1", count: 5 }, { slot: "D1", count: 3 }];
    expect(formatSlotTendencies(slots)).toBe("S1×5, D1×3");
  });

  it("an empty list renders a explicit placeholder rather than an empty string", () => {
    expect(formatSlotTendencies([])).toBe("none");
  });
});

describe("formatPartnerFrequency", () => {
  it("renders each partner's canonical name with its count", () => {
    const partners: (PartnerFrequencyEntry & { canonicalName: string })[] = [
      { partnerId: 1, count: 4, canonicalName: "Kai Kestrel" },
    ];
    expect(formatPartnerFrequency(partners)).toBe("Kai Kestrel ×4");
  });

  it("an empty list renders a explicit placeholder", () => {
    expect(formatPartnerFrequency([])).toBe("none");
  });
});

describe("formatRatingTrajectory", () => {
  it("renders each source's latest value, NTRP with its rating type appended", () => {
    const trajectory: RatingTrajectoryResult = [
      { source: "ntrp", latest: { id: 1, value: 4.0, ratingType: "C", observedOn: "2026-01-01" }, series: [] },
      { source: "wtn_singles", latest: { id: 2, value: 21.5, ratingType: null, observedOn: "2026-01-01" }, series: [] },
    ];
    expect(formatRatingTrajectory(trajectory)).toBe("NTRP 4C, WTN-S 21.5");
  });

  it("an unrecognized source label falls back to the raw source string rather than dropping it", () => {
    const trajectory: RatingTrajectoryResult = [
      { source: "utr", latest: { id: 1, value: 5.0, ratingType: null, observedOn: "2026-01-01" }, series: [] },
    ];
    expect(formatRatingTrajectory(trajectory)).toBe("utr 5");
  });

  it("no observations at all renders an explicit placeholder", () => {
    expect(formatRatingTrajectory([])).toBe("none on file");
  });
});

describe("formatDataGapsLine", () => {
  it("lists only the not-collected keys, human-labeled, in a stable order", () => {
    const gaps: DataGapsResult = { events: "not-collected", availability: "not-collected", captainNotes: "not-collected" };
    expect(formatDataGapsLine(gaps)).toBe("events, availability, captain notes");
  });

  it("returns null (not an empty string) when there is nothing not-collected", () => {
    const gaps: DataGapsResult = { events: "has-data", availability: "empty" };
    expect(formatDataGapsLine(gaps)).toBeNull();
  });

  it("an empty input returns null", () => {
    expect(formatDataGapsLine({})).toBeNull();
  });

  it("a key with no human label falls back to the raw key rather than dropping it", () => {
    const gaps: DataGapsResult = { someFutureSection: "not-collected" };
    expect(formatDataGapsLine(gaps)).toBe("someFutureSection");
  });
});
