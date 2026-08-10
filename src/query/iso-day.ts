// The one definition of "is this a real YYYY-MM-DD calendar date", shared by every writer that
// stores a date as TEXT and later compares it as TEXT.
//
// It matters because SQLite compares these columns lexically: any malformed string that merely
// SORTS inside a range matches that range and is stored verbatim. `"2026-08-28 "`,
// `"2026-08-28xyz"` and `"2026-08-2900"` each sort beside the real `"2026-08-28"`, so an
// unnormalized value silently splits one day across rows and invents days no per-day read will ever
// match — the `upsertTeamMatch` shape docs/findings.md records four review rounds on, a key
// assembled without normalizing its input domain.
//
// This module exports a PREDICATE rather than a throwing guard on purpose: `availability.ts` and
// `events.ts` each raise their own distinct error class (the convention set by PR A's Task 3 —
// assert on class, never on message text), and a shared throw would have forced them to share one
// class or to catch-and-rethrow. Sharing the *rule* is what prevents drift; sharing the *error* is
// what would erase a caller's taxonomy.

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for a real `YYYY-MM-DD` calendar date.
 *
 * The pattern alone is not enough: `"2026-02-31"` matches it and is not a date. Round-tripping
 * through `Date` is what rejects that — a value JS either refuses outright (NaN) or silently rolls
 * forward into a different day, and a silent roll-forward is precisely the quiet substitution this
 * guard exists to prevent.
 */
export function isIsoDay(day: string): boolean {
  if (!ISO_DAY_PATTERN.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === day;
}

/**
 * Every calendar day from `startsOn` to `endsOn`, inclusive at both ends — the same inclusivity
 * `eventsForDay` uses when it decides which event a day belongs to, so a day this function emits is
 * always a day that function would have matched.
 *
 * It lives here, beside `isIsoDay`, because it is the same rule seen from the other side: that
 * predicate says what a day IS, this says what lies between two of them, and a range enumerated by
 * a different notion of "day" than the one the writers validate against could produce a column no
 * stored row can ever fill.
 *
 * Returns `[]` rather than throwing when either endpoint is not a real day, or when the range runs
 * backwards. A caller reading an `events` row cannot assume its TEXT columns hold valid dates — the
 * table predates `isIsoDay` — and the honest answer for an unusable range is "no days", which a
 * renderer already has to handle for an event with no dates at all.
 *
 * Stepping is done in UTC milliseconds, never by mutating a local-time `Date`: `setDate()` on a
 * local-zone date lands on the wrong day across a DST boundary, which would drop or duplicate a
 * tournament day for anyone running this in a zone that observes it.
 */
export function enumerateIsoDays(startsOn: string, endsOn: string): string[] {
  if (!isIsoDay(startsOn) || !isIsoDay(endsOn)) return [];
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  const end = Date.parse(`${endsOn}T00:00:00Z`);
  if (start > end) return [];

  const days: string[] = [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (let t = start; t <= end; t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}
