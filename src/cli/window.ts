// The evidence window `player show`/`team show`/`report build` all pass as `windowedRecord`'s
// `since`, and the label they print beside the resulting number — computed here, in the ONE place a
// clock is read, rather than duplicated at each call site. `derive.ts` and `src/report/*.ts` stay
// clock-free on purpose (Task 3/7: derived metrics are pure functions, and rendering must be
// deterministic given a profile), and this is the seam where an anchor enters the system, for a
// caller that hands the result straight to `getPlayerProfile`/`getTeamProfile`'s `options.since`.
//
// Issue #122: **"season" was the wrong axis.** The predecessor here (issue #90) filtered to the
// anchor's CALENDAR YEAR — the unit TennisRecord itself models — and that fixed #90's own defect
// (a rolling six months made the binder thinnest on the day it is used). But a calendar year is a
// SHARED boundary across every team, and the five Sectionals teams did not all play their qualifying
// seasons in the same calendar year: OK and IA played fall 2025, HOA/NE/STL played winter/spring
// 2026. Anchored to 2026, the binder silently deleted OK's and IA's seasons — 14 of 38 team matches —
// while leaving the other three intact, with nothing on the page saying so. Anchoring to 2025 instead
// would simply have inverted which three teams read `0-0`; no single YEAR can cover a field whose
// qualifying seasons land in two different ones.
//
// The fix is a **12-month lookback**, not a calendar boundary: `since` is exactly one year before the
// anchor day, inclusive, so RECENCY — not administrative-season membership — is what decides what
// counts. Measured on the same database, this bound keeps 38 of 38 team matches (every team's record
// becomes true) versus 24 of 38 under the 2026 calendar-year boundary it replaces. It keeps issue
// #90's own no-drift-with-print-date property: the anchor is still an EVENT's `starts_on` when the
// caller has one, or the caller's clock otherwise — never the day the command happens to run.
//
// The window carries exactly ONE degree of freedom, same discipline as the season predecessor:
// `EvidenceWindow = { anchorDay }`, a single validated `YYYY-MM-DD` string. `since` and the printed
// label are BOTH derived from one read of that field (`windowSnapshot`), so they cannot diverge —
// there is no second field for a forged clone to disagree with (PR #91's review, restated below).
//
// KNOWN LIMITATION, by construction, restated for the new bound: candidate 1 (this design) splits no
// team's season IN THE CURRENT DATA — nothing on file straddles the 12-month cut. A team whose season
// ran, say, August through October relative to the anchor WOULD be cut by it; that is a property of
// the field observed at assessment time, not a guarantee this design makes for every possible season
// shape. Representing "the season a match belongs to" exactly would mean storing it at ingest and
// filtering by season id — issue #90's Option C, and #122's Option 2 — deliberately not built on
// speculation.
//
// UTC throughout, and the 12-month subtraction is TEXTUAL, never `Date` arithmetic: a local-timezone
// read would make the boundary depend on the invoking machine's TZ (the nondeterminism report
// rendering must avoid), and `Date`-based year subtraction on a Feb 29 anchor is exactly the kind of
// silent-rollover hazard `isIsoDay` (src/query/iso-day.ts) exists to catch elsewhere in this codebase.
// `since` is derived by decrementing the anchor's year as TEXT and clamping `02-29` to `02-28` when
// the target year is not a leap year (it never is, for a Feb-29 anchor — see `twelveMonthsBefore`'s
// own comment) — never by constructing a `Date` and asking it to subtract a year.

import { isIsoDay } from "../query/iso-day.js";

/** What an evidence window can be anchored to: an instant, or the `YYYY-MM-DD` text `events.starts_on`
 * holds. */
export type WindowAnchor = Date | string;

/** True for a year divisible by 4, except a century year not divisible by 400 — the ordinary
 * Gregorian rule. Exported nowhere: `twelveMonthsBefore` is the only caller. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The inclusive lower bound exactly 12 months before `anchorDay` — TEXTUAL year decrement, never
 * `Date` arithmetic, so there is no timezone or rollover drift to reason about. `anchorDay` is
 * assumed already validated (`isIsoDay`) by the ONE caller, `windowSnapshot`.
 *
 * `02-29` clamps to `02-28` when the target year is not a leap year. In practice that is EVERY Feb-29
 * anchor: under the Gregorian rule two leap years are never adjacent (the minimum spacing is 4 years,
 * and `year` and `year - 1` cannot both be divisible by 4), so the year immediately before a Feb-29
 * anchor is always non-leap. The check is still written generally, against the target year's own
 * leap-ness, rather than an unconditional clamp — the general rule is what the domain actually is,
 * and hard-coding "always clamp" would be true today by an argument a future reader has to re-derive
 * from scratch rather than read off the code.
 */
function twelveMonthsBefore(anchorDay: string): string {
  const year = Number(anchorDay.slice(0, 4));
  const monthDay = anchorDay.slice(5); // "MM-DD"
  const targetYear = year - 1;
  const clamped = monthDay === "02-29" && !isLeapYear(targetYear) ? "02-28" : monthDay;
  return `${String(targetYear).padStart(4, "0")}-${clamped}`;
}

/** `anchor` reduced to a `YYYY-MM-DD` day string — the shape `EvidenceWindow.anchorDay` carries.
 *
 * A `Date` is converted via its UTC components, which is always a well-formed calendar day UNLESS
 * the instant itself is invalid (`NaN`) — in which case every component is `NaN` too, producing a
 * string that fails `windowSnapshot`'s `isIsoDay` check downstream (e.g. `"0NaN-NaN-NaN"`). That is
 * deliberate: there is exactly ONE validation point (`windowSnapshot`), so an invalid `Date` fails
 * closed there rather than needing a second, separate check here that could drift from the first.
 *
 * A string is passed through UNVALIDATED — validating here as well as in `windowSnapshot` would be
 * the same rule written twice, and `windowSnapshot` is what every caller (including a hand-built,
 * possibly-forged `EvidenceWindow`) is guaranteed to go through before `since`/`label` are derived.
 */
function anchorDayOf(anchor: WindowAnchor): string {
  if (typeof anchor === "string") return anchor;
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + 1;
  const d = anchor.getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * An evidence window, resolved once and carrying ONE degree of freedom: the anchor day.
 *
 * **Two fields were the defect, not two callers** (season predecessor, PR #91's review). Storing
 * `since` and `label` side by side let `Object.assign({}, evidenceWindow("2025-06-01"), { label:
 * "2026" })` copy a mismatched clone with no cast, filtering to one window while printing another.
 * Storing only the anchor day means there is no second field to disagree with — the boundary and the
 * label below are DERIVED from this one value, so they cannot diverge.
 */
export type EvidenceWindow = {
  /** The window's anchor day, `YYYY-MM-DD` — validated by `windowSnapshot`, not here (see
   * `anchorDayOf`'s doc comment for why validation lives at exactly one point). */
  readonly anchorDay: string;
};

/** Resolve an anchor into the evidence window it belongs to. */
export function evidenceWindow(anchor: WindowAnchor = new Date()): EvidenceWindow {
  return Object.freeze({ anchorDay: anchorDayOf(anchor) });
}

/** An evidence window read ONCE and validated: the plain primitives every consumer should work
 * from. */
export type WindowSnapshot = {
  readonly anchorDay: string;
  /** The inclusive lower bound to filter by — 12 months before `anchorDay`. */
  readonly since: string;
  /** The window's display label, printed beside every record the boundary above filters:
   * `"12mo to <anchorDay>"`, never a bare year. */
  readonly label: string;
};

/**
 * Read an `EvidenceWindow` once, validate it, and hand back plain primitives.
 *
 * **Reading it more than once is the defect** (season predecessor, PR #91's fix-verification pass).
 * `EvidenceWindow` is a structural type, so a caller can supply an accessor rather than a data
 * property: with `get anchorDay() { return ++n <= 2 ? "2025-08-28" : "2026-08-28" }`, a consumer that
 * reads `.anchorDay` once for the boundary and again for the label would filter to one window and
 * print another. A type cannot prevent that; reading once can.
 *
 * **And an unvalidated anchor day fails OPEN, not closed.** `played_on` is compared lexically as
 * text, so a malformed value can silently admit every row (a value that sorts below every real date)
 * or exclude everything (a value that sorts above every real date) instead of refusing. Exact
 * `/^\d{4}-\d{2}-\d{2}$/` shape AND a real-calendar-day round-trip (`isIsoDay`, shared with every
 * other writer in this codebase that stores a date as text and later compares it as text) — or
 * refuse.
 */
export function windowSnapshot(window: EvidenceWindow): WindowSnapshot {
  const anchorDay = window.anchorDay; // read ONCE — every value below derives from this single read
  if (!isIsoDay(anchorDay)) {
    throw new Error(
      `unusable evidence window anchor: ${JSON.stringify(anchorDay)} (expected a real YYYY-MM-DD date)`,
    );
  }
  return Object.freeze({ anchorDay, since: twelveMonthsBefore(anchorDay), label: `12mo to ${anchorDay}` });
}

/** Convenience: the inclusive lower bound for an anchor, in one call — `windowSnapshot(evidenceWindow(anchor)).since`. */
export function windowStart(anchor: WindowAnchor = new Date()): string {
  return windowSnapshot(evidenceWindow(anchor)).since;
}

/** Convenience: the display label for an anchor, in one call — `windowSnapshot(evidenceWindow(anchor)).label`. */
export function windowLabel(anchor: WindowAnchor = new Date()): string {
  return windowSnapshot(evidenceWindow(anchor)).label;
}

/** Convenience: the inclusive lower bound for an already-resolved window. */
export function windowSince(window: EvidenceWindow): string {
  return windowSnapshot(window).since;
}
