// Hand-built `TeamDossier` fixtures shared by `test/report-html.test.ts` and
// `test/report-markdown.test.ts` — both renderers consume the same shape (src/report/types.ts), so
// one builder keeps the two suites from drifting apart on what a "full" or "empty" dossier looks
// like. Every field a renderer might touch is present, following the same hand-built-input
// discipline `test/query-derive.test.ts` uses rather than routing through a real DB.

import type { LineupPlan, LineupSlotProvenance } from "../../src/query/lineup.js";
import type { PlayerProfile } from "../../src/query/player-profile.js";
import type { TeamProfile } from "../../src/query/team-profile.js";
import type { EvidenceScopeSummary } from "../../src/query/types.js";
import type { TeamDossier } from "../../src/report/types.js";

/**
 * The default evidence scope for a hand-built fixture: NONE applied (#97), which is what a dossier
 * built without naming an event genuinely reports. A renderer must print that state explicitly — an
 * unscoped dossier and a scoped one have to be distinguishable on the page — so this is a real
 * default rather than a placeholder, and the scoped case is passed in per test.
 */
export function buildEvidenceScope(overrides: Partial<EvidenceScopeSummary> = {}): EvidenceScopeSummary {
  return {
    scope: null,
    considered: 12,
    retained: 12,
    excluded: 0,
    unclassified: 0,
    retainedLeagues: [{ league: "Adult 40+ 3.5", count: 12 }],
    ...overrides,
  };
}

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
      season: { wins: 3, losses: 1, undecided: 0, excludedUndated: 0 },
      allTime: { wins: 10, losses: 4, undecided: 0, excludedUndated: 0 },
    },
    doublesRecord: overrides.doublesRecord ?? {
      season: { wins: 1, losses: 2, undecided: 0, excludedUndated: 0 },
      allTime: { wins: 5, losses: 6, undecided: 0, excludedUndated: 0 },
    },
    slotTendencies: overrides.slotTendencies ?? [{ slot: "S1", count: 4 }],
    partnerFrequency: overrides.partnerFrequency ?? [{ partnerId: 2, count: 3, canonicalName: "Kai Kestrel" }],
    teamMemberships: overrides.teamMemberships ?? [],
    dataGaps: overrides.dataGaps ?? { events: "not-collected", availability: "not-collected", captainNotes: "not-collected" },
    evidenceScope: overrides.evidenceScope ?? buildEvidenceScope(),
  };
}

export function buildTeamProfile(overrides: Partial<TeamProfile> = {}): TeamProfile {
  return {
    teamId: 1,
    teamName: "IA/Versteeg/40&Over3.5M",
    isHome: overrides.isHome ?? false,
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
    evidenceScope: overrides.evidenceScope ?? buildEvidenceScope(),
    ...overrides,
  };
}

/** A predicted lineup with one settled partnership, one thin one, and one player left over — so a
 * renderer test exercises the confident, the low-confidence and the not-placed paths at once
 * (#17 PR B). Pass `lineup: null` to `buildDossier` for the no-history case instead. */
/**
 * `provenance` is a SEPARATE parameter rather than part of `overrides` because `LineupPlan`'s
 * `slotSource`/`slotEvent` pair is a discriminated union (#63): a loose `Partial<LineupPlan>` spread
 * could set one half without the other, which is exactly the invalid state the union exists to make
 * unrepresentable. Passing the pair whole means a test cannot build a plan the production code could
 * never produce.
 */
export function buildLineupPlan(
  overrides: Partial<Omit<LineupPlan, "slotSource" | "slotEvent">> = {},
  provenance: LineupSlotProvenance = { slotSource: "observed", slotEvent: null },
): LineupPlan {
  return {
    teamId: 1,
    teamName: "Test Team",
    slots: [
      {
        slot: "S1",
        discipline: "singles",
        players: [{ playerId: 1, canonicalName: "Ada Ashby" }],
        confidence: "high",
        basis: "history",
        support: 6,
      },
      {
        slot: "D1",
        discipline: "doubles",
        players: [
          { playerId: 2, canonicalName: "Bo Bramwell" },
          { playerId: 3, canonicalName: "Cy Calder" },
        ],
        confidence: "high",
        basis: "history",
        support: 5,
      },
      {
        slot: "D2",
        discipline: "doubles",
        players: [
          { playerId: 4, canonicalName: "Del Duxbury" },
          { playerId: 5, canonicalName: "Emory Ellerby" },
        ],
        confidence: "low",
        basis: "rating",
        support: 0,
      },
    ],
    unplaced: [{ playerId: 6, canonicalName: "Ira Inglewood", courtMatches: 1 }],
    ratingSource: "ntrp",
    ranked: [
      { playerId: 1, canonicalName: "Ada Ashby" },
      { playerId: 2, canonicalName: "Bo Bramwell" },
      { playerId: 3, canonicalName: "Cy Calder" },
      { playerId: 4, canonicalName: "Del Duxbury" },
      { playerId: 5, canonicalName: "Emory Ellerby" },
    ],
    unranked: [{ playerId: 6, canonicalName: "Ira Inglewood" }],
    observedCourtMatches: 12,
    excludedOtherTeamMatches: 0,
    rosterSize: 6,
    ...overrides,
    ...provenance,
  };
}

export function buildDossier(overrides: Partial<TeamDossier> = {}): TeamDossier {
  return {
    // A fixed season, so a renderer test never depends on the year the suite is run in — the very
    // print-date coupling issue #90 removed from the product.
    season: overrides.season ?? "2026",
    // No event named by default, matching the default evidence scope above — a fixture whose scope
    // says "none applied" must not simultaneously claim an event supplied one.
    event: overrides.event ?? null,
    team: overrides.team ?? buildTeamProfile(),
    players: overrides.players ?? [buildPlayerProfile()],
    lineup: overrides.lineup === undefined ? buildLineupPlan() : overrides.lineup,
  };
}

/** A dossier with every derived section genuinely empty (no matches, no ratings, no roster) —
 * distinct from `dataGaps` reporting "not-collected": here the sections exist and simply have zero
 * results, which must still render a valid document rather than crash. */
export function buildEmptyDossier(): TeamDossier {
  return {
    season: "2026",
    event: null,
    team: buildTeamProfile({
      evidenceScope: buildEvidenceScope({ considered: 0, retained: 0, retainedLeagues: [] }),
      roster: [],
      teamRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
      slotTendencies: [],
      headToHead: null,
    }),
    players: [],
    // No roster and no matches means nothing to predict from — the same `null` `buildTeamDossier`
    // produces when `getLineupPlan` refuses.
    lineup: null,
  };
}
