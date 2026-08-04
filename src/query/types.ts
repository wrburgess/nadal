// Presenter-agnostic types for the derived-metrics layer (`derive.ts`) and the DB assembly layer
// (`player-profile.ts` / `team-profile.ts`). Spec § Interfaces: "One service layer, three thin
// presenters" — CLI (#16), MCP (#17), the printed binder (#19) all consume these same shapes.
//
// `home`/`visiting` throughout this module are PULL-PERSPECTIVE labels, never real home/away
// (docs/findings.md, #15: "Pulling two opposing teams rewrites the labels to the later pull's
// perspective … Phase 4 must not read them as real home/away"). Every shape below that carries a
// side keeps it as an opaque `Side` marker so a caller cannot mistake it for a venue column, and
// every derive.ts function that consumes one computes outcomes RELATIVE to a given player's or
// team's own side rather than trusting "home" to mean anything absolute.

import type { EventCourt } from "./event-format.js";
import type { LeagueScope } from "./league-scope.js";

export type Side = "home" | "visiting";

// TennisRecord's slot/discipline vocabulary is not closed here on purpose — `derive.ts`'s
// correctness rules require an unenumerated value (e.g. a stray "D4") to be carried through
// rather than dropped, so these stay open string types rather than a literal union.
export type Discipline = "singles" | "doubles" | string;

/** One participant on one side of one court match. */
export type CourtMatchParticipant = {
  playerId: number;
  side: Side;
};

/**
 * A single court match, pre-joined with EVERY one of its participants — however many.
 * `upsertCourtMatchPlayers` never deletes (docs/findings.md, #15), so a source correction can
 * leave a side with 1, 3, or more participants attached; `derive.ts` never indexes into
 * `participants` by position ([0]/[1]) for exactly this reason.
 */
export type CourtMatchRow = {
  id: number;
  slot: string;
  discipline: Discipline;
  winnerSide: Side | null;
  playedOn: string | null;
  participants: CourtMatchParticipant[];
};

/** One surviving `league_context` value and how many retained court matches carry it. `league` is
 * `null` for the unclassified bucket, which is a real category rather than a missing value — see
 * `leagueScopeRetains`. */
export type RetainedLeagueEntry = {
  league: string | null;
  count: number;
};

/**
 * What a court-match read actually drew on (#97) — returned alongside the rows by
 * `courtMatchRowsForPlayers`, and carried onto every profile that derives from them.
 *
 * This exists because #97's scope item 3 is not optional: a filtered record that does not say what
 * it filtered, or what it still contains, is the same class of problem the issue was opened for.
 * Every field here answers one of those two questions, and `retainedLeagues` in particular is why
 * the counts are not enough on their own — after `exclude:Mixed`, between 37% and 69% of the
 * REMAINING evidence is still out-of-league (Adult 18+ 3.5, Adult 55+ 7.0/8.0, Tri-Level, Combo …),
 * an accepted residual that the dossier states concretely from this breakdown rather than as a
 * hardcoded sentence that would rot the moment the data moved.
 *
 * `scope: null` is a REPORTED state, not an absence: an unscoped read must be distinguishable from a
 * scoped one on the page, or a reader cannot tell a dossier that counts every league from one that
 * does not.
 */
export type EvidenceScopeSummary = {
  /** The scope applied, or `null` when the read was unscoped (every league counted). */
  scope: LeagueScope | null;
  /** Court matches fetched before the scope was applied — `retained + excluded`. */
  considered: number;
  retained: number;
  /** Never inferred by subtracting elsewhere: the number this read set aside, stated by the read
   * that did it. `0` whenever `scope` is `null`. */
  excluded: number;
  /** Retained rows with no `league_context` on file. A subset of `retained`, not a third bucket:
   * a scope removes only what it can positively classify (`leagueScopeRetains`), so these survive
   * either mode — and are counted here so "retained" never quietly means "retained, plus some we
   * could not classify". */
  unclassified: number;
  /** Every distinct `league_context` among RETAINED rows, by descending count then ascending name,
   * with the unclassified (`null`) bucket last so a real league never sorts behind it. */
  retainedLeagues: RetainedLeagueEntry[];
};

export type WindowedRecordOptions = {
  /** Inclusive lower bound on `playedOn` (ISO date string, e.g. "2026-01-01"). Omit for all-time. */
  since?: string;
  discipline?: Discipline;
};

export type WindowedRecordResult = {
  wins: number;
  losses: number;
  /** `winnerSide === null` — never counted as a loss (Task 3 correctness rule 3). */
  undecided: number;
  /** Rows with `playedOn === null`: excluded from the window AND counted here, never silently
   * dropped (Task 3 correctness rule 5). */
  excludedUndated: number;
};

export type SlotTendency = {
  slot: string;
  count: number;
};

export type PartnerFrequencyEntry = {
  partnerId: number;
  count: number;
};

export type HeadToHeadResult = {
  opponentId: number;
  wins: number;
  losses: number;
  undecided: number;
  matches: number;
};

export type RatingSource = "ntrp" | "wtn_singles" | "wtn_doubles" | "tr_dynamic" | string;

export type RatingObservationRow = {
  id: number;
  source: RatingSource;
  value: number;
  ratingType: string | null;
  observedOn: string;
};

export type RatingSeriesPoint = {
  id: number;
  value: number;
  ratingType: string | null;
  observedOn: string;
};

export type RatingTrajectoryEntry = {
  source: RatingSource;
  latest: RatingSeriesPoint;
  /** Ordered by `observedOn` ascending, tie-broken by `id` ascending — deterministic regardless
   * of the input array's order (Task 3: "two observations sharing a date broken deterministically"). */
  series: RatingSeriesPoint[];
};

/** One entry per source WITH at least one observation. A source with none is simply absent from
 * the array — never a zero-value placeholder entry (Task 3: "a source with no observations absent
 * from the result without throwing"). */
export type RatingTrajectoryResult = RatingTrajectoryEntry[];

export type SectionCount = {
  count: number;
  /** Whether ANY writer in the codebase can populate this section at all. `false` here is a static
   * fact about the codebase (docs/findings.md, #15: `events`/`availability`/`captain_notes` are
   * never written by `team-pull.ts`, which passes `eventId: null`), not something inferred from
   * `count`. */
  hasWriter: boolean;
};

export type DataGapsInput = Record<string, SectionCount>;

export type SectionStatus =
  | "not-collected" // no writer exists at all — report "not collected yet", never an empty table
  | "empty" // a writer exists; this query just returned zero rows
  | "has-data";

export type DataGapsResult = Record<string, SectionStatus>;

/**
 * A team_matches row, in the plain shape `teamMatchRecord` needs. Not one of the plan's six named
 * derive functions, but the same perspective-relative correctness rule applies at the team level —
 * `home_team_id`/`visiting_team_id` and the courts-won columns are ALSO pull-perspective labels,
 * not venue (docs/findings.md, #15's note on `team_matches`). Keeping this logic in `derive.ts`
 * (rather than inline in `team-profile.ts`) is what Task 4's "keep the assembly layer thin — all
 * logic lives in derive.ts" actually requires once a team-level record is needed.
 */
export type TeamMatchRow = {
  id: number;
  homeTeamId: number;
  visitingTeamId: number;
  homeCourtsWon: number | null;
  visitingCourtsWon: number | null;
  playedOn: string | null;
};

export type TeamMatchRecordOptions = {
  since?: string;
};

export type TeamMatchRecordResult = {
  wins: number;
  losses: number;
  /** No result recorded (a bye/unplayed fixture with null court counts, or a tie) — never a loss. */
  undecided: number;
  excludedUndated: number;
};

// ---------------------------------------------------------------------------
// Predicted lineup (#17 PR B) — spec § Deliverables 1's "predicted lineup honestly labeled a
// guess". Every field below exists to keep the *guess* legible: a caller can render confidence,
// say what the placement was based on, name the rating scale it ranked within, and show who was
// left over. A shape that returned only `slot -> players` would read as fact.
// ---------------------------------------------------------------------------

/** From the count of observations behind a placement: `high` >= 5, `medium` 2-4, `low` <= 1. */
export type LineupConfidence = "high" | "medium" | "low";

/** Whether the placement came from observed history or from the rating fallback that fills gaps.
 * Distinct from `confidence`, because a `low`-confidence historical placement (two shared matches)
 * and a `low`-confidence invented one (no shared matches at all) are different claims. */
export type LineupBasis = "history" | "rating";

export type PredictedLineupSlot = {
  slot: string;
  /** Read from the observed rows for this slot, never inferred from the slot's spelling. */
  discipline: Discipline;
  /** One id for a singles slot, two for doubles — FEWER when the roster ran out, which is reported
   * as a short/empty slot rather than by omitting the slot. */
  playerIds: number[];
  confidence: LineupConfidence;
  basis: LineupBasis;
  /** Observations behind this placement: the player's singles court-match count for a singles
   * slot, the pair's shared-match count for a doubles slot, `0` for a rating-only placement. */
  support: number;
};

export type UnplacedPlayer = {
  playerId: number;
  /** Their evidence volume, so "not placed" can be read as "thin history" rather than "cut". */
  courtMatches: number;
};

export type PredictedLineupInput = {
  /** Court matches involving this team's players. Rows nobody on the roster took part in are
   * ignored rather than rejected — a caller may legitimately hand over a wider row set. */
  rows: CourtMatchRow[];
  rosterPlayerIds: number[];
  ratings: { playerId: number; observations: RatingObservationRow[] }[];
  /** An event's own court list (#63), when the caller has one. Present -> REPLACES the derived slot
   * set: `slotOrder` becomes this list's order verbatim (not the observed-discipline ranking),
   * each slot's discipline comes from here rather than from observed rows, and `slotSource` becomes
   * `"event-format"`. Absent -> today's behavior, unchanged: the slot set is derived from observed
   * history and `slotSource` stays `"observed"`. An explicit empty array throws rather than silently
   * falling back to the derived set — unreachable through `event-format.ts`'s own writer, which
   * refuses an empty format, but guarded here too since this function is pure and callable directly. */
  slotSet?: EventCourt[];
};

export type PredictedLineupResult = {
  slots: PredictedLineupSlot[];
  unplaced: UnplacedPlayer[];
  /** The single source every comparison was made within, or `null` when nobody is rated. Ranking
   * across sources is not sound — a `tr_dynamic` value and an `ntrp` value are not the same axis. */
  ratingSource: RatingSource | null;
  /** Roster players ranked within `ratingSource`, strongest first. */
  rankedPlayerIds: number[];
  /** Roster players with no observation in `ratingSource` — ranked last, and named so the gap is
   * visible rather than implicit in the ordering. */
  unrankedPlayerIds: number[];
  /** Where the slot set came from (#63). `"observed"` — derived from this team's own court-match
   * history, same as before this field gained a second member. `"event-format"` — supplied by a
   * named event's format (`PredictedLineupInput.slotSet`), which replaces the derived set outright.
   * See `predictedLineup`'s doc comment. */
  slotSource: "observed" | "event-format";
  /** How many court matches the whole guess rests on. */
  observedCourtMatches: number;
};
