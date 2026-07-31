// The six derived metrics (spec § Interfaces: "One service layer, three thin presenters"),
// plus `teamMatchRecord` — a small seventh needed to keep `team-profile.ts` thin (see its doc
// comment in types.ts). Every function here is PURE: plain row arrays in, a typed result out, no
// `db` argument. This is where every correctness rule from docs/findings.md (#15) lives, because
// it is the layer that can be tested exhaustively with hand-built inputs a real fixture can't
// exhibit.

import type {
  CourtMatchRow,
  DataGapsInput,
  DataGapsResult,
  HeadToHeadResult,
  PartnerFrequencyEntry,
  RatingObservationRow,
  RatingSeriesPoint,
  RatingTrajectoryResult,
  Side,
  SlotTendency,
  TeamMatchRecordOptions,
  TeamMatchRecordResult,
  TeamMatchRow,
  WindowedRecordOptions,
  WindowedRecordResult,
} from "./types.js";

/**
 * A player's win/loss/undecided record over `rows`, computed RELATIVE TO the player's own
 * `participants[].side` on each row — never against a literal "home" — per docs/findings.md
 * (#15): "home"/"visiting" are pull-perspective labels, not real home/away, so a Home/Away column
 * would be wrong on its face. See the perspective-invariance test in
 * `test/query-derive.test.ts`, which is this rule made executable.
 *
 * A doubles match counts ONCE for the player (one row = one court match), regardless of how many
 * other participants share it — this falls out naturally from iterating `rows`, not participants.
 */
export function windowedRecord(
  rows: CourtMatchRow[],
  playerId: number,
  options: WindowedRecordOptions = {},
): WindowedRecordResult {
  const { since, discipline } = options;
  let wins = 0;
  let losses = 0;
  let undecided = 0;
  let excludedUndated = 0;

  for (const row of rows) {
    if (discipline !== undefined && row.discipline !== discipline) continue;
    const self = row.participants.find((p) => p.playerId === playerId);
    if (self === undefined) continue;

    if (row.playedOn === null) {
      excludedUndated++;
      continue;
    }
    // Inclusive lower bound (`playedOn >= since`): a row played exactly on `since` counts.
    if (since !== undefined && row.playedOn < since) continue;

    if (row.winnerSide === null) {
      undecided++;
    } else if (row.winnerSide === self.side) {
      wins++;
    } else {
      losses++;
    }
  }

  return { wins, losses, undecided, excludedUndated };
}

/** Per-slot counts for the rows a player participated in, descending by count, ties broken by
 * slot name ascending — deterministic regardless of input order. An unenumerated slot value (the
 * schema comment only names S1/D1-D4) is carried through like any other, never dropped. */
export function slotTendencies(rows: CourtMatchRow[], playerId: number): SlotTendency[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.participants.some((p) => p.playerId === playerId)) continue;
    counts.set(row.slot, (counts.get(row.slot) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([slot, count]) => ({ slot, count }))
    .sort((a, b) => b.count - a.count || a.slot.localeCompare(b.slot));
}

/**
 * Doubles-only partner counts: for each row the player was in, every OTHER participant on the
 * player's own side counts as a partner — "however many", never `[0]`/`[1]` (docs/findings.md,
 * #15: `upsertCourtMatchPlayers` never deletes, so a superseded participant from a corrected
 * source page can leave 1, 3, or more on a side).
 */
export function partnerFrequency(rows: CourtMatchRow[], playerId: number): PartnerFrequencyEntry[] {
  const counts = new Map<number, number>();
  for (const row of rows) {
    if (row.discipline !== "doubles") continue;
    const self = row.participants.find((p) => p.playerId === playerId);
    if (self === undefined) continue;
    const partners = row.participants.filter((p) => p.side === self.side && p.playerId !== playerId);
    for (const partner of partners) {
      counts.set(partner.playerId, (counts.get(partner.playerId) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([partnerId, count]) => ({ partnerId, count }))
    .sort((a, b) => b.count - a.count || a.partnerId - b.partnerId);
}

/**
 * One result per requested `opponentId`, in the given order — including an explicit zero row for
 * an opponent never met, rather than omitting them (a missing entry would be indistinguishable
 * from "never queried"). A row only counts toward an opponent if that opponent is on the OPPOSING
 * side from the player in that row; an opponent id that happens to share the player's own side
 * (a doubles partner) is not a meeting.
 */
export function headToHead(rows: CourtMatchRow[], playerId: number, opponentIds: number[]): HeadToHeadResult[] {
  const results = new Map<number, HeadToHeadResult>();
  for (const opponentId of opponentIds) {
    results.set(opponentId, { opponentId, wins: 0, losses: 0, undecided: 0, matches: 0 });
  }

  for (const row of rows) {
    const self = row.participants.find((p) => p.playerId === playerId);
    if (self === undefined) continue;
    const opposingParticipants = row.participants.filter((p) => p.side !== self.side);
    for (const opponent of opposingParticipants) {
      const entry = results.get(opponent.playerId);
      if (entry === undefined) continue; // not one of the requested opponents
      entry.matches++;
      if (row.winnerSide === null) entry.undecided++;
      else if (row.winnerSide === self.side) entry.wins++;
      else entry.losses++;
    }
  }

  return opponentIds.map((id) => results.get(id)!);
}

/**
 * One entry per rating source that has at least one observation — a source with none is simply
 * absent, never a zero-value placeholder (that distinction is what lets a TennisRecord-only
 * player's WTN/NTRP sections read "absent" rather than "0.0"). Each source's series is ordered by
 * `observedOn` ascending; same-date observations break the tie by `id` ascending (higher id =
 * written later), which is deterministic independent of the array's input order — real pulls
 * can't produce a same-date duplicate for one player/source (`rating_obs_unique` is a DB unique
 * index on exactly that triple), but this function is pure and hand-built test inputs can, so it
 * still has to resolve deterministically rather than throw or pick arbitrarily.
 */
export function ratingTrajectory(observations: RatingObservationRow[]): RatingTrajectoryResult {
  const bySource = new Map<string, RatingObservationRow[]>();
  for (const obs of observations) {
    const list = bySource.get(obs.source);
    if (list === undefined) bySource.set(obs.source, [obs]);
    else list.push(obs);
  }

  const toPoint = (o: RatingObservationRow): RatingSeriesPoint => ({
    id: o.id,
    value: o.value,
    ratingType: o.ratingType,
    observedOn: o.observedOn,
  });

  const result: RatingTrajectoryResult = [];
  for (const [source, obsList] of bySource) {
    const series = [...obsList]
      .sort((a, b) => (a.observedOn !== b.observedOn ? (a.observedOn < b.observedOn ? -1 : 1) : a.id - b.id))
      .map(toPoint);
    const latest = series[series.length - 1];
    if (latest === undefined) continue; // unreachable: bySource never holds an empty list
    result.push({ source, latest, series });
  }

  // Deterministic across sources too, rather than depending on Map insertion order (which here
  // tracks the input array's order).
  return result.sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * Maps each named section's `{ count, hasWriter }` to a status. The whole point (docs/findings.md,
 * #15/Task 3 rule 6) is that `hasWriter: false` and `count: 0` must NOT collapse to the same
 * status: an empty tournament-results table reads as "this player has no results" (confidently
 * wrong when the truth is "nothing has ever tried to collect this"), so the two are kept visibly
 * distinct — "not-collected" vs "empty" — rather than both reading as an empty section.
 */
export function dataGaps(counts: DataGapsInput): DataGapsResult {
  const result: DataGapsResult = {};
  for (const [key, section] of Object.entries(counts)) {
    if (!section.hasWriter) result[key] = "not-collected";
    else if (section.count === 0) result[key] = "empty";
    else result[key] = "has-data";
  }
  return result;
}

/**
 * The team-level analog of `windowedRecord`'s perspective rule: `home_team_id`/`visiting_team_id`
 * and the courts-won columns are ALSO pull-perspective labels (docs/findings.md, #15's note on
 * `team_matches`), so a team's record is computed relative to which side ITS OWN id occupies on
 * each row, never by trusting "home" to mean anything about venue.
 */
export function teamMatchRecord(
  rows: TeamMatchRow[],
  teamId: number,
  options: TeamMatchRecordOptions = {},
): TeamMatchRecordResult {
  const { since } = options;
  let wins = 0;
  let losses = 0;
  let undecided = 0;
  let excludedUndated = 0;

  for (const row of rows) {
    let ourSide: Side;
    if (row.homeTeamId === teamId) ourSide = "home";
    else if (row.visitingTeamId === teamId) ourSide = "visiting";
    else continue; // this row isn't one of the team's matches at all

    if (row.playedOn === null) {
      excludedUndated++;
      continue;
    }
    if (since !== undefined && row.playedOn < since) continue;

    const { homeCourtsWon, visitingCourtsWon } = row;
    if (homeCourtsWon === null || visitingCourtsWon === null || homeCourtsWon === visitingCourtsWon) {
      undecided++;
      continue;
    }
    const ourCourts = ourSide === "home" ? homeCourtsWon : visitingCourtsWon;
    const theirCourts = ourSide === "home" ? visitingCourtsWon : homeCourtsWon;
    if (ourCourts > theirCourts) wins++;
    else losses++;
  }

  return { wins, losses, undecided, excludedUndated };
}
