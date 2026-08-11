import { describe, expect, it } from "vitest";
import {
  formatAbsentRosterMember,
  formatDataGapsLine,
  formatName,
  formatPartnerFrequency,
  formatRatingTrajectory,
  formatRecord,
  formatRosterSourceLine,
  formatSlotTendencies,
  formatWtnProvenanceLine,
} from "../src/cli/format-profile.js";
import type { AbsentRosterMember } from "../src/query/team-profile.js";
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
    // NTRP is fixed to 1 decimal (it is always x.0/x.5 by definition); WTN is fixed to 2 decimals.
    expect(formatRatingTrajectory(trajectory)).toBe("NTRP 4.0C, WTN-S 21.50");
  });

  it("an unrecognized source label falls back to the raw source string rather than dropping it", () => {
    const trajectory: RatingTrajectoryResult = [
      { source: "utr", latest: { id: 1, value: 5.0, ratingType: null, observedOn: "2026-01-01" }, series: [] },
    ];
    expect(formatRatingTrajectory(trajectory)).toBe("utr 5.00");
  });

  it("no observations at all renders an explicit placeholder", () => {
    expect(formatRatingTrajectory([])).toBe("none on file");
  });

  it("formats a WTN value that is exactly an integer with fixed 2-decimal precision — not '4', but '4.00'", () => {
    const trajectory: RatingTrajectoryResult = [
      { source: "wtn_doubles", latest: { id: 1, value: 4, ratingType: null, observedOn: "2026-01-01" }, series: [] },
    ];
    expect(formatRatingTrajectory(trajectory)).toBe("WTN-D 4.00");
  });

  it("formats a TR dynamic value with trailing zeros at fixed 2-decimal precision — not '4.1', but '4.10'", () => {
    const trajectory: RatingTrajectoryResult = [
      { source: "tr_dynamic", latest: { id: 1, value: 4.1, ratingType: null, observedOn: "2026-01-01" }, series: [] },
    ];
    expect(formatRatingTrajectory(trajectory)).toBe("TR-Dyn 4.10");
  });

  it("formats an NTRP value that is exactly an integer with fixed 1-decimal precision — not '4', but '4.0'", () => {
    const trajectory: RatingTrajectoryResult = [
      { source: "ntrp", latest: { id: 1, value: 4, ratingType: "C", observedOn: "2026-01-01" }, series: [] },
    ];
    expect(formatRatingTrajectory(trajectory)).toBe("NTRP 4.0C");
  });

  it("rounds a value with more decimal places than the fixed precision, rather than truncating or overflowing", () => {
    const trajectory: RatingTrajectoryResult = [
      { source: "wtn_singles", latest: { id: 1, value: 21.567, ratingType: null, observedOn: "2026-01-01" }, series: [] },
    ];
    expect(formatRatingTrajectory(trajectory)).toBe("WTN-S 21.57");
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

// Found by the independent Codex review of PR #47 (rated medium), against the new `lineup plan`
// formatter — fixed for all three terminal presenters, since the two older ones are exposed by
// exactly the same input and fixing only the reported instance is this repo's most-recorded
// failure mode (docs/findings.md).
//
// A player name comes from a scraped page. `src/sanitize.ts` was written for this class but was
// only ever wired into `key=value` summary lines, so the multi-line human-readable output wrote
// names raw to the terminal.
describe("formatName — scraped names never reach the terminal with control characters", () => {
  // Built from character codes rather than literal escapes, so this source file does not itself
  // contain an ANSI sequence (the same reasoning src/sanitize.ts records for its own constants).
  const ESC = String.fromCharCode(0x1b);
  const OSC = `${ESC}]0;pwned${String.fromCharCode(0x07)}`;
  const CSI_CLEAR = `${ESC}[2J`;
  const RTL_OVERRIDE = String.fromCharCode(0x202e);

  it.each([
    ["an ANSI CSI screen-clear", `Dan${CSI_CLEAR}Kestrel`],
    ["an OSC window-title sequence", `Dan${OSC}Kestrel`],
    ["a bidi right-to-left override", `Dan${RTL_OVERRIDE}Kestrel`],
    ["a raw newline", "Dan\nKestrel"],
    ["a carriage return", "Dan\rKestrel"],
  ])("strips %s", (_label, hostile) => {
    const out = formatName(hostile);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(RTL_OVERRIDE);
    expect(out).not.toMatch(/[\r\n]/);
    // Replaced with a space, not deleted — the name stays legible rather than silently merging
    // into a different-looking one.
    expect(out.startsWith("Dan")).toBe(true);
    expect(out.endsWith("Kestrel")).toBe(true);
  });

  it("leaves an ordinary name, including non-ASCII, untouched", () => {
    expect(formatName("Élodie Örström")).toBe("Élodie Örström");
    expect(formatName("JT Martin")).toBe("JT Martin");
  });
});

// Task 7 (#113): the roster-source disclosure line, the #97 `formatEvidenceScopeLine` precedent one
// field over — BOTH branches always print.
describe("formatRosterSourceLine", () => {
  it("registered: states the count and the event", () => {
    expect(formatRosterSourceLine("registered", "Springfield Sectionals 2026", 9, 20)).toBe(
      'registered 9 for event "Springfield Sectionals 2026" (season roster: 20)',
    );
  });

  it("season, no event named: states the fallback plainly", () => {
    expect(formatRosterSourceLine("season", null, 0, 20)).toBe("season roster — no event named");
  });

  it("season, event named but nothing registered: names the event AND the fallback", () => {
    expect(formatRosterSourceLine("season", "Unregistered Event", 0, 20)).toBe(
      'season roster (event "Unregistered Event") — no registered members',
    );
  });

  it("sanitizes a hostile event name", () => {
    const line = formatRosterSourceLine("registered", "Dan\nKestrel", 1, 1);
    expect(line).not.toMatch(/[\r\n]/);
  });
});

describe("formatAbsentRosterMember", () => {
  it("prints the name and the rating value at the source's precision", () => {
    const member: AbsentRosterMember = { playerId: 1, canonicalName: "Jamie Jennings", rating: 4.28 };
    expect(formatAbsentRosterMember(member, "wtn_singles")).toBe("Jamie Jennings 4.28");
  });

  it("prints — (never omits the player) when there is no observation in the chosen source", () => {
    const member: AbsentRosterMember = { playerId: 2, canonicalName: "No Rating Nina", rating: null };
    expect(formatAbsentRosterMember(member, "wtn_singles")).toBe("No Rating Nina —");
  });

  it("prints — when there is no chosen source at all (nobody absent has any rating)", () => {
    const member: AbsentRosterMember = { playerId: 3, canonicalName: "Nobody Rated", rating: null };
    expect(formatAbsentRosterMember(member, null)).toBe("Nobody Rated —");
  });

  it("uses NTRP's one-decimal precision, matching formatRatingTrajectory's own rule", () => {
    const member: AbsentRosterMember = { playerId: 4, canonicalName: "Cam Carver", rating: 4 };
    expect(formatAbsentRosterMember(member, "ntrp")).toBe("Cam Carver 4.0");
  });

  it("sanitizes a hostile player name", () => {
    const member: AbsentRosterMember = { playerId: 5, canonicalName: "Dan\nKestrel", rating: null };
    expect(formatAbsentRosterMember(member, null)).not.toMatch(/[\r\n]/);
  });
});

describe("formatWtnProvenanceLine (#132)", () => {
  /** One trajectory entry, shaped like the real one. Only `latest` is populated, because only
   * `latest` is what `formatRatingTrajectory` prints — the line has to describe the numbers on
   * the page, not every number on file. */
  const entry = (source: string, value: number, observedOn: string): RatingTrajectoryResult[number] => ({
    source,
    latest: { id: 1, value, ratingType: null, observedOn },
    series: [],
  });

  it("names the publisher and the one date every WTN row shares", () => {
    const line = formatWtnProvenanceLine([
      [entry("wtn_singles", 30.35, "2026-08-05"), entry("ntrp", 3.5, "2025-12-31")],
      [entry("wtn_doubles", 29.69, "2026-08-05")],
    ]);

    expect(line).toContain("USTA player profile");
    expect(line).toContain("2026-08-05");
    expect(line).toContain("worldtennisnumber.com");
  });

  it("states a range rather than collapsing two different publication dates into one", () => {
    // Collapsing is the failure this branch exists for: printing one date over a roster whose rows
    // carry two is a new false claim of the same shape as the one #132 removes.
    const line = formatWtnProvenanceLine([
      [entry("wtn_singles", 30.35, "2026-08-05")],
      [entry("wtn_singles", 31.4, "2026-09-01")],
    ]);

    expect(line).toContain("2026-08-05");
    expect(line).toContain("2026-09-01");
  });

  it("still prints when nothing on the roster has a WTN, and claims nothing", () => {
    // #97/#113's discipline: a disclosure that vanishes when there is nothing to disclose leaves
    // the reader unable to tell "no WTN on file" from "this dossier forgot to say".
    const line = formatWtnProvenanceLine([[entry("ntrp", 3.5, "2025-12-31")]]);

    expect(line).not.toBe("");
    expect(line).toContain("none on file");
    // No publication claim can be made, so none is made.
    expect(line).not.toContain("published");
  });

  it("prints on a completely empty roster rather than throwing", () => {
    expect(formatWtnProvenanceLine([])).toContain("none on file");
  });

  it("ignores non-WTN sources when choosing the dates", () => {
    // The date printed must be the date of the numbers the line is ABOUT. An NTRP row dated 2015
    // must not widen the WTN range — that would be a true-looking sentence about the wrong rows.
    const line = formatWtnProvenanceLine([
      [entry("ntrp", 3.5, "2015-12-31"), entry("wtn_singles", 30.35, "2026-08-05")],
    ]);

    expect(line).toContain("2026-08-05");
    expect(line).not.toContain("2015");
  });

  it("covers a WTN source the vocabulary grows later, not just the two on file today", () => {
    // The guard-completeness check, with the input #132's own option 3 would have supplied: adding
    // a second, source-attributed WTN singles reading. An enumerated set would silently describe
    // only the old source while the roster table printed both numbers.
    const line = formatWtnProvenanceLine([[entry("wtn_singles_itf", 32.6, "2026-09-01")]]);

    expect(line).toContain("published 2026-09-01");
    expect(line).not.toContain("none on file");
  });

  it("distinguishes 'no WTN at all' from 'WTN we cannot date'", () => {
    // `observed_on` is unconstrained TEXT, so a blank one is reachable. Collapsing it into "none on
    // file" would deny ratings the table is visibly printing; letting it reach the dated branch
    // would print a contentless "published .". Neither is acceptable, so it gets its own branch.
    const line = formatWtnProvenanceLine([[entry("wtn_singles", 30.35, "   ")]]);

    expect(line).not.toContain("none on file");
    expect(line).not.toContain("published .");
    expect(line).toContain("publication date not recorded");
  });

  it("survives a hostile observed_on without emitting a line break", () => {
    // `observed_on` is a TEXT column with no format constraint, so it reaches this line as
    // arbitrary bytes. Every other formatter in this module refuses to emit a newline; so does
    // this one, or a one-line CLI summary and a markdown paragraph both break.
    const line = formatWtnProvenanceLine([[entry("wtn_singles", 30.35, "2026-08-05\nInjected")]]);

    expect(line).not.toMatch(/[\r\n]/);
  });
});
