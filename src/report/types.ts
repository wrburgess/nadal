// The renderer input shape shared by `html.ts` and `markdown.ts` (Task 7). A "dossier" is a
// TeamProfile PLUS a full PlayerProfile per roster member — `TeamProfile.roster` (Task 4) is
// deliberately thin (`RosterMemberProfile` has no rating trajectory, no partner frequency; see its
// doc comment in src/query/team-profile.ts), but the dossier's roster table and per-player blocks
// need exactly that richer data (spec § Deliverables #1: "NTRP + rating type, WTN singles/doubles,
// TennisRecord dynamic rating; ... partner frequency"). Assembling one is `src/report/write.ts`'s
// job (Task 8: fetch the team profile, then `getPlayerProfile` for each roster member); this module
// only names the shape both renderers consume, so their tests can hand-build one directly rather
// than standing up a DB (the same "pure function, hand-built input" discipline `derive.ts` uses).

import type { EventAvailability } from "../query/availability.js";
import type { CaptainNotesView } from "../query/captain-notes.js";
import type { LineupPlan } from "../query/lineup.js";
import type { PlayerProfile } from "../query/player-profile.js";
import type { TeamProfile } from "../query/team-profile.js";

/**
 * Spec § Deliverables #2, the "own-team book": the same cold data as any dossier PLUS Randy's
 * subjective layer. Present only on the HOME team's dossier — `captain_notes` and `availability` are
 * "populated for our team only, by design" (spec § Domain model), so an opponent's dossier carries
 * `null` here rather than an empty book, which would imply we simply hadn't filled theirs in.
 */
export type OwnTeamBook = {
  /**
   * `null` when the build named no event. Availability is per-event-DAY, so with no event there is
   * no day range to render a grid over — and an empty grid would read as "nobody is available"
   * rather than "you did not name an event". Both renderers must say which of the two it is.
   */
  availability: EventAvailability | null;
  notes: CaptainNotesView;
};

export type TeamDossier = {
  /** The 12-month evidence window every windowed record in this dossier was filtered to, as a
   * display label ("12mo to 2026-08-28") — issue #122, superseding #90's bare calendar-year label.
   * It rides on the VIEW rather than being recomputed per renderer, so the HTML and the markdown can
   * never label the same numbers with different windows, and so `src/report/*` stays clock-free (the
   * anchor is chosen once, by `report build`). */
  window: string;
  /** The event this build was scoped to, or `null` when none was named (#97). Carried on the VIEW,
   * like `window`, so both renderers name the same event beside the same evidence scope — and so a
   * renderer never has to reach into `lineup.slotEvent` for it, which is a different field about a
   * different thing (which event supplied the COURT SET) and is `null` whenever the lineup is. */
  event: { id: number; name: string } | null;
  /** `team.rosterSource`, copied onto the VIEW at construction (#113) — the same reason `window`
   * and `event` sit here rather than being re-derived by each renderer: a renderer reads this
   * field, not `team.rosterSource` directly, so the two can never be filled in independently and
   * drift. Set once, in `write.ts`'s `buildTeamDossier`, from the value `team` itself carries. */
  rosterSource: "registered" | "season";
  team: TeamProfile;
  /** One full profile per `team.roster` member, in the SAME order — a renderer that zips the two
   * arrays by index relies on this, so `write.ts` must preserve `team.roster`'s order when building
   * `players`. */
  players: PlayerProfile[];
  /**
   * The predicted lineup (#17 PR B) — spec § Deliverables #1's "predicted lineup honestly labeled a
   * guess", which belongs IN the dossier rather than only behind `tn lineup plan`.
   *
   * `null` means the team has no court-match history to predict from (`getLineupPlan` throws
   * `NoCourtMatchHistoryError`, which `write.ts` catches). Both renderers must print that absence
   * explicitly: an omitted section is indistinguishable from a section nobody thought to add, and a
   * silently-empty lineup would read as "we predict nobody plays".
   */
  lineup: LineupPlan | null;
  /**
   * The own-team book (#126) — `null` on every dossier but the home team's. Computed once in
   * `write.ts` and carried on the VIEW for the same reason `window` and `event` are: two renderers
   * reading one field cannot disagree about what the captain recorded, whereas two renderers each
   * reaching for the data would eventually drift.
   */
  ownTeam: OwnTeamBook | null;
};
