// DB assembly for a player's dossier (Task 4). Fetches rows with drizzle, hands them to
// `derive.ts`, and returns a typed profile. Deliberately thin: every correctness-sensitive
// computation (win/loss, partner counting, rating-trajectory ordering, data-gap classification)
// lives in `src/query/derive.ts`, not here.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { nameKey } from "../db/name-key.js";
import {
  availability,
  captainNotes,
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
import { dataGaps, partnerFrequency, ratingTrajectory, rowsWithin, slotTendencies, windowedRecord } from "./derive.js";
import type { LeagueScope } from "./league-scope.js";
import { leagueScopeRetains } from "./league-scope.js";
import type {
  CourtMatchRow,
  DataGapsResult,
  EvidenceScopeSummary,
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
  /** Issue #49: NOT filtered — unlike the current-roster reads in team-profile.ts/lineup.ts/
   * availability.ts/captain-notes.ts, "teams this player has been on" is a legitimately historical
   * statement, and their court matches are untouched (`court_match_players` is a separate table
   * this change never reads or writes). Non-null when this membership has been soft-retired, so a
   * presenter can label a former team distinctly (`tn player show`'s "(former)" suffix). */
  retiredAt: string | null;
};

export type PlayerProfile = {
  identity: PlayerIdentitySummary;
  ratingTrajectory: RatingTrajectoryResult;
  singlesRecord: { windowed: WindowedRecordResult; allTime: WindowedRecordResult };
  doublesRecord: { windowed: WindowedRecordResult; allTime: WindowedRecordResult };
  slotTendencies: SlotTendency[];
  partnerFrequency: (PartnerFrequencyEntry & { canonicalName: string })[];
  teamMemberships: PlayerTeamMembershipSummary[];
  dataGaps: DataGapsResult;
  /** #97: what every record, slot tendency and partner count above was actually computed over —
   * which scope was applied (or that none was), how much it set aside, and what survived it. Not
   * optional, and never omitted when no scope applies: a reader who cannot tell a scoped profile
   * from an unscoped one is back where this issue started. */
  evidenceScope: EvidenceScopeSummary;
  /** #122 round-1 Finding 1: the window `singlesRecord`/`doublesRecord`/`slotTendencies`/
   * `partnerFrequency` above were windowed to — the `evidenceScope` precedent above, one field over.
   * An event-less `team show`/`player show` window SLIDES with the clock (design decision 6), so a
   * caller reading only the profile (MCP, or CLI `--json`) had no value that explained which boundary
   * produced the numbers on the page; the CLI text path alone printed the label out of band. Populated
   * straight from `options.window` — the SAME validated snapshot `since` above was filtered by, never
   * a second derivation — so it cannot describe a window other than the one that actually ran. Callers
   * are expected to pass `windowSnapshot(...)`'s output (or anything structurally identical to it);
   * the ONE-VALIDATED-READ discipline that guarantees `anchorDay`/`since`/`label` agree is enforced by
   * `windowSnapshot` itself (src/cli/window.ts), not repeated here. */
  evidenceWindow: EvidenceWindowDisclosure;
};

/**
 * The plain, already-derived shape an evidence window disclosure needs: the anchor day, the
 * inclusive lower bound derived from it, and the display label — exactly `WindowSnapshot`'s three
 * fields (src/cli/window.ts), but declared HERE, structurally, rather than imported from `cli/`. The
 * query layer has no other reason to depend on the CLI's window module, and importing the type just
 * to re-export it would create an import edge this layer does not otherwise need; `WindowSnapshot`
 * satisfies this type structurally with no cast, so every real caller (which always passes
 * `windowSnapshot(...)`'s own output) needs nothing extra to comply.
 */
export type EvidenceWindowDisclosure = {
  readonly anchorDay: string;
  readonly since: string;
  readonly label: string;
};

/** What `courtMatchRowsForPlayers` returns: the rows to derive from, and an honest account of what
 * it drew them from. The two travel together on purpose — a caller cannot obtain the rows without
 * also being handed the means to disclose how they were scoped (#97 scope item 3). */
export type CourtMatchEvidence = {
  rows: CourtMatchRow[];
  scope: EvidenceScopeSummary;
};

/** The scope summary for a read that fetched nothing. Kept as a function rather than a shared frozen
 * constant so no caller can mutate the empty case out from under another. */
function emptyEvidence(scope: LeagueScope | null): EvidenceScopeSummary {
  return { scope, considered: 0, retained: 0, excluded: 0, unclassified: 0, retainedLeagues: [] };
}

/**
 * Every `court_matches` row at least one of `playerIds` participated in, pre-joined with EVERY
 * other participant on that court match (not just the requested players) — the shape
 * `derive.ts`'s functions need for partner/opponent lookups. Shared by `getPlayerProfile` (a
 * single id) and `team-profile.ts` (a whole roster plus, for `versusTeamId`, the opposing roster)
 * so both query the DB the same way rather than each inventing their own join.
 *
 * **`leagueScope` (#97) is where the whole issue lands.** Before it, this one function was the
 * unscoped reader behind every dossier record and every slot tendency: a 40&Over 3.5 opponent's
 * "usually plays D2" was up to a third driven by matches played with a woman as their partner, a
 * partner pool that does not exist at Sectionals, and 66%–92% of what each dossier reported was play
 * from a different league, age bracket, or NTRP level. Given a scope, rows are filtered by
 * `leagueScopeRetains`; omitted (or `null`), every league counts — byte-identical to the pre-#97
 * behavior, and reported as such rather than left implicit.
 *
 * Filtered HERE rather than in `derive.ts`, and the distinction is load-bearing: `CourtMatchRow`
 * deliberately does not carry `leagueContext` at all, so nothing downstream of this function is even
 * ABLE to apply a second, differently-worded league rule. One boundary, one predicate — two places
 * that could disagree about which evidence counts is the failure mode this issue exists to close.
 *
 * The projection is spelled out rather than left as `select()`. It selected `league_context` all
 * along (as part of `*`) and simply never carried it anywhere; naming the columns makes the read
 * this function performs legible from the read itself.
 */
export function courtMatchRowsForPlayers(
  db: Db,
  playerIds: number[],
  leagueScope?: LeagueScope | null,
): CourtMatchEvidence {
  const scope = leagueScope ?? null;
  if (playerIds.length === 0) return { rows: [], scope: emptyEvidence(scope) };

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
  if (ownMatchIds.length === 0) return { rows: [], scope: emptyEvidence(scope) };

  const allCourtRows = db
    .select({
      id: courtMatches.id,
      slot: courtMatches.slot,
      discipline: courtMatches.discipline,
      winnerSide: courtMatches.winnerSide,
      playedOn: courtMatches.playedOn,
      leagueContext: courtMatches.leagueContext,
    })
    .from(courtMatches)
    .where(inArray(courtMatches.id, ownMatchIds))
    .all();
  const participantRows = db
    .select()
    .from(courtMatchPlayers)
    .where(inArray(courtMatchPlayers.courtMatchId, ownMatchIds))
    .all();

  const courtRows = scope === null ? allCourtRows : allCourtRows.filter((c) => leagueScopeRetains(c.leagueContext, scope));

  // Counted over the RETAINED rows, so the breakdown answers "what is still in here" rather than
  // "what was on file" — which is the question #97's accepted residual is about.
  const leagueCounts = new Map<string | null, number>();
  for (const c of courtRows) leagueCounts.set(c.leagueContext, (leagueCounts.get(c.leagueContext) ?? 0) + 1);
  const retainedLeagues = Array.from(leagueCounts.entries())
    .map(([league, count]) => ({ league, count }))
    // The unclassified bucket sorts last unconditionally, ahead of the count comparison — a `null`
    // has no name to tie-break on, and a real league placed behind it would read as the smaller
    // category when it is not.
    .sort((a, b) => {
      if (a.league === null) return 1;
      if (b.league === null) return -1;
      return b.count - a.count || a.league.localeCompare(b.league);
    });

  return {
    rows: courtRows.map((c) => ({
      id: c.id,
      slot: c.slot,
      discipline: c.discipline,
      winnerSide: c.winnerSide as Side | null,
      playedOn: c.playedOn,
      participants: participantRows
        .filter((p) => p.courtMatchId === c.id)
        .map((p) => ({ playerId: p.playerId, side: p.side as Side })),
    })),
    scope: {
      scope,
      considered: allCourtRows.length,
      retained: courtRows.length,
      excluded: allCourtRows.length - courtRows.length,
      unclassified: courtRows.filter((c) => c.leagueContext === null).length,
      retainedLeagues,
    },
  };
}

/**
 * Assemble every derived section of one player's dossier. `options.window.since` bounds the WINDOWED
 * records, slot tendencies and partner counts (issue #122: a 12-month lookback, not a calendar
 * season); the "all-time" records omit it (derive.ts's `windowedRecord` treats a missing `since` as
 * no lower bound). `options.window` as a whole is copied verbatim into the returned profile's
 * `evidenceWindow` (round-1 Finding 1) — the disclosure and the filter are the SAME read, so they
 * cannot describe different windows.
 *
 * **`slotTendencies`/`partnerFrequency` are filtered to the SAME window as the records beside them**
 * (issue #122, Task 3 — "the second failure": the window used to reach `singlesRecord`/
 * `doublesRecord` only, so a player's block could print a windowed "0-0" next to tendencies drawn
 * from matches entirely outside it, with nothing on the page distinguishing "did not play" from
 * "played outside a boundary the page never names"). `rowsWithin(options.window.since)` (derive.ts)
 * is the one shared predicate both now filter through before deriving, so "one page, one window"
 * holds by construction.
 *
 * `options.leagueScope` (#97) scopes the EVIDENCE rather than the window: records, slot tendencies
 * and partner counts are computed only over the court matches the scope retains, and what it set
 * aside is reported in `evidenceScope` rather than silently dropped. Omitted, every league counts —
 * identical to the pre-#97 behavior, and stated as such on the page instead of left implicit.
 */
export function getPlayerProfile(
  db: Db,
  playerId: number,
  options: { window: EvidenceWindowDisclosure; leagueScope?: LeagueScope | null },
): PlayerProfile {
  const playerRow = db.select().from(players).where(eq(players.id, playerId)).all()[0];
  if (playerRow === undefined) throw new Error(`getPlayerProfile: no player with id ${playerId}`);

  const aliasRows = db.select().from(playerAliases).where(eq(playerAliases.playerId, playerId)).all();

  const observationRows: RatingObservationRow[] = db
    .select()
    .from(ratingObservations)
    .where(eq(ratingObservations.playerId, playerId))
    .all()
    .map((r) => ({ id: r.id, source: r.source, value: r.value, ratingType: r.ratingType, observedOn: r.observedOn }));

  const evidence = courtMatchRowsForPlayers(db, [playerId], options.leagueScope);
  const courtRows = evidence.rows;
  // Slot tendencies and partner frequency are windowed to the SAME `since` as the records below —
  // see this function's own doc comment ("the second failure"). `singlesRecord`/`doublesRecord`
  // apply `since` themselves (via `windowedRecord`'s own `since` option, unchanged), so `courtRows`
  // stays the unwindowed evidence set for THEM; `windowedRows` is the explicit, shared filter for
  // everything else that must match.
  const windowedRows = rowsWithin(options.window.since)(courtRows);

  const membershipRows: PlayerTeamMembershipSummary[] = db
    .select({
      teamId: teamMemberships.teamId,
      eventId: teamMemberships.eventId,
      teamName: teams.name,
      retiredAt: teamMemberships.retiredAt,
    })
    .from(teamMemberships)
    .innerJoin(teams, eq(teamMemberships.teamId, teams.id))
    .where(eq(teamMemberships.playerId, playerId))
    .all();

  const partnerCounts = partnerFrequency(windowedRows, playerId);
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
      windowed: windowedRecord(courtRows, playerId, { since: options.window.since, discipline: "singles" }),
      allTime: windowedRecord(courtRows, playerId, { discipline: "singles" }),
    },
    doublesRecord: {
      windowed: windowedRecord(courtRows, playerId, { since: options.window.since, discipline: "doubles" }),
      allTime: windowedRecord(courtRows, playerId, { discipline: "doubles" }),
    },
    slotTendencies: slotTendencies(windowedRows, playerId),
    partnerFrequency: partnerNames,
    teamMemberships: membershipRows,
    // Carried straight from the read that produced `courtRows`, never rebuilt: a summary derived a
    // second time could describe a scope the rows above were not actually filtered by, which is
    // precisely the claim #97 forbids a filtered record from making.
    evidenceScope: evidence.scope,
    // #122 round-1 Finding 1: copied verbatim from `options.window` — never re-derived — so this
    // disclosure describes the SAME window `since` above actually filtered by, not a second read of
    // it. See `EvidenceWindowDisclosure`'s own doc comment for why the type is structural rather than
    // imported from `cli/window.ts`.
    evidenceWindow: { anchorDay: options.window.anchorDay, since: options.window.since, label: options.window.label },
    // `hasWriter` is a fact about the CODEBASE — "can anything, anywhere, populate this section for
    // a player?" — and it has to keep tracking that fact rather than freezing at whatever was true
    // when it was written (docs/findings.md, #15/Task 3 rule 6). All three sections are now `true`
    // with a REAL count, which is what lets `dataGaps` distinguish "empty" (a writer exists; nothing
    // recorded for this player) from "has-data": `availability` and `captain_notes` got theirs in
    // #17 PR A (`setAvailability`, `addCaptainNote`), and `events` gets its FIRST one in #113
    // (`setEventRoster`, the service behind `tn roster set` / the `roster_set` MCP tool) — a
    // registration payload is exactly a PLAYER-to-EVENT association, the thing every earlier
    // revision of this comment said nothing wrote.
    //
    // `tn team pull` still passes `eventId: null` at both its call sites (docs/findings.md, #15) —
    // a season/league roster pull is not an event registration, and #113 does not change that — so
    // most players remain "empty" here in practice, exactly as intended: `events` finally
    // distinguishes "empty" from "not-collected" instead of being unable to reach either.
    //
    // An earlier revision of this comment flipped `hasWriter` to `true` while `count` stayed the
    // literal `0` — turning "nothing can record this" into "nothing was recorded" for every player,
    // the exact silent lie `docs/findings.md:255` (PR #47 round 3) records. The fix here is the one
    // that finding calls for: `hasWriter` and `count` change together, verified end to end (Task 8's
    // own test drives the real `setEventRoster` writer, never a hand-inserted row) rather than
    // trusted separately.
    dataGaps: dataGaps({
      events: {
        count: db
          .select({ id: teamMemberships.id })
          .from(teamMemberships)
          .where(and(eq(teamMemberships.playerId, playerId), isNotNull(teamMemberships.eventId)))
          .all().length,
        hasWriter: true,
      },
      availability: {
        count: db.select({ id: availability.id }).from(availability).where(eq(availability.playerId, playerId)).all()
          .length,
        hasWriter: true,
      },
      captainNotes: {
        count: db.select({ id: captainNotes.id }).from(captainNotes).where(eq(captainNotes.playerId, playerId)).all()
          .length,
        hasWriter: true,
      },
    }),
  };
}
