// The season boundary `player show`/`team show`/`report build` all pass as `windowedRecord`'s
// `since`, and the label they print beside the resulting number — computed here, in the ONE place a
// clock is read, rather than duplicated at each call site. `derive.ts` and `src/report/*.ts` stay
// clock-free on purpose (Task 3/7: derived metrics are pure functions, and rendering must be
// deterministic given a profile), and this is the seam where an anchor enters the system, for a
// caller that hands the result straight to `getPlayerProfile`/`getTeamProfile`'s `options.since`.
//
// A **season is a calendar year** (issue #90). The predecessor here was a rolling six months, which
// tied every printed record to the print date: a USTA league season runs in the spring, so measured
// on the real HOA/Burgess-Zingg team, 5 of 8 matches were visible on 2026-08-03 and only 2 of 8
// would be visible on the day of Sectionals — the binder was thinnest on the day it is used, and
// said nothing about the three-quarters of a season it had dropped. A calendar year is also the
// unit the upstream source models: every TennisRecord team URL carries `?year=2026`, and the roster
// table's own column header is `2026Record`.
//
// KNOWN LIMITATION, by construction: a season that straddles New Year (starting Nov, finishing Mar)
// is split in two by this boundary. No league on file does that, and TennisRecord's `year=`
// parameter says the source does not model one either. Making it representable means storing the
// season on ingest and filtering by season id rather than by date — Option C of issue #90's
// assessment, deliberately not built on speculation.
//
// UTC throughout: a local-timezone read would make the boundary depend on the invoking machine's
// TZ, which is exactly the kind of nondeterminism the report renderers are required to avoid
// (spec § Reports: "deterministic rendering from DB state").

/** What a season can be anchored to: an instant, or the `YYYY-MM-DD` text `events.starts_on` holds. */
export type SeasonAnchor = Date | string;

function anchorYear(anchor: SeasonAnchor): number {
  const date = typeof anchor === "string" ? new Date(`${anchor}T00:00:00Z`) : anchor;
  // Refuse rather than fall back. A malformed `events.starts_on` that quietly resolved to the
  // current season would reproduce this issue's own defect — a boundary that reads as anchored to
  // the event and is not — with nothing on the page to show it happened.
  if (Number.isNaN(date.getTime())) {
    throw new Error(`unusable season anchor: ${JSON.stringify(anchor)}`);
  }
  return date.getUTCFullYear();
}

/** The inclusive lower bound of the anchor's season: `YYYY-01-01`. */
export function seasonStart(anchor: SeasonAnchor = new Date()): string {
  return `${String(anchorYear(anchor)).padStart(4, "0")}-01-01`;
}

/** The season's display name, printed beside every record the boundary above filters. */
export function seasonLabel(anchor: SeasonAnchor = new Date()): string {
  return String(anchorYear(anchor)).padStart(4, "0");
}

/**
 * A season, resolved once and carrying ONE degree of freedom: the year.
 *
 * **Two fields were the defect, not two callers.** The first attempt at this type stored `since`
 * and `label` together and branded the pair, so only the factory could build one. A review showed
 * the brand was decoration: the symbol key is enumerable, so
 * `Object.assign({}, seasonWindow("2025-06-01"), { label: "2026" })` copies it onto a mismatched
 * clone with no cast, and the report writers would then filter to 2025 while printing "2026" —
 * every number correct for a season the page does not name. A runtime `WeakSet` guard would have
 * rejected that clone; storing the year instead means **there is no second field to disagree
 * with**, so no guard, no brand, and no forged object can express the illegal state at all.
 * (Codex adversarial review of PR #91, then its fix-verification pass on that fix.)
 *
 * The boundary and the label are DERIVED below — both from this one value, so they cannot diverge.
 */
export type SeasonWindow = {
  /** The season's calendar year, `YYYY`. */
  readonly year: string;
};

/** Resolve an anchor into the season it belongs to. */
export function seasonWindow(anchor: SeasonAnchor = new Date()): SeasonWindow {
  return { year: String(anchorYear(anchor)).padStart(4, "0") };
}

/** The inclusive lower bound to filter by: the season's January 1. */
export function seasonWindowSince(window: SeasonWindow): string {
  return `${window.year}-01-01`;
}
