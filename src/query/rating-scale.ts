/**
 * Whether two World Tennis Numbers are points on the same axis (#172).
 *
 * ITF recalculated the World Tennis Number during the week of 2026-08-10 — a rolling three-year
 * window, score-within-set weighting, a reworked junior curve, and drift for the inactive. The
 * result is not an offset that can be applied locally: measured on this repository's own field,
 * doubles fell 4.36 and singles 1.27, so ranks genuinely reorder and Iowa's first doubles player
 * became their fourth. A pre-change and a post-change number printed in one column are two different
 * measurements wearing the same units.
 *
 * `src/query/derive.ts` already refuses to rank across rating SOURCES, and says why: *"a
 * `tr_dynamic` of 3.67 and an `ntrp` of 4.0 are not points on the same axis, and mixing them would
 * silently present players by which source happened to be scraped for them."* That reasoning now
 * applies WITHIN `wtn_doubles`, and nothing enforced it there. This module is that enforcement.
 *
 * WHY A WINDOW AND NOT A CUTOVER DATE. Two facts are provable and no more: every observation dated
 * `2026-08-05` is pre-recalculation — all 133 rows predating the re-pull carry it — and every
 * observation dated `2026-08-19` is post-, because the value audit re-read all 52 saved pages
 * without nadal's parser and got 91 agree / 0 mismatch against the new-scale widget. The exact day
 * ITF's recalculation reached any given player is not recorded anywhere we can read. A single
 * constant would have to assert that day; a window says what was measured and treats the gap as
 * unknown.
 *
 * THE LIMIT, STATED HERE RATHER THAN DISCOVERED LATER. This answers *"are these numbers comparable
 * to each other"*, which `observed_on` can decide. It does NOT answer *"is this number current"*,
 * which `observed_on` structurally cannot — it is the publisher's date, not ours (#132). And an
 * UNDECLARED future rescale is invisible to it: the window below would still describe the 2026-08
 * break while a later one went unnoticed, and that direction fails open. The durable fix for both
 * is a `captured_at` column distinct from `observed_on` — ISS#171.
 */

export type WtnScaleEra = "pre-rescale" | "post-rescale" | "indeterminate";

export type WtnRescaleWindow = {
  /** The latest date proven to carry pre-recalculation numbers. Inclusive. */
  lastKnownPre: string;
  /** The earliest date proven to carry post-recalculation numbers. Inclusive. */
  firstKnownPost: string;
};

/**
 * The 2026-08 recalculation, as measured. Both endpoints are dates this repository verified against
 * source pages, not inferred from ITF's announcement — which named a week, not a day.
 */
export const WTN_RESCALE: WtnRescaleWindow = {
  lastKnownPre: "2026-08-05",
  firstKnownPost: "2026-08-19",
};

/**
 * A strict ISO `YYYY-MM-DD` check, because `rating_observations.observed_on` is an unconstrained
 * TEXT column and a lexical comparison on a malformed value is worse than no comparison at all:
 * `"2026-8-5" > "2026-08-19"` is true as a string, so an unpadded pre-rescale date would compare as
 * post-rescale. Round-tripping through `Date` also rejects a well-shaped impossibility like
 * `2026-02-30`, which the pattern alone accepts.
 */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Which side of the recalculation an observation falls on, or `indeterminate` when that cannot be
 * decided — inside the window, blank, or not a real date. Every unknown resolves to
 * `indeterminate`, never to a guess.
 */
export function wtnScaleEra(observedOn: string, window: WtnRescaleWindow = WTN_RESCALE): WtnScaleEra {
  if (!isIsoDate(observedOn)) return "indeterminate";
  if (observedOn <= window.lastKnownPre) return "pre-rescale";
  if (observedOn >= window.firstKnownPost) return "post-rescale";
  return "indeterminate";
}

/** The distinct eras present in a set of observation dates. */
export function wtnErasIn(observedOns: string[], window: WtnRescaleWindow = WTN_RESCALE): Set<WtnScaleEra> {
  return new Set(observedOns.map((observedOn) => wtnScaleEra(observedOn, window)));
}

/**
 * Whether a set of WTN observations is NOT provably one comparable scale.
 *
 * True when the set holds more than one era, and ALSO when it holds any `indeterminate` — including
 * the case where every member is indeterminate. That last clause is the one most likely to look
 * like a bug and be "simplified" away: a roster whose dates all sit inside the unknown window shows
 * exactly one era, and is still not provably comparable, because the window is precisely the span
 * where two dates can straddle the recalculation. Absence of evidence is not comparability, so it
 * fails closed.
 *
 * An empty set does not span — there is nothing to be incomparable with, and a roster with no WTN
 * on file is a different condition that its own caller already reports.
 */
export function spansWtnScaleBreak(observedOns: string[], window: WtnRescaleWindow = WTN_RESCALE): boolean {
  if (observedOns.length === 0) return false;
  const eras = wtnErasIn(observedOns, window);
  return eras.size > 1 || eras.has("indeterminate");
}
