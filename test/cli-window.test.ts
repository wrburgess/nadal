// Issue #122. The boundary these helpers produce used to be the anchor's CALENDAR YEAR (issue #90),
// which silently deleted an entire team's season from the binder the moment that team's league ran
// in a different calendar year than the anchor: measured on the real Springfield Sectionals field,
// two of five teams (OK/Dickason, IA/Versteeg) read 0-0 or a truncated record while the other three
// read correctly, on the SAME page, with nothing on it saying so.
//
// It is now a 12-MONTH LOOKBACK anchored to the same instant a season boundary used to be anchored
// to (an event's `starts_on`, or the caller's clock) — measured on the same field, this keeps 38 of
// 38 team matches. The window carries exactly one degree of freedom, the anchor day, and the lower
// bound (`since`) and the printed label are BOTH derived from that single field, so they cannot
// diverge (the anti-forgery discipline PR #91's review established for the season predecessor, see
// the doc comments in src/cli/window.ts).

import { describe, expect, it } from "vitest";
import {
  type EvidenceWindow,
  evidenceWindow,
  verifiedWindow,
  windowLabel,
  windowSince,
  windowSnapshot,
  windowStart,
} from "../src/cli/window.js";

describe("windowStart", () => {
  it("is exactly 12 months before the anchor day, inclusive", () => {
    expect(windowStart(new Date("2026-08-28T12:00:00Z"))).toBe("2025-08-28");
  });

  it("accepts an ISO date string, which is the shape events.starts_on carries", () => {
    // `report build` anchors to an event, and `events.starts_on` is a plain `YYYY-MM-DD` text
    // column — not a Date. Taking both shapes is what keeps the call site from doing its own
    // parsing, which is where a second, divergent clock would creep in.
    expect(windowStart("2026-08-28")).toBe("2025-08-28");
  });

  it("is the measured Springfield bound from issue #122: keeps 38 of 38 team matches", () => {
    expect(windowStart("2026-08-28")).toBe("2025-08-28");
  });

  it("is UTC-stable across a timezone that would shift the calendar day", () => {
    // A local-timezone read would make the boundary depend on the invoking machine's TZ, which is
    // exactly the nondeterminism report rendering must avoid.
    expect(windowStart(new Date("2026-01-01T00:30:00Z"))).toBe("2025-01-01");
    expect(windowStart(new Date("2025-12-31T23:30:00Z"))).toBe("2024-12-31");
  });

  it("refuses an unparseable anchor rather than silently falling back to today", () => {
    // A malformed `events.starts_on` must not quietly produce a window anchored to today: that is
    // the failure issue #90 (and now #122) is about — a boundary that reads as anchored to the
    // event and is not.
    expect(() => windowStart("not-a-date")).toThrow(/unusable evidence window anchor/i);
  });

  it("defaults to the current time when no argument is given", () => {
    expect(windowStart()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("windowLabel", () => {
  it("names the window as '12mo to <anchor day>', never a bare year", () => {
    expect(windowLabel(new Date("2026-08-28T12:00:00Z"))).toBe("12mo to 2026-08-28");
    expect(windowLabel("2026-08-28")).toBe("12mo to 2026-08-28");
  });

  it("always names the anchor day, and the boundary it implies always sorts strictly before it", () => {
    // The label is what a reader sees next to the number; if the two ever disagreed, the binder
    // would state a window it did not actually filter to — the exact claim-vs-code failure this
    // repo keeps recording.
    for (const anchor of ["2026-01-01", "2026-06-15", "2026-12-31", "2025-03-04", "2028-02-29"]) {
      const label = windowLabel(anchor);
      const since = windowStart(anchor);
      expect(label).toBe(`12mo to ${anchor}`);
      expect(since < anchor).toBe(true);
    }
  });
});

describe("EvidenceWindow / evidenceWindow", () => {
  it("derives its boundary and label from its anchorDay, so the two cannot disagree", () => {
    const window = evidenceWindow("2026-08-28");
    expect(window.anchorDay).toBe("2026-08-28");
    expect(windowSince(window)).toBe("2025-08-28");
    expect(windowSnapshot(window).label).toBe("12mo to 2026-08-28");
  });

  it("cannot be cloned into a state where the boundary and the label disagree", () => {
    // The season predecessor's first version stored TWO fields (`since`, `label`) and a review
    // showed `Object.assign` could copy a brand onto a mismatched clone with no cast, filtering to
    // one season while printing another. Storing a single `anchorDay` instead means there is no
    // second field left to fork away from it: overriding it here changes BOTH the boundary and the
    // label together, consistently, however hostile the clone.
    const forged = Object.assign({}, evidenceWindow("2025-06-01"), { anchorDay: "2026-08-28" });

    const snapshot = windowSnapshot(forged);
    expect(snapshot.since).toBe("2025-08-28");
    expect(snapshot.label).toBe("12mo to 2026-08-28");
  });

  it("survives a JSON round trip with the same meaning", () => {
    // MCP returns JSON, so a value that lost its meaning crossing that boundary would be a real
    // hazard for a type carrying an invariant in a non-enumerable place.
    const window = evidenceWindow(new Date("2026-03-14T00:00:00Z"));
    const round = JSON.parse(JSON.stringify(window)) as typeof window;

    expect(round).toEqual(window);
    expect(windowSince(round)).toBe(windowSince(window));
  });
});

describe("windowSnapshot — the report boundary's one read", () => {
  it("reads `anchorDay` exactly once, so an accessor cannot answer differently per consumer", () => {
    // The fix-verification trace on the season predecessor: a getter answering differently per
    // read filtered a dossier to one year while labelling it another. A type cannot stop that — one
    // read can, and this asserts the read count rather than the outcome, because the outcome is
    // only safe BECAUSE of the count.
    let reads = 0;
    const shifty: EvidenceWindow = {
      get anchorDay() {
        reads += 1;
        return reads <= 2 ? "2025-08-28" : "2026-08-28";
      },
    };

    const snapshot = windowSnapshot(shifty);

    expect(reads).toBe(1);
    expect(snapshot.anchorDay).toBe("2025-08-28");
    expect(snapshot.since).toBe("2024-08-28");
    expect(snapshot.label).toBe("12mo to 2025-08-28");
    // Re-reading the snapshot is stable no matter how many times a consumer asks.
    expect([snapshot.anchorDay, snapshot.anchorDay, snapshot.since]).toEqual([
      "2025-08-28",
      "2025-08-28",
      "2024-08-28",
    ]);
  });

  it.each([
    ["", "empty"],
    [" 2026-08-28 ", "whitespace-padded"],
    ["abcd", "non-numeric"],
    ["2026-2-3", "non-padded month/day"],
    ["2026-13-01", "impossible month"],
    ["2026-02-30", "impossible day — not a real calendar date, silently rolls to March 2"],
    ["99999-01-01", "five-digit year"],
    ["0", "single digit"],
    // Fullwidth digits (U+FF10-FF19), NOT ASCII — written as \uXXXX escapes per house rule: a
    // literal exotic glyph pasted into source here has previously been silently converted to a
    // space at the tool boundary and inverted what the test actually probes.
    [String.fromCharCode(0xff12, 0xff10, 0xff12, 0xff16) + "-08-28", "fullwidth digits — not ASCII"],
  ])("refuses a malformed anchor day (%s: %s) instead of failing open", (anchorDay) => {
    // Every one of these previously (season predecessor) either admitted all history or excluded
    // everything, silently, rather than refusing — a wrong binder that exits 0 is the failure mode
    // this whole issue is about.
    expect(() => windowSnapshot({ anchorDay })).toThrow(/unusable evidence window anchor/i);
  });

  it("accepts what evidenceWindow produces", () => {
    expect(windowSnapshot(evidenceWindow("2026-08-28"))).toEqual({
      anchorDay: "2026-08-28",
      since: "2025-08-28",
      label: "12mo to 2026-08-28",
    });
  });

  it("derives a well-formed `since` for a range of adversarial-but-valid anchors", () => {
    // The lexical-compare hazard: `played_on` is compared as TEXT, so `since` must be provably
    // `YYYY-MM-DD` shaped or a malformed bound fails OPEN (admits everything) rather than closed.
    // "0001-01-01" is the smallest anchor that still derives a well-formed bound (year 0000) — see
    // the year-0000 refusal below for the one anchor this loop deliberately stops short of.
    for (const anchorDay of ["2026-01-01", "2026-12-31", "2028-02-29", "2000-02-29", "2025-06-15", "0001-01-01"]) {
      const { since } = windowSnapshot({ anchorDay });
      expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it.each(["0000-01-01", "0000-12-31"])(
    "refuses a year-0000 anchor (%s) rather than deriving a malformed lexical bound",
    (anchorDay) => {
      // `isIsoDay("0000-01-01")` is TRUE (it is a real calendar day), so this is not caught by the
      // malformed-shape refusals above — it needs its own check. Without it, `twelveMonthsBefore`
      // computes `String(-1).padStart(4, "0")`, which is `"00-1"`, not a 4-digit year: the bound
      // becomes `"00-1-01-01"`, malformed text that sorts BELOW every real `YYYY-MM-DD` value and so
      // admits every row a lexical `played_on >= since` compares it against — failing OPEN, the exact
      // hazard this whole seam exists to close.
      expect(() => windowSnapshot({ anchorDay })).toThrow(/unusable evidence window anchor/i);
    },
  );

  it("windowStart(0001-01-01) is 0000-01-01 — the smallest anchor with a well-formed predecessor year", () => {
    expect(windowStart("0001-01-01")).toBe("0000-01-01");
  });
});

describe("the 12-month subtraction rule", () => {
  it.each([
    ["2026-08-28", "2025-08-28"],
    // Clamp: leap years are never adjacent under the Gregorian rule (min spacing is 4 years), so
    // the year immediately before ANY Feb-29 anchor is guaranteed non-leap — the clamp fires
    // unconditionally on a Feb-29 anchor, not merely sometimes.
    ["2028-02-29", "2027-02-28"],
    ["2000-02-29", "1999-02-28"], // 2000 is leap (div 400); 1999 is not — still clamps
    ["2026-01-01", "2025-01-01"],
    ["2026-12-31", "2025-12-31"],
  ])("windowStart(%s) === %s", (anchorDay, expectedSince) => {
    expect(windowStart(anchorDay)).toBe(expectedSince);
  });
});

describe("windowSince (window-based convenience)", () => {
  it("matches windowSnapshot(window).since", () => {
    const window = evidenceWindow("2026-08-28");
    expect(windowSince(window)).toBe(windowSnapshot(window).since);
  });
});

// #122 round 2 (Codex fix-verification): the profile services accept a structural disclosure
// triple, and "every current caller builds it with windowSnapshot" is a convention, not an
// invariant — a hand-assembled triple could filter by one bound while disclosing another. This
// guard is what turns the convention back into an invariant: the redundant fields must derive
// from their one degree of freedom, or the whole triple refuses.
describe("verifiedWindow — the disclosure triple cannot lie", () => {
  it("accepts windowSnapshot output and returns the recomputed frozen snapshot", () => {
    const snap = windowSnapshot(evidenceWindow("2026-08-28"));
    const verified = verifiedWindow(snap);
    expect(verified).toEqual(snap);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it("refuses a triple whose `since` does not derive from its anchorDay — the round-2 trace", () => {
    // The reviewer's exact forgery: filter would admit ALL history while the label claims a
    // 12-month 2026 window.
    expect(() =>
      verifiedWindow({ anchorDay: "2026-08-28", since: "0000-01-01", label: "12mo to 2026-08-28" }),
    ).toThrow(/inconsistent evidence window disclosure/i);
  });

  it("refuses a triple whose label does not derive from its anchorDay", () => {
    expect(() =>
      verifiedWindow({ anchorDay: "2026-08-28", since: "2025-08-28", label: "2026" }),
    ).toThrow(/inconsistent evidence window disclosure/i);
  });

  it("delegates anchorDay validation — a year-0000 or malformed anchor refuses the same way windowSnapshot does", () => {
    expect(() =>
      verifiedWindow({ anchorDay: "0000-06-15", since: "-001-06-15", label: "12mo to 0000-06-15" }),
    ).toThrow(/unusable evidence window anchor/i);
    expect(() =>
      verifiedWindow({ anchorDay: "not-a-date", since: "2025-08-28", label: "12mo to not-a-date" }),
    ).toThrow(/unusable evidence window anchor/i);
  });

  it("returns the recomputed snapshot, never the caller's object — an accessor triple cannot answer differently to later consumers", () => {
    // Each field is read exactly ONCE; the returned object is the seam's own frozen derivation, so
    // a getter that answers correctly during validation and differently afterwards has nothing
    // left to lie to — consumers hold plain recomputed strings.
    let sinceReads = 0;
    const shifty = {
      anchorDay: "2026-08-28",
      get since() {
        sinceReads += 1;
        return sinceReads === 1 ? "2025-08-28" : "0000-01-01";
      },
      label: "12mo to 2026-08-28",
    };

    const verified = verifiedWindow(shifty);

    expect(sinceReads).toBe(1);
    expect(verified).not.toBe(shifty);
    expect(verified.since).toBe("2025-08-28");
    expect(Object.isFrozen(verified)).toBe(true);
  });
});
