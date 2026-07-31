// Hand-built `TeamDossier` fixtures shared by `test/report-html.test.ts` and
// `test/report-markdown.test.ts` — both renderers consume the same shape (src/report/types.ts), so
// one builder keeps the two suites from drifting apart on what a "full" or "empty" dossier looks
// like. Every field a renderer might touch is present, following the same hand-built-input
// discipline `test/query-derive.test.ts` uses rather than routing through a real DB.

import type { PlayerProfile } from "../../src/query/player-profile.js";
import type { TeamProfile } from "../../src/query/team-profile.js";
import type { TeamDossier } from "../../src/report/types.js";

export function buildPlayerProfile(overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    identity: {
      playerId: 1,
      canonicalName: "Nova Norbury",
      aliases: [],
      ageRange: "40-49",
      gender: "M",
      ustaUaid: null,
      wtnTennisId: null,
      tennisrecordUrl: null,
      ...overrides.identity,
    },
    ratingTrajectory: overrides.ratingTrajectory ?? [
      { source: "ntrp", latest: { id: 1, value: 4.0, ratingType: "C", observedOn: "2026-01-01" }, series: [] },
      { source: "tr_dynamic", latest: { id: 2, value: 4.1, ratingType: null, observedOn: "2026-06-01" }, series: [] },
    ],
    singlesRecord: overrides.singlesRecord ?? {
      sixMonth: { wins: 3, losses: 1, undecided: 0, excludedUndated: 0 },
      allTime: { wins: 10, losses: 4, undecided: 0, excludedUndated: 0 },
    },
    doublesRecord: overrides.doublesRecord ?? {
      sixMonth: { wins: 1, losses: 2, undecided: 0, excludedUndated: 0 },
      allTime: { wins: 5, losses: 6, undecided: 0, excludedUndated: 0 },
    },
    slotTendencies: overrides.slotTendencies ?? [{ slot: "S1", count: 4 }],
    partnerFrequency: overrides.partnerFrequency ?? [{ partnerId: 2, count: 3, canonicalName: "Kai Kestrel" }],
    teamMemberships: overrides.teamMemberships ?? [],
    dataGaps: overrides.dataGaps ?? { events: "not-collected", availability: "not-collected", captainNotes: "not-collected" },
  };
}

export function buildTeamProfile(overrides: Partial<TeamProfile> = {}): TeamProfile {
  return {
    teamId: 1,
    teamName: "IA/Versteeg/40&Over3.5M",
    roster: overrides.roster ?? [
      {
        playerId: 1,
        canonicalName: "Nova Norbury",
        ageRange: "40-49",
        singlesRecord: { wins: 3, losses: 1, undecided: 0, excludedUndated: 0 },
        doublesRecord: { wins: 1, losses: 2, undecided: 0, excludedUndated: 0 },
        slotTendencies: [{ slot: "S1", count: 4 }],
      },
    ],
    teamRecord: overrides.teamRecord ?? { wins: 5, losses: 2, undecided: 0, excludedUndated: 0 },
    slotTendencies: overrides.slotTendencies ?? [{ slot: "S1", count: 4 }],
    headToHead: overrides.headToHead ?? null,
    ...overrides,
  };
}

export function buildDossier(overrides: Partial<TeamDossier> = {}): TeamDossier {
  return {
    team: overrides.team ?? buildTeamProfile(),
    players: overrides.players ?? [buildPlayerProfile()],
  };
}

/** A dossier with every derived section genuinely empty (no matches, no ratings, no roster) —
 * distinct from `dataGaps` reporting "not-collected": here the sections exist and simply have zero
 * results, which must still render a valid document rather than crash. */
export function buildEmptyDossier(): TeamDossier {
  return {
    team: buildTeamProfile({
      roster: [],
      teamRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
      slotTendencies: [],
      headToHead: null,
    }),
    players: [],
  };
}
