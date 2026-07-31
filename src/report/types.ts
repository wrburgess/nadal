// The renderer input shape shared by `html.ts` and `markdown.ts` (Task 7). A "dossier" is a
// TeamProfile PLUS a full PlayerProfile per roster member — `TeamProfile.roster` (Task 4) is
// deliberately thin (`RosterMemberProfile` has no rating trajectory, no partner frequency; see its
// doc comment in src/query/team-profile.ts), but the dossier's roster table and per-player blocks
// need exactly that richer data (spec § Deliverables #1: "NTRP + rating type, WTN singles/doubles,
// TennisRecord dynamic rating; ... partner frequency"). Assembling one is `src/report/write.ts`'s
// job (Task 8: fetch the team profile, then `getPlayerProfile` for each roster member); this module
// only names the shape both renderers consume, so their tests can hand-build one directly rather
// than standing up a DB (the same "pure function, hand-built input" discipline `derive.ts` uses).

import type { PlayerProfile } from "../query/player-profile.js";
import type { TeamProfile } from "../query/team-profile.js";

export type TeamDossier = {
  team: TeamProfile;
  /** One full profile per `team.roster` member, in the SAME order — a renderer that zips the two
   * arrays by index relies on this, so `write.ts` must preserve `team.roster`'s order when building
   * `players`. */
  players: PlayerProfile[];
};
