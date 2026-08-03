// Issue #90. The boundary these helpers produce used to be "six months back from whenever you
// ran the command", which made every printed record depend on the print date: measured on the real
// HOA/Burgess-Zingg team, 5 of 8 matches were visible on 2026-08-03 and only 2 of 8 would be
// visible on the day of Sectionals. The binder was thinnest on the day it is used.
//
// It is now the start of the anchor's SEASON, which for a USTA league is its calendar year — the
// unit TennisRecord itself models (`?year=2026` on every team URL, a `2026Record` roster column).

import { describe, expect, it } from "vitest";
import { seasonLabel, seasonStart, seasonWindow, seasonWindowSince } from "../src/cli/window.js";

describe("seasonStart", () => {
  it("returns January 1 of the anchor's year", () => {
    expect(seasonStart(new Date("2026-07-30T12:00:00Z"))).toBe("2026-01-01");
  });

  it("includes the first instant of the season", () => {
    // A match played ON Jan 1 is in the season. `since` is compared inclusively downstream, so the
    // boundary itself is the value most likely to be off by one.
    expect(seasonStart(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });

  it("includes the last instant of the season", () => {
    // Dec 31 must still resolve to THIS season's January, not next season's — the other end of the
    // same off-by-one.
    expect(seasonStart(new Date("2026-12-31T23:59:59Z"))).toBe("2026-01-01");
  });

  it("is UTC-stable across a timezone that would shift the calendar day", () => {
    // The predecessor's docstring called out local-time arithmetic as the nondeterminism to avoid,
    // because report rendering must be deterministic given a profile. An instant that is Jan 1 in
    // UTC but Dec 31 in a western zone must still resolve by UTC.
    expect(seasonStart(new Date("2026-01-01T00:30:00Z"))).toBe("2026-01-01");
    expect(seasonStart(new Date("2025-12-31T23:30:00Z"))).toBe("2025-01-01");
  });

  it("accepts an ISO date string, which is the shape events.starts_on carries", () => {
    // `report build` anchors to an event, and `events.starts_on` is a plain `YYYY-MM-DD` text
    // column — not a Date. Taking both shapes is what keeps the call site from doing its own
    // parsing, which is where a second, divergent clock would creep in.
    expect(seasonStart("2026-08-28")).toBe("2026-01-01");
  });

  it("refuses an unparseable anchor rather than silently falling back to today", () => {
    // A malformed `events.starts_on` must not quietly produce the current season: that is the
    // failure this whole issue is about — a boundary that looks anchored and is not.
    expect(() => seasonStart("not-a-date")).toThrow(/season anchor/i);
  });

  it("defaults to the current time when no argument is given", () => {
    expect(seasonStart()).toMatch(/^\d{4}-01-01$/);
  });
});

describe("seasonLabel", () => {
  it("names the season the boundary selects", () => {
    expect(seasonLabel(new Date("2026-07-30T12:00:00Z"))).toBe("2026");
    expect(seasonLabel("2026-08-28")).toBe("2026");
  });

  it("agrees with seasonStart for the same anchor", () => {
    // The label is what a reader sees next to the number; if the two ever disagreed, the binder
    // would state a season it did not actually filter to — the exact claim-vs-code failure this
    // repo keeps recording.
    for (const anchor of ["2026-01-01", "2026-06-15", "2026-12-31", "2025-03-04"]) {
      expect(seasonStart(anchor).slice(0, 4)).toBe(seasonLabel(anchor));
    }
  });
});

describe("SeasonWindow", () => {
  it("derives its boundary from its year, so the two cannot disagree", () => {
    const window = seasonWindow("2026-08-28");
    expect(window.year).toBe("2026");
    expect(seasonWindowSince(window)).toBe("2026-01-01");
  });

  it("cannot be cloned into a state where the boundary and the label disagree", () => {
    // The fix-verification pass on the FIRST version of this type showed its symbol brand was
    // decoration: the key is enumerable, so `Object.assign` copied it onto a mismatched clone with
    // no cast, and the writers would then filter to one season while printing another. The answer
    // was not a runtime guard but removing the second field — so the clone below, hostile as it is,
    // still cannot produce an inconsistency, because there is only one value to copy.
    const forged = Object.assign({}, seasonWindow("2025-06-01"), { year: "2026" });

    expect(seasonWindowSince(forged)).toBe("2026-01-01");
    expect(forged.year).toBe("2026");
  });

  it("survives a JSON round trip with the same meaning", () => {
    // MCP returns JSON, so a value that lost its meaning crossing that boundary would be a real
    // hazard for a type carrying an invariant in a non-enumerable place.
    const window = seasonWindow(new Date("2026-03-14T00:00:00Z"));
    const round = JSON.parse(JSON.stringify(window)) as typeof window;

    expect(round).toEqual(window);
    expect(seasonWindowSince(round)).toBe(seasonWindowSince(window));
  });
});
