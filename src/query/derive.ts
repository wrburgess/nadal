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
  Discipline,
  HeadToHeadResult,
  LineupBasis,
  LineupConfidence,
  PartnerFrequencyEntry,
  PredictedLineupInput,
  PredictedLineupResult,
  PredictedLineupSlot,
  RatingObservationRow,
  RatingSeriesPoint,
  RatingSource,
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

// ---------------------------------------------------------------------------
// The predicted-lineup heuristic (#17 PR B).
//
// Spec § Deliverables 1 asks for "a predicted lineup honestly labeled a guess"; spec § Open
// questions listed "how court-assignment history + ratings become a labeled guess" as unsettled.
// The HC settled it on issue #17: **pair-first, then tendency, with ratings breaking every tie and
// filling every gap.** Doubles partnerships are the sticky unit on a 40+ league team, so a
// per-player tendency rule can invent a pairing that has never played together even when the roster
// has obvious regular pairs — see the load-bearing test in `test/query-derive-lineup.test.ts`.
//
// There is no real data on this project yet (#27 is still blocked, no pull has ever run), so the
// rule is *stated* here and in the tests rather than tuned against observation. When Springfield
// data lands, the rule can be judged against it and revised as a documented change.
//
// Everything below is deterministic: every ordering ends in an explicit tie-breaker on `playerId`
// or slot name, so the result never depends on the input array's order.
// ---------------------------------------------------------------------------

/** A team with no court-match history at all: refused, rather than given an empty guess that would
 * read as "we predict nobody plays". */
export class NoCourtMatchHistoryError extends Error {}

/** Ranked ahead of one another when coverage ties. Ordering across DIFFERENT sources is never
 * attempted — see `rankRoster`. */
const RATING_SOURCE_PRECEDENCE: RatingSource[] = ["tr_dynamic", "ntrp", "wtn_doubles", "wtn_singles"];

/** WTN runs the other way from NTRP and TennisRecord's dynamic rating: a LOWER World Tennis Number
 * is the stronger player. Sorting every source descending would silently rank a WTN roster
 * backwards — the strongest player would be predicted last. */
const INVERTED_RATING_SOURCES = new Set<RatingSource>(["wtn_singles", "wtn_doubles"]);

const HIGH_CONFIDENCE_SUPPORT = 5;
const MEDIUM_CONFIDENCE_SUPPORT = 2;
/** A pairing seen once is a coincidence, not a partnership. */
const MIN_PARTNERSHIP_COUNT = 2;

function confidenceFor(support: number): LineupConfidence {
  if (support >= HIGH_CONFIDENCE_SUPPORT) return "high";
  if (support >= MEDIUM_CONFIDENCE_SUPPORT) return "medium";
  return "low";
}

/** `"D3"` -> 3; a slot with no trailing number sorts after the numbered ones rather than throwing
 * (derive.ts's standing rule: an unenumerated slot is data we do not understand, not data to
 * discard — see `slotTendencies`). */
function slotNumber(slot: string): number {
  const match = /(\d+)$/.exec(slot);
  return match === null ? Number.POSITIVE_INFINITY : Number(match[1]);
}

/** Singles slots first, then doubles, then anything else; within a group by trailing number, then
 * lexically. Grouped by the observed DISCIPLINE rather than by the slot's spelling, so the order
 * survives a source that names its courts something other than S1/D1. */
function disciplineRank(discipline: Discipline): number {
  if (discipline === "singles") return 0;
  if (discipline === "doubles") return 1;
  return 2;
}

/** An unordered pair of player ids, normalized so (3,2) and (2,3) are the same key. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

type PairCandidate = {
  low: number;
  high: number;
  count: number;
  /** Shared-match counts per slot, descending by count then by slot order. */
  bySlot: { slot: string; count: number }[];
};

/**
 * Ranks the roster within a SINGLE rating source — the one covering the most roster players, ties
 * broken by `RATING_SOURCE_PRECEDENCE`.
 *
 * Ranking across sources is not sound: a `tr_dynamic` of 3.67 and an `ntrp` of 4.0 are not points
 * on the same axis, and mixing them would silently order players by which source happened to be
 * scraped for them. Players with no observation in the chosen source are not guessed at — they all
 * share the rank immediately after the ranked players, and are named in `unrankedPlayerIds`.
 */
function rankRoster(input: PredictedLineupInput): {
  source: RatingSource | null;
  rankOf: Map<number, number>;
  ranked: number[];
  unranked: number[];
} {
  const roster = new Set(input.rosterPlayerIds);
  /** playerId -> source -> the latest observation's value. */
  const latest = new Map<number, Map<RatingSource, RatingObservationRow>>();
  for (const entry of input.ratings) {
    if (!roster.has(entry.playerId)) continue;
    const bySource = latest.get(entry.playerId) ?? new Map<RatingSource, RatingObservationRow>();
    for (const obs of entry.observations) {
      const current = bySource.get(obs.source);
      // Same "latest observation, ties by id ascending" rule `ratingTrajectory` uses, so the two
      // functions cannot disagree about which observation is current.
      const newer =
        current === undefined ||
        obs.observedOn > current.observedOn ||
        (obs.observedOn === current.observedOn && obs.id > current.id);
      if (newer) bySource.set(obs.source, obs);
    }
    latest.set(entry.playerId, bySource);
  }

  const coverage = new Map<RatingSource, number>();
  for (const bySource of latest.values()) {
    for (const source of bySource.keys()) coverage.set(source, (coverage.get(source) ?? 0) + 1);
  }

  const sources = Array.from(coverage.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const ai = RATING_SOURCE_PRECEDENCE.indexOf(a[0]);
    const bi = RATING_SOURCE_PRECEDENCE.indexOf(b[0]);
    // A source outside the declared precedence list still sorts deterministically, after the known
    // ones, rather than landing at index -1 and jumping to the front.
    const aRank = ai === -1 ? RATING_SOURCE_PRECEDENCE.length : ai;
    const bRank = bi === -1 ? RATING_SOURCE_PRECEDENCE.length : bi;
    if (aRank !== bRank) return aRank - bRank;
    return a[0].localeCompare(b[0]);
  });

  const source = sources[0]?.[0] ?? null;
  const sortedRoster = [...input.rosterPlayerIds].sort((a, b) => a - b);
  if (source === null) {
    // Nobody is rated: everyone shares one rank, so every downstream comparison falls through to
    // the playerId tie-breaker. Still deterministic, just uninformed.
    return { source: null, rankOf: new Map(sortedRoster.map((id) => [id, 0])), ranked: [], unranked: sortedRoster };
  }

  const inverted = INVERTED_RATING_SOURCES.has(source);
  const rated = sortedRoster.filter((id) => latest.get(id)?.has(source) === true);
  const unranked = sortedRoster.filter((id) => latest.get(id)?.has(source) !== true);

  const ranked = [...rated].sort((a, b) => {
    const av = latest.get(a)!.get(source)!.value;
    const bv = latest.get(b)!.get(source)!.value;
    if (av !== bv) return inverted ? av - bv : bv - av;
    return a - b;
  });

  const rankOf = new Map<number, number>();
  ranked.forEach((id, index) => rankOf.set(id, index));
  // One shared rank for everyone unrated, placed after every ranked player — not a per-player
  // guess, and finite so pair sums stay comparable.
  for (const id of unranked) rankOf.set(id, ranked.length);

  return { source, rankOf, ranked, unranked };
}

/**
 * Predicts how a team will field its courts, from court-assignment history plus ratings.
 *
 * The rule, in order:
 *  1. **Singles slots** go to the roster player with the most singles court matches; ties to the
 *     better rating rank, then to the lower `playerId`.
 *  2. **Pairs** are every unordered pair of roster players seen together on the same side of a
 *     doubles court at least `MIN_PARTNERSHIP_COUNT` times. Each contends for the slot it most
 *     often shared; a contested slot goes to the **better combined rating rank**, and the loser
 *     cascades to its own next-most-shared open slot, then to any open slot.
 *  3. **Leftovers** are paired by rating rank (best two remaining together) and placed in the
 *     remaining open slots, best pair to the earliest slot. These slots read `basis: "rating"`.
 *  4. Anyone still unplaced is **listed**, with their court-match count, never dropped; a slot with
 *     nobody left is reported short or empty rather than omitted.
 *
 * The **slot set is derived from observed history by default** — `input.slotSet` absent, exactly
 * today's behavior, `slotSource: "observed"`. **When `input.slotSet` is given (#63), it REPLACES the
 * derived set outright**: `slotOrder` becomes the given list's own order (not the observed-discipline
 * ranking below), each slot's discipline comes from the list rather than from observed rows, and
 * `slotSource` becomes `"event-format"`. An observed slot absent from the given set is simply not in
 * `slotOrder` — its players cascade through the ordinary leftover machinery like any other unplaced
 * pair; a format slot the team has never played is filled by the same rating-ranked leftover step
 * that already reports a slot "short or empty rather than omitted".
 *
 * Undated rows COUNT here, unlike in `windowedRecord` — a date window is meaningless without a
 * date, but court-assignment tendency has no window, so excluding them would discard real evidence.
 */
export function predictedLineup(input: PredictedLineupInput): PredictedLineupResult {
  const roster = new Set(input.rosterPlayerIds);
  if (roster.size === 0) {
    throw new NoCourtMatchHistoryError("no roster players to predict a lineup for");
  }
  if (input.slotSet !== undefined && input.slotSet.length === 0) {
    // Unreachable through `event-format.ts`'s own writer, which refuses an empty format before it
    // is ever stored — guarded anyway, since this function is pure and callable directly with any
    // input.
    throw new Error("predictedLineup: slotSet, when given, must not be empty");
  }

  // Only rows a roster player actually took part in, each reduced to that team's own participants.
  // A caller may hand over a wider row set (e.g. every court match touching any of these players'
  // opponents); rows belonging to nobody here are ignored rather than rejected.
  const ourRows = input.rows
    .map((r) => ({ row: r, ours: r.participants.filter((p) => roster.has(p.playerId)) }))
    .filter((r) => r.ours.length > 0);
  if (ourRows.length === 0) {
    throw new NoCourtMatchHistoryError("no court-match history on file for this roster");
  }

  const { source, rankOf, ranked, unranked } = rankRoster(input);
  const rankFor = (playerId: number): number => rankOf.get(playerId) ?? Number.MAX_SAFE_INTEGER;

  // --- the slot set, and each slot's discipline -----------------------------------------------
  const disciplineCounts = new Map<string, Map<Discipline, number>>();
  const courtMatchesByPlayer = new Map<number, number>();
  const singlesCounts = new Map<number, number>();
  const pairCounts = new Map<string, Map<string, number>>(); // pairKey -> slot -> count

  for (const { row, ours } of ourRows) {
    const perSlot = disciplineCounts.get(row.slot) ?? new Map<Discipline, number>();
    perSlot.set(row.discipline, (perSlot.get(row.discipline) ?? 0) + 1);
    disciplineCounts.set(row.slot, perSlot);

    for (const p of ours) {
      courtMatchesByPlayer.set(p.playerId, (courtMatchesByPlayer.get(p.playerId) ?? 0) + 1);
    }

    if (row.discipline === "singles") {
      for (const p of ours) singlesCounts.set(p.playerId, (singlesCounts.get(p.playerId) ?? 0) + 1);
      continue;
    }

    // Every pair of roster players on the SAME side counts as a partnership for this row — pairwise
    // rather than [0]/[1], because `upsertCourtMatchPlayers` never deletes and a side can carry
    // three or more participants after a source correction (docs/findings.md, #15).
    for (const side of ["home", "visiting"] as Side[]) {
      const sameSide = ours.filter((p) => p.side === side).map((p) => p.playerId);
      for (let i = 0; i < sameSide.length; i++) {
        for (let j = i + 1; j < sameSide.length; j++) {
          const key = pairKey(sameSide[i]!, sameSide[j]!);
          const bySlot = pairCounts.get(key) ?? new Map<string, number>();
          bySlot.set(row.slot, (bySlot.get(row.slot) ?? 0) + 1);
          pairCounts.set(key, bySlot);
        }
      }
    }
  }

  // The slot set and each slot's discipline: derived from OBSERVED history by default, or taken
  // verbatim from `input.slotSet` when the caller supplied one (#63) — see this function's own doc
  // comment for the full rule. `pairCounts`/`singlesCounts`/`courtMatchesByPlayer` above are always
  // built from observed rows regardless of which branch runs: an event's format supplies WHICH
  // courts exist and their discipline, never which players have played together.
  let slotOrder: string[];
  let slotDiscipline: Map<string, Discipline>;
  if (input.slotSet !== undefined) {
    slotOrder = input.slotSet.map((c) => c.slot);
    slotDiscipline = new Map(input.slotSet.map((c) => [c.slot, c.discipline as Discipline]));
  } else {
    slotDiscipline = new Map<string, Discipline>();
    for (const [slot, counts] of disciplineCounts) {
      const [best] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
      slotDiscipline.set(slot, best![0]);
    }
    slotOrder = Array.from(disciplineCounts.keys()).sort((a, b) => {
      const da = disciplineRank(slotDiscipline.get(a)!);
      const db = disciplineRank(slotDiscipline.get(b)!);
      if (da !== db) return da - db;
      const na = slotNumber(a);
      const nb = slotNumber(b);
      if (na !== nb) return na - nb;
      return a.localeCompare(b);
    });
  }
  const slotIndex = new Map(slotOrder.map((slot, i) => [slot, i]));
  // A slot's rank in `slotOrder`, or +Infinity when the slot is not in it at all. Once the slot set
  // can differ from the observed one (#63), a pair's OWN historical `bySlot` entries (built from
  // observed rows, below) can name a slot absent from `slotOrder` entirely — plain `slotIndex.get`
  // then yields `undefined`, and `undefined - number` is `NaN`, which is not a crash but a silently
  // UNSTABLE sort (Array.prototype.sort's behavior on a NaN-returning comparator is unspecified).
  // `slotRank` guarantees an absent slot always sorts LAST, deterministically, rather than sometimes
  // participating in the tie-break and sometimes not depending on input order.
  const slotRank = (slot: string): number => slotIndex.get(slot) ?? Number.POSITIVE_INFINITY;

  // --- placement -------------------------------------------------------------------------------
  const placed = new Map<string, { playerIds: number[]; support: number; basis: LineupBasis }>();
  const taken = new Set<number>();

  const place = (slot: string, playerIds: number[], support: number, basis: LineupBasis): void => {
    placed.set(slot, { playerIds, support, basis });
    for (const id of playerIds) taken.add(id);
  };

  // 1. Singles slots, in slot order.
  for (const slot of slotOrder) {
    if (slotDiscipline.get(slot) !== "singles") continue;
    const candidates = [...roster]
      .filter((id) => !taken.has(id))
      .sort((a, b) => {
        const ca = singlesCounts.get(a) ?? 0;
        const cb = singlesCounts.get(b) ?? 0;
        if (ca !== cb) return cb - ca;
        const ra = rankFor(a);
        const rb = rankFor(b);
        if (ra !== rb) return ra - rb;
        return a - b;
      });
    const pick = candidates[0];
    if (pick === undefined) continue; // roster exhausted — reported as an empty slot below
    const support = singlesCounts.get(pick) ?? 0;
    place(slot, [pick], support, support > 0 ? "history" : "rating");
  }

  // 2. Candidate partnerships, contending for the slot each most often shared.
  const candidatePairs: PairCandidate[] = Array.from(pairCounts.entries())
    .map(([key, bySlot]) => {
      const [low, high] = key.split(":").map(Number) as [number, number];
      const total = Array.from(bySlot.values()).reduce((sum, n) => sum + n, 0);
      const slots = Array.from(bySlot.entries())
        .map(([slot, count]) => ({ slot, count }))
        .sort((a, b) => b.count - a.count || slotRank(a.slot) - slotRank(b.slot));
      return { low, high, count: total, bySlot: slots };
    })
    .filter((p) => p.count >= MIN_PARTNERSHIP_COUNT);

  const combinedRank = (p: PairCandidate): number => rankFor(p.low) + rankFor(p.high);
  /** Better combined rating rank first; then the more-seen partnership; then by ids. */
  const byStrength = (a: PairCandidate, b: PairCandidate): number => {
    const ra = combinedRank(a);
    const rb = combinedRank(b);
    if (ra !== rb) return ra - rb;
    if (a.count !== b.count) return b.count - a.count;
    return a.low - b.low || a.high - b.high;
  };

  const pairAvailable = (p: PairCandidate): boolean => !taken.has(p.low) && !taken.has(p.high);
  const remainingPairs = new Set(candidatePairs);

  // 2a. Two orderings are in play and they are NOT the same one:
  //
  //   * WITHIN a slot, a collision is decided by the better combined rating rank — the rule the HC
  //     picked ("higher combined rating takes the better slot").
  //   * ACROSS slots, the more-established partnership goes first — "pair-first" means the strongest
  //     partnership gets first claim on its players, not that the earliest slot does.
  //
  // Walking `slotOrder` once conflates them, and gets the headline case wrong: a 4-match pairing
  // whose modal slot is D1 would claim a player out from under an 8-match pairing whose modal slot
  // is D2, purely because D1 sorts first — splitting exactly the partnership the pair-first rule
  // exists to protect (the load-bearing test in test/query-derive-lineup.test.ts).
  //
  // So each round asks every still-available pair for its CURRENT preference — its highest-count
  // slot among those still open — resolves each contested slot by combined rating rank, commits
  // only the single strongest proposal (partnership count decides which slot settles first), and
  // re-asks.
  //
  // "Current preference", not "modal slot", is the load-bearing part, and it is the second bug this
  // loop has had (found by the independent Codex review of PR #47, rated high). An earlier version
  // let each pair contend only for its MODAL slot and cascaded the losers afterwards, into whatever
  // was left, contesting nobody. That silently exempted cascaders from the collision rule: a pair
  // that lost D1 could not contend for D2 against D2's own claimant however much better its
  // combined rating, so a weaker pair kept a slot a stronger one had real history at. Re-deriving
  // the preference each round is what makes a cascade a genuine re-entry into contention rather
  // than a consolation placement.
  //
  // Terminates: every iteration either commits one pair (shrinking `remainingPairs`) or breaks.
  // The roster is at most a couple of dozen players, so the repeated pass is free.
  for (;;) {
    const openDoubles = new Set(
      slotOrder.filter((slot) => !placed.has(slot) && slotDiscipline.get(slot) !== "singles"),
    );
    const contendersBySlot = new Map<string, PairCandidate[]>();
    for (const pair of remainingPairs) {
      if (!pairAvailable(pair)) continue;
      // `bySlot` is already ordered by shared count descending, so the first still-open entry IS
      // this pair's best remaining historical slot.
      const preference = pair.bySlot.find((entry) => openDoubles.has(entry.slot));
      if (preference === undefined) continue; // nowhere it has ever played is open — handled below
      const list = contendersBySlot.get(preference.slot) ?? [];
      list.push(pair);
      contendersBySlot.set(preference.slot, list);
    }

    const proposals = Array.from(contendersBySlot.entries()).map(([slot, contenders]) => ({
      slot,
      pair: [...contenders].sort(byStrength)[0]!,
    }));
    if (proposals.length === 0) break;

    proposals.sort(
      (a, b) => b.pair.count - a.pair.count || byStrength(a.pair, b.pair) || slotRank(a.slot) - slotRank(b.slot),
    );
    const { slot, pair } = proposals[0]!;
    place(slot, [pair.low, pair.high], pair.count, "history");
    remainingPairs.delete(pair);
  }

  // 2b. Pairs with no open slot they have ever shared. They are still real partnerships, so they
  // take an open court ahead of the rating-built pairings below, and keep `basis: "history"`.
  for (const pair of Array.from(remainingPairs).sort(byStrength)) {
    if (!pairAvailable(pair)) {
      remainingPairs.delete(pair);
      continue;
    }
    const fallback = slotOrder.find((s) => !placed.has(s) && slotDiscipline.get(s) !== "singles");
    if (fallback === undefined) continue; // every slot filled — this pair falls through to `unplaced`
    place(fallback, [pair.low, pair.high], pair.count, "history");
    remainingPairs.delete(pair);
  }

  // 3. Leftovers, paired by rating rank: best two remaining together, best pair to the earliest
  // open slot.
  const leftovers = [...roster].filter((id) => !taken.has(id)).sort((a, b) => rankFor(a) - rankFor(b) || a - b);
  for (const slot of slotOrder) {
    if (placed.has(slot)) continue;
    const width = slotDiscipline.get(slot) === "singles" ? 1 : 2;
    const group = leftovers.splice(0, width);
    // An empty group still places the slot, so an unfilled court is reported rather than omitted.
    place(slot, group, 0, "rating");
  }

  const slots: PredictedLineupSlot[] = slotOrder.map((slot) => {
    const entry = placed.get(slot)!;
    return {
      slot,
      discipline: slotDiscipline.get(slot)!,
      playerIds: entry.playerIds,
      confidence: confidenceFor(entry.support),
      basis: entry.basis,
      support: entry.support,
    };
  });

  return {
    slots,
    unplaced: leftovers
      .slice()
      .sort((a, b) => a - b)
      .map((playerId) => ({ playerId, courtMatches: courtMatchesByPlayer.get(playerId) ?? 0 })),
    ratingSource: source,
    rankedPlayerIds: ranked,
    unrankedPlayerIds: unranked,
    slotSource: input.slotSet !== undefined ? "event-format" : "observed",
    observedCourtMatches: ourRows.length,
  };
}
