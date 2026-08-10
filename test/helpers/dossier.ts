// Hand-built `TeamDossier` fixtures shared by `test/report-html.test.ts` and
// `test/report-markdown.test.ts` — both renderers consume the same shape (src/report/types.ts), so
// one builder keeps the two suites from drifting apart on what a "full" or "empty" dossier looks
// like. Every field a renderer might touch is present, following the same hand-built-input
// discipline `test/query-derive.test.ts` uses rather than routing through a real DB.

import type { LineupPlan, LineupSlotProvenance } from "../../src/query/lineup.js";
import type { EvidenceWindowDisclosure, PlayerProfile } from "../../src/query/player-profile.js";
import type { TeamProfile } from "../../src/query/team-profile.js";
import type { EvidenceScopeSummary } from "../../src/query/types.js";
import type { OwnTeamBook, TeamDossier } from "../../src/report/types.js";

/** The default evidence-window disclosure for a hand-built fixture (#122 round-1 Finding 1) — the
 * same fixed anchor `buildDossier`'s own `window` string label already uses ("12mo to 2026-08-28"),
 * so the two agree by construction rather than by two independent hardcoded strings. */
export function buildEvidenceWindow(overrides: Partial<EvidenceWindowDisclosure> = {}): EvidenceWindowDisclosure {
  return { anchorDay: "2026-08-28", since: "2025-08-28", label: "12mo to 2026-08-28", ...overrides };
}

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
      windowed: { wins: 3, losses: 1, undecided: 0, excludedUndated: 0 },
      allTime: { wins: 10, losses: 4, undecided: 0, excludedUndated: 0 },
    },
    doublesRecord: overrides.doublesRecord ?? {
      windowed: { wins: 1, losses: 2, undecided: 0, excludedUndated: 0 },
      allTime: { wins: 5, losses: 6, undecided: 0, excludedUndated: 0 },
    },
    slotTendencies: overrides.slotTendencies ?? [{ slot: "S1", count: 4 }],
    partnerFrequency: overrides.partnerFrequency ?? [{ partnerId: 2, count: 3, canonicalName: "Kai Kestrel" }],
    teamMemberships: overrides.teamMemberships ?? [],
    dataGaps: overrides.dataGaps ?? { events: "not-collected", availability: "not-collected", captainNotes: "not-collected" },
    evidenceScope: overrides.evidenceScope ?? buildEvidenceScope(),
    evidenceWindow: overrides.evidenceWindow ?? buildEvidenceWindow(),
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
    // #113: "season" — no event registered — is what every pre-#113 fixture implicitly meant, so it
    // stays the default rather than forcing every existing caller to spell it out.
    rosterSource: overrides.rosterSource ?? "season",
    registeredCount: overrides.registeredCount ?? 0,
    seasonCount: overrides.seasonCount ?? 1,
    absentRoster: overrides.absentRoster ?? [],
    absentRatingSource: overrides.absentRatingSource ?? null,
    teamRecord: overrides.teamRecord ?? { wins: 5, losses: 2, undecided: 0, excludedUndated: 0 },
    slotTendencies: overrides.slotTendencies ?? [{ slot: "S1", count: 4 }],
    headToHead: overrides.headToHead ?? null,
    evidenceScope: overrides.evidenceScope ?? buildEvidenceScope(),
    evidenceWindow: overrides.evidenceWindow ?? buildEvidenceWindow(),
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
    // #113: "season" is what every pre-#113 fixture implicitly meant (no event named).
    rosterSource: "season",
    registeredCount: 0,
    seasonCount: 6,
    ...overrides,
    ...provenance,
  };
}

/**
 * An own-team book (#126) with one recorded day, one unrecorded day, one player note and one
 * pairing note — so a renderer test exercises the recorded, the not-recorded, the solo-note and the
 * pairing-note paths at once, the same way `buildLineupPlan` covers its three confidence paths.
 *
 * Note the SECOND day carries no status for anyone: that is the case a renderer is most likely to
 * drop, and `buildDossier`'s default must therefore contain it rather than leave it to whichever
 * test remembers.
 */
export function buildOwnTeamBook(overrides: Partial<OwnTeamBook> = {}): OwnTeamBook {
  return {
    availability: overrides.availability === undefined
      ? {
          days: ["2026-08-28", "2026-08-29"],
          players: [
            {
              playerId: 1,
              canonicalName: "Nova Norbury",
              days: [
                { day: "2026-08-28", status: "available" },
                { day: "2026-08-29", status: null },
              ],
            },
          ],
        }
      : overrides.availability,
    notes: overrides.notes ?? {
      player: [
        {
          noteId: 1,
          playerId: 1,
          canonicalName: "Nova Norbury",
          note: "prefers the deuce court",
          createdAt: "2026-08-09T00:00:00.000Z",
        },
      ],
      pairing: [
        {
          noteId: 2,
          playerId: 1,
          canonicalName: "Nova Norbury",
          pairPlayerId: 2,
          pairCanonicalName: "Kai Kestrel",
          note: "strong together",
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      ],
    },
  };
}

export function buildDossier(overrides: Partial<TeamDossier> = {}): TeamDossier {
  return {
    // A fixed window label, so a renderer test never depends on the day the suite is run — the very
    // print-date coupling issue #90 (and #122, generalizing it) removed from the product.
    window: overrides.window ?? "12mo to 2026-08-28",
    // No event named by default, matching the default evidence scope above — a fixture whose scope
    // says "none applied" must not simultaneously claim an event supplied one.
    event: overrides.event ?? null,
    // #113: matches the default `team.rosterSource` ("season") — see that field's own comment.
    rosterSource: overrides.rosterSource ?? "season",
    team: overrides.team ?? buildTeamProfile(),
    players: overrides.players ?? [buildPlayerProfile()],
    lineup: overrides.lineup === undefined ? buildLineupPlan() : overrides.lineup,
    // #126: `null` by default — the default fixture's `buildTeamProfile` is an OPPONENT
    // (`isHome: false`), and an opponent never carries a book. A home-team test passes one in
    // explicitly, which keeps the two states from being confused by omission.
    ownTeam: overrides.ownTeam === undefined ? null : overrides.ownTeam,
  };
}

/** A dossier with every derived section genuinely empty (no matches, no ratings, no roster) —
 * distinct from `dataGaps` reporting "not-collected": here the sections exist and simply have zero
 * results, which must still render a valid document rather than crash. */
export function buildEmptyDossier(): TeamDossier {
  return {
    window: "12mo to 2026-08-28",
    event: null,
    rosterSource: "season",
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
    // #126: an opponent-shaped empty dossier, so no book — the home-team empty case is its own
    // fixture in the renderer suites, since "we have a book and it is empty" and "this is not our
    // team" must render differently.
    ownTeam: null,
  };
}
