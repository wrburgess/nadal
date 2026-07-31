// DB assembly for a player's dossier (Task 4). Fetches rows with drizzle, hands them to
// `derive.ts`, and returns a typed profile. Deliberately thin: every correctness-sensitive
// computation (win/loss, partner counting, rating-trajectory ordering, data-gap classification)
// lives in `src/query/derive.ts`, not here.

import { eq, inArray } from "drizzle-orm";
import { nameKey } from "../db/name-key.js";
import {
  courtMatchPlayers,
  courtMatches,
  playerAliases,
  players,
  ratingObservations,
  teamMemberships,
  teams,
} from "../db/schema.js";
import { assertPlayerAliasesKeyed, assertPlayersKeyed, findPlayerByName } from "../ingest/identity.js";
import type { NameLookup } from "../ingest/identity.js";
import type { Db } from "../ingest/db-types.js";
import { dataGaps, partnerFrequency, ratingTrajectory, slotTendencies, windowedRecord } from "./derive.js";
import type {
  CourtMatchRow,
  DataGapsResult,
  PartnerFrequencyEntry,
  RatingObservationRow,
  RatingTrajectoryResult,
  Side,
  SlotTendency,
  WindowedRecordResult,
} from "./types.js";

type PlayerRow = typeof players.$inferSelect;

export type PlayerTargetResolution =
  | { kind: "ok"; playerId: number }
  | { kind: "not-found" }
  | { kind: "ambiguous"; candidates: string[] };

/**
 * `findPlayerByName` (src/ingest/identity.ts, reused unchanged) matches only `canonicalName` — it
 * never consults `player_aliases`, so on its own it cannot resolve "an alias-only spelling
 * resolves to the same profile as the canonical name" (Task 4's testing strategy, the #15
 * Unicode-case-folding path). `resolvePlayer`'s tier 2 DOES fold aliases in, but it can also
 * CREATE a player, which `show` must never do. This mirrors `resolvePlayer`'s tier-2 exact
 * matching (canonical name OR alias, folded with JS's Unicode-aware `toLowerCase()` — SQLite's
 * `lower()` is ASCII-only, the defect #15 fixed) without ever writing, then falls back to
 * `findPlayerByName`'s own fuzzy tier for a near-miss spelling.
 *
 * Issue #32: rewritten onto the indexed `name_key` columns instead of loading every player and
 * every alias into memory on every call — the locally re-declared `fold` this replaced folded case
 * the same way `nameKey` (src/db/name-key.ts) does, so the matching behavior is unchanged, only how
 * it's queried.
 */
function findPlayerByNameOrAlias(db: Db, name: string): NameLookup<PlayerRow> {
  assertPlayersKeyed(db);
  assertPlayerAliasesKeyed(db);
  const key = nameKey(name);

  const exactByCanonical = db.select().from(players).where(eq(players.nameKey, key)).all();
  const aliasPlayerIds = db
    .select({ playerId: playerAliases.playerId })
    .from(playerAliases)
    .where(eq(playerAliases.nameKey, key))
    .all()
    .map((r) => r.playerId);
  const exactByAlias =
    aliasPlayerIds.length > 0
      ? db.select().from(players).where(inArray(players.id, aliasPlayerIds)).all()
      : [];

  const exactMap = new Map<number, PlayerRow>();
  for (const row of [...exactByCanonical, ...exactByAlias]) exactMap.set(row.id, row);

  if (exactMap.size === 1) {
    return { kind: "found", row: [...exactMap.values()][0]! };
  }
  if (exactMap.size > 1) {
    return { kind: "ambiguous", candidates: [...exactMap.values()] };
  }

  // No exact hit at all (by name or alias) — fall back to the reused fuzzy tier.
  return findPlayerByName(db, name);
}

/**
 * Resolve a `player show`-style target to an existing player id — NEVER creates (spec: `show`
 * reads; enrichment is `pull`'s job). `usta:`/`wtn:`/`tr:` prefixes select by source id, exactly
 * as `resolvePlayer`'s tier 1 does; a bare name goes through `findPlayerByNameOrAlias` above.
 */
export function resolvePlayerTarget(db: Db, target: string): PlayerTargetResolution {
  if (target.startsWith("usta:")) {
    const row = db.select().from(players).where(eq(players.ustaUaid, target.slice("usta:".length))).all()[0];
    return row === undefined ? { kind: "not-found" } : { kind: "ok", playerId: row.id };
  }
  if (target.startsWith("wtn:")) {
    const row = db.select().from(players).where(eq(players.wtnTennisId, target.slice("wtn:".length))).all()[0];
    return row === undefined ? { kind: "not-found" } : { kind: "ok", playerId: row.id };
  }
  if (target.startsWith("tr:")) {
    const row = db
      .select()
      .from(players)
      .where(eq(players.tennisrecordUrl, target.slice("tr:".length)))
      .all()[0];
    return row === undefined ? { kind: "not-found" } : { kind: "ok", playerId: row.id };
  }

  const found = findPlayerByNameOrAlias(db, target);
  if (found.kind === "found") return { kind: "ok", playerId: found.row.id };
  if (found.kind === "ambiguous") {
    return { kind: "ambiguous", candidates: found.candidates.map((p) => p.canonicalName) };
  }
  return { kind: "not-found" };
}

export type PlayerIdentitySummary = {
  playerId: number;
  canonicalName: string;
  aliases: string[];
  ageRange: string | null;
  gender: string | null;
  ustaUaid: string | null;
  wtnTennisId: string | null;
  tennisrecordUrl: string | null;
};

export type PlayerTeamMembershipSummary = {
  teamId: number;
  teamName: string;
  eventId: number | null;
};

export type PlayerProfile = {
  identity: PlayerIdentitySummary;
  ratingTrajectory: RatingTrajectoryResult;
  singlesRecord: { sixMonth: WindowedRecordResult; allTime: WindowedRecordResult };
  doublesRecord: { sixMonth: WindowedRecordResult; allTime: WindowedRecordResult };
  slotTendencies: SlotTendency[];
  partnerFrequency: (PartnerFrequencyEntry & { canonicalName: string })[];
  teamMemberships: PlayerTeamMembershipSummary[];
  dataGaps: DataGapsResult;
};

/**
 * Every `court_matches` row at least one of `playerIds` participated in, pre-joined with EVERY
 * other participant on that court match (not just the requested players) — the shape
 * `derive.ts`'s functions need for partner/opponent lookups. Shared by `getPlayerProfile` (a
 * single id) and `team-profile.ts` (a whole roster plus, for `versusTeamId`, the opposing roster)
 * so both query the DB the same way rather than each inventing their own join.
 */
export function courtMatchRowsForPlayers(db: Db, playerIds: number[]): CourtMatchRow[] {
  if (playerIds.length === 0) return [];

  const ownMatchIds = Array.from(
    new Set(
      db
        .select({ courtMatchId: courtMatchPlayers.courtMatchId })
        .from(courtMatchPlayers)
        .where(inArray(courtMatchPlayers.playerId, playerIds))
        .all()
        .map((r) => r.courtMatchId),
    ),
  );
  if (ownMatchIds.length === 0) return [];

  const courtRows = db.select().from(courtMatches).where(inArray(courtMatches.id, ownMatchIds)).all();
  const participantRows = db
    .select()
    .from(courtMatchPlayers)
    .where(inArray(courtMatchPlayers.courtMatchId, ownMatchIds))
    .all();

  return courtRows.map((c) => ({
    id: c.id,
    slot: c.slot,
    discipline: c.discipline,
    winnerSide: c.winnerSide as Side | null,
    playedOn: c.playedOn,
    participants: participantRows
      .filter((p) => p.courtMatchId === c.id)
      .map((p) => ({ playerId: p.playerId, side: p.side as Side })),
  }));
}

/**
 * Assemble every derived section of one player's dossier. `options.since` bounds the "six-month"
 * windowed records; the "all-time" records omit it (derive.ts's `windowedRecord` treats a missing
 * `since` as no lower bound).
 */
export function getPlayerProfile(db: Db, playerId: number, options: { since: string }): PlayerProfile {
  const playerRow = db.select().from(players).where(eq(players.id, playerId)).all()[0];
  if (playerRow === undefined) throw new Error(`getPlayerProfile: no player with id ${playerId}`);

  const aliasRows = db.select().from(playerAliases).where(eq(playerAliases.playerId, playerId)).all();

  const observationRows: RatingObservationRow[] = db
    .select()
    .from(ratingObservations)
    .where(eq(ratingObservations.playerId, playerId))
    .all()
    .map((r) => ({ id: r.id, source: r.source, value: r.value, ratingType: r.ratingType, observedOn: r.observedOn }));

  const courtRows = courtMatchRowsForPlayers(db, [playerId]);

  const membershipRows: PlayerTeamMembershipSummary[] = db
    .select({ teamId: teamMemberships.teamId, eventId: teamMemberships.eventId, teamName: teams.name })
    .from(teamMemberships)
    .innerJoin(teams, eq(teamMemberships.teamId, teams.id))
    .where(eq(teamMemberships.playerId, playerId))
    .all();

  const partnerCounts = partnerFrequency(courtRows, playerId);
  const partnerNames = partnerCounts.map((entry) => {
    const partnerRow = db.select().from(players).where(eq(players.id, entry.partnerId)).all()[0];
    return { ...entry, canonicalName: partnerRow?.canonicalName ?? `player #${entry.partnerId}` };
  });

  return {
    identity: {
      playerId: playerRow.id,
      canonicalName: playerRow.canonicalName,
      aliases: aliasRows.map((a) => a.alias),
      ageRange: playerRow.ageRange,
      gender: playerRow.gender,
      ustaUaid: playerRow.ustaUaid,
      wtnTennisId: playerRow.wtnTennisId,
      tennisrecordUrl: playerRow.tennisrecordUrl,
    },
    ratingTrajectory: ratingTrajectory(observationRows),
    singlesRecord: {
      sixMonth: windowedRecord(courtRows, playerId, { since: options.since, discipline: "singles" }),
      allTime: windowedRecord(courtRows, playerId, { discipline: "singles" }),
    },
    doublesRecord: {
      sixMonth: windowedRecord(courtRows, playerId, { since: options.since, discipline: "doubles" }),
      allTime: windowedRecord(courtRows, playerId, { discipline: "doubles" }),
    },
    slotTendencies: slotTendencies(courtRows, playerId),
    partnerFrequency: partnerNames,
    teamMemberships: membershipRows,
    // `events`/`availability`/`captain_notes` have NO writer anywhere in the codebase —
    // `team-pull.ts` passes `eventId: null` at the roster/schedule call sites and nothing ever
    // inserts into any of the three tables (docs/findings.md, #15/Task 3 rule 6). `hasWriter` is
    // therefore a static fact about the codebase, not something inferred from a query result: a
    // populated-but-empty query would read identically to "no writer" if this were computed from
    // `count === 0` alone, which is exactly the confidently-wrong reading `dataGaps` exists to
    // prevent.
    dataGaps: dataGaps({
      events: { count: 0, hasWriter: false },
      availability: { count: 0, hasWriter: false },
      captainNotes: { count: 0, hasWriter: false },
    }),
  };
}
