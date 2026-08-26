import { describe, expect, it } from "vitest";
import {
  formatAbsentRosterMember,
  formatAliases,
  formatDataGapsLine,
  formatName,
  formatPartnerFrequency,
  formatRatingTrajectory,
  formatRecord,
  formatRosterSourceLine,
  formatSlotTendencies,
  formatTeamMemberships,
  formatWtnProvenanceLine,
  formatWtnScaleBreakLine,
} from "../src/cli/format-profile.js";
import type { RatingSource } from "../src/query/types.js";
import type { PlayerTeamMembershipSummary } from "../src/query/player-profile.js";
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

  it("notices a WTN source the vocabulary grows later instead of dropping it", () => {
    // Guard completeness, with the input #132's own option 3 supplies: a second, source-attributed
    // WTN reading. An enumerated-only set would omit it from the disclosure entirely while the
    // roster table printed the number.
    const line = formatWtnProvenanceLine([
      [entry("wtn_singles", 30.35, "2026-08-05"), entry("wtn_worldtennisnumber_singles", 32.6, "2026-09-01")],
    ]);

    expect(line).toContain("does not identify their publisher");
  });

  it("never attributes an unrecognised WTN source to the USTA profile", () => {
    // The defect the *fix* for the test above nearly introduced, and the sharper one: option 3's
    // second source comes FROM worldtennisnumber.com — the publisher this line says the number is
    // not from. A bare `startsWith("wtn_")` would have stamped "shown on the USTA player profile"
    // onto exactly that figure, manufacturing a false attribution in the one sentence whose whole
    // job is attribution. A roster carrying ONLY such a source claims nothing about USTA.
    // (Codex adversarial review round 1, guard-completeness lens.)
    const line = formatWtnProvenanceLine([[entry("wtn_worldtennisnumber_singles", 32.6, "2026-09-01")]]);

    expect(line).not.toContain("USTA");
    expect(line).not.toContain("published 2026-09-01");
    expect(line).toContain("does not identify their publisher");
  });

  it("keeps the USTA date claim scoped to the USTA-sourced rows when both are present", () => {
    // The mixed case: the dated claim must describe only the rows it is about. An unrecognised
    // source dated 2026-09-01 must not widen or move the USTA publication date.
    const line = formatWtnProvenanceLine([
      [entry("wtn_singles", 30.35, "2026-08-05"), entry("wtn_worldtennisnumber_singles", 32.6, "2026-09-01")],
    ]);

    expect(line).toContain("published 2026-08-05");
    expect(line).not.toContain("published between");
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

/** Control and bidi characters built from CODE POINTS — never from a literal byte and never from
 * a `backslash-u` escape, which this repo's tooling has been observed to resolve into the byte
 * itself before the file is written. `src/sanitize.ts` uses the identical device on its own
 * property escapes, for the identical reason: a literal invisible character in a source file
 * shares the exact failure mode these assertions exist to probe, and one has already inverted a
 * review outcome here (docs/findings.md). */
const BACKSLASH = String.fromCharCode(0x5c);
const ESC_BYTE = String.fromCharCode(0x1b); // ANSI CSI introducer
const RLO_BYTE = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
const ZWSP_BYTE = String.fromCharCode(0x200b); // ZERO WIDTH SPACE
const CGJ_BYTE = String.fromCharCode(0x034f); // COMBINING GRAPHEME JOINER — category Mn, NOT Cc/Cf
const VS16_BYTE = String.fromCharCode(0xfe0f); // VARIATION SELECTOR-16 — also Mn
const MVS_BYTE = String.fromCharCode(0x180e); // MONGOLIAN VOWEL SEPARATOR — Cf, but Mongolian script
const FVS1_BYTE = String.fromCharCode(0x180b); // MONGOLIAN FREE VARIATION SELECTOR ONE — Mn + Mongolian
const HANGUL_FILLER_BYTE = String.fromCharCode(0x3164); // HANGUL FILLER — Lo, NFKC-maps to U+1160
const HANGUL_JUNGSEONG_FILLER_BYTE = String.fromCharCode(0x1160); // Lo + Hangul
const KHMER_AQ_BYTE = String.fromCharCode(0x17b4); // KHMER VOWEL INHERENT AQ — Mn + Khmer
const CONTROL_OR_BIDI = new RegExp(`[${BACKSLASH}p{Cc}${BACKSLASH}p{Cf}]`, "u");

// Issue #131. `team_memberships` is `player <-> team <-> event` by design, so a player on both a
// season/district roster (`event_id IS NULL`) and an event's registered roster (`event_id = N`)
// legitimately holds two rows for ONE team — 49 such pairs on the live database, spread across all
// five Sectionals teams. The old renderer mapped rows straight to strings and printed the team name
// twice with byte-identical text.
//
// These tests pin the whole grouping contract, not just the dedupe, because the issue's own framing
// is that collapsing to one name would DISCARD the season-vs-registered distinction — and on the
// measured data that distinction is a scouting fact about opponents, not roster admin.
describe("formatTeamMemberships", () => {
  function membership(
    over: Partial<PlayerTeamMembershipSummary> & Pick<PlayerTeamMembershipSummary, "teamId" | "teamName">,
  ): PlayerTeamMembershipSummary {
    return { eventId: null, eventName: null, retiredAt: null, ...over };
  }

  const SEASON = { teamId: 1, teamName: "HOA/Burgess-Zingg/40&over3.5M" };
  const REGISTERED = {
    teamId: 1,
    teamName: "HOA/Burgess-Zingg/40&over3.5M",
    eventId: 1,
    eventName: "Springfield Sectionals",
  };

  /** Substring COUNTING, deliberately: `toContain` passes just as happily on the buggy output, so an
   * occurrence count is the only assertion that distinguishes "printed once" from "printed twice". */
  function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("prints one entry for a team the player holds both a season and an event row on (the #131 defect)", () => {
    const line = formatTeamMemberships([membership(SEASON), membership(REGISTERED)]);

    expect(occurrences(line, "HOA/Burgess-Zingg/40&over3.5M")).toBe(1);
  });

  it("names BOTH roster contexts rather than collapsing the distinction away", () => {
    // The half of the issue a plain `DISTINCT` would silently lose. `season roster` / `registered
    // for` is #113's vocabulary (`resolveRoster`, `formatRosterSourceLine`), reused rather than
    // reinvented so one distinction has one wording across the CLI.
    const line = formatTeamMemberships([membership(SEASON), membership(REGISTERED)]);

    expect(line).toBe('HOA/Burgess-Zingg/40&over3.5M (season roster; registered for "Springfield Sectionals")');
  });

  it("keeps two genuinely different teams as two entries", () => {
    // The issue's second acceptance clause. Grouping is on `teamId`, so nothing here may merge.
    const line = formatTeamMemberships([
      membership({ teamId: 1, teamName: "Alpha" }),
      membership({ teamId: 2, teamName: "Beta" }),
    ]);

    expect(line).toBe("Alpha, Beta");
  });

  it("renders a lone current season membership bare — byte-identical to the pre-#131 output", () => {
    // 28 of the 77 players who hold any membership. Naming "season roster" when it is the only
    // context adds nothing, so the parenthetical is elided. This is the case a regression would be
    // least likely to notice.
    expect(formatTeamMemberships([membership({ teamId: 1, teamName: "Solo Team" })])).toBe("Solo Team");
  });

  it("renders a lone retired season membership '(former)' — the #49 behavior, unchanged", () => {
    const line = formatTeamMemberships([
      membership({ teamId: 1, teamName: "Former Team", retiredAt: "2026-07-01T00:00:00.000Z" }),
    ]);

    expect(line).toBe("Former Team (former)");
  });

  it("attaches 'former' to the RETIRED context, not to the whole team, when a registration still stands", () => {
    // The corner no live row exercises (`retired_at` is non-null on 0 of 126 rows today) and the one
    // this change could most easily get wrong: reading any single row's `retiredAt` for the whole
    // team would label a player who is still registered for Springfield as a former member.
    // Reachable in practice — `setEventRoster` requires a current season membership at registration
    // time, but a later `tn team pull` retires the season row and correctly leaves the registration
    // standing (see `formatRosterSourceLine`'s own note on the same asymmetry).
    const line = formatTeamMemberships([
      membership({ ...SEASON, retiredAt: "2026-07-01T00:00:00.000Z" }),
      membership(REGISTERED),
    ]);

    expect(line).toBe(
      'HOA/Burgess-Zingg/40&over3.5M (season roster — former; registered for "Springfield Sectionals")',
    );
    expect(line).not.toContain("40&over3.5M (former)");
  });

  it("attaches 'former' to a retired REGISTRATION while the season membership stands", () => {
    // The mirror of the case above — `retireAbsentEventMemberships` produces it when a re-issued
    // roster payload drops a player who is still on the season roster.
    const line = formatTeamMemberships([
      membership(SEASON),
      membership({ ...REGISTERED, retiredAt: "2026-07-01T00:00:00.000Z" }),
    ]);

    expect(line).toBe(
      'HOA/Burgess-Zingg/40&over3.5M (season roster; registered for "Springfield Sectionals" — former)',
    );
  });

  it("renders an event row with no season row without inventing a season claim", () => {
    // No current writer produces this state (`setEventRoster` refuses a player with no current
    // season membership), so it is asserted at the FORMATTER tier only — the QUERY can still produce
    // it (nothing in the read requires a season row), so the presenter must render it correctly
    // rather than only the states today's writers happen to reach. That is narrower than "total over
    // its input type", which was the earlier wording here and claimed more than this suite proves:
    // a caller can hand this function inputs the query cannot, and where that matters the behavior
    // is pinned by its own test (the team-name tie-break below) rather than asserted in general.
    const line = formatTeamMemberships([membership(REGISTERED)]);

    expect(line).toBe('HOA/Burgess-Zingg/40&over3.5M (registered for "Springfield Sectionals")');
    expect(line).not.toContain("season roster");
  });

  it("names every event when a player is registered for more than one on the same team", () => {
    const line = formatTeamMemberships([
      membership(SEASON),
      membership(REGISTERED),
      membership({ ...REGISTERED, eventId: 2, eventName: "District Playoffs" }),
    ]);

    expect(occurrences(line, "HOA/Burgess-Zingg/40&over3.5M")).toBe(1);
    expect(line).toContain('registered for "Springfield Sectionals"');
    expect(line).toContain('registered for "District Playoffs"');
  });

  it("makes a broken event foreign key visible rather than blank", () => {
    // `eventName` is null only when `eventId` is. A non-null id whose left join found no row means
    // the referenced event is gone; printing `registered for ""` would read as a nameless event
    // rather than as a data fault, so the id is printed instead.
    const line = formatTeamMemberships([membership({ teamId: 1, teamName: "Team", eventId: 7, eventName: null })]);

    expect(line).toBe("Team (registered for event #7)");
  });

  // Codex review of PR #141, fail-open, class B — and the two cases it did NOT name, added because
  // this module's own header records that fixing the reported instance and leaving its siblings is
  // this repo's most-recorded failure mode. `events.name` and `teams.name` are both
  // `NOT NULL UNIQUE` with no `CHECK`, so the schema permits a blank that the writers refuse; the
  // decision is made on the SANITIZED value, so a name of nothing but control characters (which
  // `formatName` turns into spaces, not deletions) is caught by the same test.
  it.each([
    ["an empty event name — round 1's case", "", "Team (registered for event #7)"],
    ["a whitespace-only event name", "   ", "Team (registered for event #7)"],
    ["an event name of nothing but a control character", ESC_BYTE, "Team (registered for event #7)"],
    ["an event name of nothing but a bidi override", RLO_BYTE, "Team (registered for event #7)"],
    // Fix-verification pass 1's case: U+034F is category Mn, so `sanitizeValue` (Cc/Cf/Zl/Zp) leaves
    // it and `.trim()` does not remove it. Caught by the `nameKey` half of the union, whose INVISIBLE
    // class is `Default_Ignorable_Code_Point` and therefore reaches Mn.
    ["an event name of nothing but a combining grapheme joiner", CGJ_BYTE, "Team (registered for event #7)"],
    ["an event name of nothing but a variation selector", VS16_BYTE, "Team (registered for event #7)"],
    // Fix-verification pass 2's case, and the reason the predicate is a UNION. `nameKey` deliberately
    // RETAINS U+180E — its script scope exempts complex-script invisibles, because deleting one
    // changes what a reader sees. So the `nameKey` half misses it and the sanitization half catches
    // it: each half is blind exactly where the other sees.
    ["an event name of nothing but a Mongolian vowel separator", MVS_BYTE, "Team (registered for event #7)"],
    ["a real event name, which must be unaffected", "Springfield", 'Team (registered for "Springfield")'],
    // The refutation of the fold: these are visible names and must survive it.
    ["a single-character event name", "X", 'Team (registered for "X")'],
    ["a punctuation-only event name", ".", 'Team (registered for ".")'],
  ])("falls back to the event id for %s", (_label, eventName, expected) => {
    const line = formatTeamMemberships([membership({ teamId: 1, teamName: "Team", eventId: 7, eventName })]);

    expect(line).toBe(expected);
  });

  it.each([
    ["an empty team name", "", "team #4"],
    ["a whitespace-only team name", "  ", "team #4"],
    ["a control-character-only team name", ESC_BYTE, "team #4"],
    ["a combining-grapheme-joiner-only team name", CGJ_BYTE, "team #4"],
  ])("falls back to the team id for %s", (_label, teamName, expected) => {
    // The sibling of the reviewer's finding, on the same line: a blank team name would have rendered
    // the whole entry as a bare parenthetical with a leading space.
    expect(formatTeamMemberships([membership({ teamId: 4, teamName })])).toBe(expected);
    expect(formatTeamMemberships([membership({ teamId: 4, teamName, eventId: 1, eventName: "E" })])).toBe(
      `${expected} (registered for "E")`,
    );
  });

  // The ACCEPTED RESIDUAL CLASS of the union predicate, pinned so it is a recorded limitation rather
  // than an untested belief, and so a future change to `nameKey` or `sanitizeValue` surfaces here as
  // an expectation to update instead of silently changing behavior nobody was watching.
  //
  // THESE ARE A SAMPLE, NOT THE SET, and the distinction is the point: an earlier revision asserted
  // there were exactly two and a review pass blocked the merge on it. Swept against this exact
  // predicate: of 4174 `Default_Ignorable_Code_Point` characters, 395 are treated as blank and 3779
  // are not. No rule about which fall on which side is claimed — two attempts at one were both
  // falsified (script membership does not decide it: U+180E is Mongolian and IS caught, as the
  // complement test below asserts). See `src/db/name-key.ts` for why no such rule is available.
  it.each([
    ["U+180B Mongolian free variation selector one (Mn + Mongolian)", FVS1_BYTE],
    ["U+3164 Hangul filler (Lo, NFKC-maps to U+1160)", HANGUL_FILLER_BYTE],
    ["U+1160 Hangul jungseong filler (Lo)", HANGUL_JUNGSEONG_FILLER_BYTE],
    ["U+17B4 Khmer vowel inherent aq (Mn + Khmer)", KHMER_AQ_BYTE],
  ])("KNOWN RESIDUAL (sample of a 3779-member class): %s still renders blank", (_label, eventName) => {
    const line = formatTeamMemberships([membership({ teamId: 1, teamName: "Team", eventId: 7, eventName })]);

    expect(line).not.toBe("Team (registered for event #7)");
    expect(line).toBe(`Team (registered for "${eventName}")`);
  });

  it("catches every REACHABLE blank case — which is what the union is actually for", () => {
    // The complement of the residual class above, stated as its own assertion so the two are read
    // together: what a scraper or a bad parse actually produces (empty, whitespace, ASCII/Latin
    // controls) IS caught. Nothing in this project's ingestion path can produce a name consisting
    // solely of a complex-script invisible.
    for (const eventName of ["", " ", "\t", "   ", ESC_BYTE, RLO_BYTE, ZWSP_BYTE, CGJ_BYTE, VS16_BYTE, MVS_BYTE]) {
      expect(formatTeamMemberships([membership({ teamId: 1, teamName: "Team", eventId: 7, eventName })])).toBe(
        "Team (registered for event #7)",
      );
    }
  });

  it("keeps surrounding whitespace inside the quotes of a real event name", () => {
    // Only the emptiness DECISION trims; the displayed value does not, so padding stays visible as
    // itself rather than being silently normalised away.
    const line = formatTeamMemberships([
      membership({ teamId: 1, teamName: "Team", eventId: 7, eventName: " Springfield " }),
    ]);

    expect(line).toBe('Team (registered for " Springfield ")');
  });

  it("takes the first row's team name when a group disagrees, rather than splitting the team", () => {
    // Codex review of PR #141, guard completeness, class B. The one caller inner-joins `teams` on
    // `teamId`, so every row in a group necessarily carries the same name and there is no tie to
    // break. This pins the tie-break as a DECISION rather than an accident: splitting the group on
    // name would print the team twice, reintroducing the exact defect #131 exists to close in order
    // to report a state the query cannot produce.
    const line = formatTeamMemberships([
      membership({ teamId: 1, teamName: "Alpha" }),
      membership({ teamId: 1, teamName: "Beta", eventId: 7, eventName: "Springfield" }),
    ]);

    expect(line).toBe('Alpha (season roster; registered for "Springfield")');
    expect(line).not.toContain("Beta");
  });

  it("returns 'none' for a player on no team", () => {
    expect(formatTeamMemberships([])).toBe("none");
  });

  it("sanitizes the event name as well as the team name", () => {
    // Team names are scraped; event names are operator-supplied via `tn event add`. Both reach a TTY
    // here, so both go through `formatName` — the Trojan-Source class this module's header
    // documents. The event name is reaching terminal output for the first time in this change, so it
    // is the one with no prior coverage.
    const line = formatTeamMemberships([
      membership({ teamId: 1, teamName: `Team${ESC_BYTE}[2J`, eventId: 1, eventName: `Event${RLO_BYTE}Name` }),
    ]);

    expect(line).not.toMatch(CONTROL_OR_BIDI);
    expect(line).toContain("Team");
    expect(line).toContain("Event");
  });
});

// Issue #131, folded adjacent defect. Every player-creating path seeds an alias row equal to the new
// player's own canonical name (`src/ingest/identity.ts`, `src/ingest/disambiguate.ts`), because
// `player_aliases.name_key` is the lookup index `findPlayerByNameOrAlias` queries. Measured on the
// live database: 1745 players, 1745 alias rows, 1745 of them exactly equal to their own canonical
// name — so `tn player show` printed `Randy Burgess (aka Randy Burgess)` on EVERY profile and the
// suffix had never once carried information. The alias rows are correct and stay; the presenter is
// what must stop repeating the name it just printed.
describe("formatAliases", () => {
  it("returns null when the only alias is the player's own name (the 1745-of-1745 case)", () => {
    expect(formatAliases("Randy Burgess", ["Randy Burgess"])).toBeNull();
  });

  it("returns null for an alias differing only by case or surrounding whitespace", () => {
    // Folded with `nameKey` — the repo's single definition of "the same name" — rather than raw
    // string equality, so the suppression rule is the one the database itself keys by. A second
    // notion of sameness here is exactly the "one ladder, two notions of a name" defect #31 closed.
    expect(formatAliases("Randy Burgess", ["randy burgess"])).toBeNull();
    expect(formatAliases("Randy Burgess", ["  RANDY BURGESS  "])).toBeNull();
  });

  it("returns null for an alias differing only by an invisible character", () => {
    // The same fold that keeps `Versteeg` and `Versteeg<U+202E>` one identity in the database keeps
    // them one name here. Built from a code point, never written as a literal byte.
    expect(formatAliases("Randy Burgess", [`Randy Burgess${ZWSP_BYTE}`])).toBeNull();
  });

  it("keeps a genuinely different spelling", () => {
    expect(formatAliases("JT Martin", ["Jerry Martin"])).toBe("Jerry Martin");
  });

  it("drops the self-alias and keeps the real one from a mixed list", () => {
    expect(formatAliases("JT Martin", ["JT Martin", "Jerry Martin"])).toBe("Jerry Martin");
  });

  it("returns null for a player with no aliases at all", () => {
    expect(formatAliases("Nova Norbury", [])).toBeNull();
  });

  it("prints one entry for two alias rows whose spellings fold to the same name", () => {
    // Found by the adversarial pass at `verify`. `player_alias_unique` is on (`player_id`, `alias`)
    // — the RAW string — so the database permits this pair; only `recordAlias` rejects it, in
    // application code. No current writer produces one, which is exactly why it needs a test rather
    // than a live measurement: this presenter exists to stop printing one name twice, and it must
    // not do so for aliases either.
    expect(formatAliases("JT Martin", ["Jerry Martin", "jerry martin"])).toBe("Jerry Martin");
    expect(formatAliases("JT Martin", ["Jerry Martin", "  JERRY MARTIN  "])).toBe("Jerry Martin");
  });

  it("keeps two genuinely different aliases, in the order given", () => {
    // The refutation of the dedupe above: it must fold spellings, never distinct people's names.
    expect(formatAliases("JT Martin", ["Jerry Martin", "J. Martin"])).toBe("Jerry Martin, J. Martin");
  });

  it("sanitizes a surviving alias", () => {
    const rendered = formatAliases("JT Martin", [`Jerry${ESC_BYTE}[2JMartin`]);

    expect(rendered).not.toMatch(CONTROL_OR_BIDI);
    expect(rendered).toContain("Jerry");
  });
});

// ISS#172, Deliverable 1. `formatWtnProvenanceLine` renders a straddling roster as
// "published between 2026-08-05 and 2026-08-19" — a DATE RANGE, which reads as freshness. It is not
// a freshness range: ITF recalculated in between, so the two ends are different measurements. This
// line is the disclosure that says so, and it names who, because a reader holding a printed binder
// needs to know which cells are the odd ones.
describe("formatWtnScaleBreakLine (#172)", () => {
  const player = (name: string, source: RatingSource, observedOn: string, value = 25) => ({
    name,
    ratingTrajectory: [
      {
        source,
        latest: { id: 1, value, ratingType: null, observedOn },
        series: [{ id: 1, value, ratingType: null, observedOn }],
      },
    ],
  });

  it("HAPPY PATH: a roster all on the new scale gets no extra sentence", () => {
    const line = formatWtnScaleBreakLine([
      player("Ada Adair", "wtn_doubles", "2026-08-19"),
      player("Bo Byrne", "wtn_doubles", "2026-08-19"),
    ]);

    expect(line).toBeNull();
  });

  it("says nothing when there is no WTN on file at all", () => {
    expect(formatWtnScaleBreakLine([player("Ada Adair", "ntrp", "2026-01-08")])).toBeNull();
    expect(formatWtnScaleBreakLine([])).toBeNull();
  });

  it("PLANTED DEFECT: a straddling roster is disclosed, and the pre-rescale players are named", () => {
    const line = formatWtnScaleBreakLine([
      player("Ada Adair", "wtn_doubles", "2026-08-19"),
      player("Bo Byrne", "wtn_doubles", "2026-08-05"),
      player("Cy Chase", "wtn_doubles", "2026-08-05"),
    ]);

    expect(line).not.toBeNull();
    expect(line).toContain("not one scale");
    expect(line).toContain("Bo Byrne");
    expect(line).toContain("Cy Chase");
    expect(line).not.toContain("Ada Adair"); // the correctly-captured player is not implicated
  });

  it("PLANTED DEFECT: an undateable observation is described as such, not as pre-rescale", () => {
    // "predate the change" would be a claim the data does not support for a date inside the window.
    const line = formatWtnScaleBreakLine([
      player("Ada Adair", "wtn_doubles", "2026-08-19"),
      player("Bo Byrne", "wtn_doubles", "2026-08-12"),
    ]);

    expect(line).toContain("Bo Byrne");
    expect(line).not.toMatch(/Bo Byrne[^.]*predate/);
    expect(line).toContain("cannot be placed");
  });

  it("PLANTED DEFECT: both groups are named when both are present", () => {
    const line = formatWtnScaleBreakLine([
      player("Ada Adair", "wtn_doubles", "2026-08-19"),
      player("Bo Byrne", "wtn_doubles", "2026-08-05"),
      player("Cy Chase", "wtn_doubles", "2026-08-12"),
    ]);

    expect(line).toContain("predate");
    expect(line).toContain("cannot be placed");
    expect(line).toContain("Bo Byrne");
    expect(line).toContain("Cy Chase");
  });

  it("PLANTED DEFECT: an all-indeterminate roster is still disclosed", () => {
    // One era, and still not provably one scale — the clause most likely to be simplified away.
    const line = formatWtnScaleBreakLine([
      player("Ada Adair", "wtn_doubles", "2026-08-12"),
      player("Bo Byrne", "wtn_doubles", "2026-08-13"),
    ]);

    expect(line).not.toBeNull();
    expect(line).toContain("cannot be placed");
  });

  it("names a player once even when both WTN sources straddle", () => {
    // DUPLICATES: singles and doubles are two entries for one person; the sentence must not list
    // them twice.
    const line = formatWtnScaleBreakLine([
      player("Ada Adair", "wtn_doubles", "2026-08-19"),
      {
        name: "Bo Byrne",
        ratingTrajectory: [
          {
            source: "wtn_doubles" as RatingSource,
            latest: { id: 1, value: 29, ratingType: null, observedOn: "2026-08-05" },
            series: [{ id: 1, value: 29, ratingType: null, observedOn: "2026-08-05" }],
          },
          {
            source: "wtn_singles" as RatingSource,
            latest: { id: 2, value: 30, ratingType: null, observedOn: "2026-08-05" },
            series: [{ id: 2, value: 30, ratingType: null, observedOn: "2026-08-05" }],
          },
        ],
      },
    ]);

    expect(line?.match(/Bo Byrne/g)).toHaveLength(1);
  });

  it("ignores a non-USTA-widget WTN source, which had no 2026-08 recalculation", () => {
    const line = formatWtnScaleBreakLine([
      player("Ada Adair", "wtn_doubles", "2026-08-19"),
      player("Bo Byrne", "tr_dynamic", "2026-08-05"),
    ]);

    expect(line).toBeNull();
  });
});

describe("formatWtnScaleBreakLine — name lists read as prose (#172)", () => {
  const p = (name: string, observedOn: string) => ({
    name,
    ratingTrajectory: [
      {
        source: "wtn_doubles" as RatingSource,
        latest: { id: 1, value: 25, ratingType: null, observedOn },
        series: [{ id: 1, value: 25, ratingType: null, observedOn }],
      },
    ],
  });

  it("renders one, two and three names the way a sentence does", () => {
    const one = formatWtnScaleBreakLine([p("Ada Adair", "2026-08-19"), p("Bo Byrne", "2026-08-05")]);
    expect(one).toContain("the number shown for Bo Byrne predates");

    const two = formatWtnScaleBreakLine([
      p("Ada Adair", "2026-08-19"),
      p("Bo Byrne", "2026-08-05"),
      p("Cy Chase", "2026-08-05"),
    ]);
    expect(two).toContain("the numbers shown for Bo Byrne and Cy Chase predate");

    const three = formatWtnScaleBreakLine([
      p("Ada Adair", "2026-08-19"),
      p("Bo Byrne", "2026-08-05"),
      p("Cy Chase", "2026-08-05"),
      p("Di Dane", "2026-08-05"),
    ]);
    expect(three).toContain("the numbers shown for Bo Byrne, Cy Chase and Di Dane predate");
  });
});
