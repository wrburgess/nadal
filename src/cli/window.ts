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

/** Brands `SeasonWindow` so only `seasonWindow` below can build one. A REAL symbol, matching the
 * `ResolvedEventFormat` precedent in src/query/lineup.ts: a type-only brand vanishes at runtime and
 * would not stop a hand-built literal. Not exported, so no caller outside this module can name the
 * key, and a `const` symbol is `unique symbol`, so none can forge it structurally either. */
const seasonWindowBrand = Symbol("seasonWindow");

/**
 * A season, resolved once: the inclusive lower bound to filter by, and the label to print beside
 * the resulting numbers.
 *
 * **One object rather than two parameters, for a reason a plain pair could not carry.** As loose
 * `{ since, season }` arguments, a caller could hand the report writers `since: "2025-01-01"` with
 * `season: "2026"` — the dossier would then be filtered to 2025 and titled 2026, with every number
 * on the page correct for a season the page does not name. The CLI and MCP callers happened to
 * derive both from one anchor, but nothing in the API required it, so one fact could split into two
 * disagreeing keys at the report boundary. (Codex adversarial review of PR #91, Finding 2 [medium].)
 */
export type SeasonWindow = {
  /** Inclusive lower bound, `YYYY-01-01`. */
  readonly since: string;
  /** Display label for that season, `YYYY`. */
  readonly label: string;
  readonly [seasonWindowBrand]: true;
};

/** Resolve an anchor into the one object that carries both the boundary and its label. */
export function seasonWindow(anchor: SeasonAnchor = new Date()): SeasonWindow {
  const year = String(anchorYear(anchor)).padStart(4, "0");
  return Object.freeze({ since: `${year}-01-01`, label: year, [seasonWindowBrand]: true as const });
}
