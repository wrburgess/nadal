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
