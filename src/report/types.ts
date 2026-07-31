// The renderer input shape shared by `html.ts` and `markdown.ts` (Task 7). A "dossier" is a
// TeamProfile PLUS a full PlayerProfile per roster member — `TeamProfile.roster` (Task 4) is
// deliberately thin (`RosterMemberProfile` has no rating trajectory, no partner frequency; see its
// doc comment in src/query/team-profile.ts), but the dossier's roster table and per-player blocks
// need exactly that richer data (spec § Deliverables #1: "NTRP + rating type, WTN singles/doubles,
// TennisRecord dynamic rating; ... partner frequency"). Assembling one is `src/report/write.ts`'s
// job (Task 8: fetch the team profile, then `getPlayerProfile` for each roster member); this module
// only names the shape both renderers consume, so their tests can hand-build one directly rather
// than standing up a DB (the same "pure function, hand-built input" discipline `derive.ts` uses).

import type { LineupPlan } from "../query/lineup.js";
import type { PlayerProfile } from "../query/player-profile.js";
import type { TeamProfile } from "../query/team-profile.js";

export type TeamDossier = {
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
};
