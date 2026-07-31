// The "six months back" boundary `player show`/`team show`/`report build` all pass as
// `windowedRecord`'s `since` — computed once here, in the ONE place a clock is read, rather than
// duplicated at each call site. `derive.ts` and `src/report/*.ts` stay clock-free on purpose (Task
// 3/7: derived metrics are pure functions, and rendering must be deterministic given a profile) —
// this is the seam where "now" enters the system, for a caller that hands the result straight to
// `getPlayerProfile`/`getTeamProfile`'s `options.since`, itself just a plain ISO date string.
//
// UTC throughout: a local-timezone subtraction would make the exact boundary depend on the
// invoking machine's TZ, which is exactly the kind of nondeterminism the report renderers are
// required to avoid (spec § Reports: "deterministic rendering from DB state").
export function sixMonthsAgo(now: Date = new Date()): string {
  const boundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, now.getUTCDate()));
  return boundary.toISOString().slice(0, 10);
}
