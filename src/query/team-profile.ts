// DB assembly for a team's dossier (Task 4) — the twin of player-profile.ts. Fetches rows with
// drizzle, hands them to `derive.ts`, and returns a typed profile; kept thin for the same reason.

import { eq, inArray, or } from "drizzle-orm";
import { ratingObservations, teamMatches, teams } from "../db/schema.js";
import { findTeamByName } from "../ingest/identity.js";
import type { Db } from "../ingest/db-types.js";
import { headToHead, selectRosterRatingSource, slotTendencies, teamMatchRecord, windowedRecord } from "./derive.js";
import { resolveHomeTeam } from "./home-team.js";
import { courtMatchRowsForPlayers } from "./player-profile.js";
import { resolveRoster } from "./roster.js";
import type { LeagueScope } from "./league-scope.js";
import type {
  EvidenceScopeSummary,
  HeadToHeadResult,
  RatingSource,
  SlotTendency,
  TeamMatchRecordResult,
  TeamMatchRow,
  WindowedRecordResult,
} from "./types.js";

export type TeamTargetResolution =
  | { kind: "ok"; teamId: number }
  | { kind: "not-found" }
  | { kind: "ambiguous"; candidates: string[] };

/**
 * Resolve a `team show`-style target to an existing team id — never creates. `tr:` selects by
 * `tennisrecord_url`; a bare name goes through `findTeamByName` (src/ingest/identity.ts, reused
 * unchanged — teams have no alias table, so no alias-folding wrapper is needed here the way
 * `resolvePlayerTarget` needs one for players).
 *
 * The `tr:` branch's `.all()[0]` is single-row by construction, not by convention: migration 0009
 * (issue #46) makes a non-null `teams.tennisrecord_url` a DB-unique source identity, and
 * `upsertTeam` (src/ingest/upsert.ts) resolves by that URL before ever touching the name path, so a
 * rename can never leave two rows sharing one URL for this lookup to pick between arbitrarily.
 */
export function resolveTeamTarget(db: Db, target: string): TeamTargetResolution {
  if (target.startsWith("tr:")) {
    const row = db
      .select()
      .from(teams)
      .where(eq(teams.tennisrecordUrl, target.slice("tr:".length)))
      .all()[0];
    return row === undefined ? { kind: "not-found" } : { kind: "ok", teamId: row.id };
  }

  const found = findTeamByName(db, target);
  if (found.kind === "found") return { kind: "ok", teamId: found.row.id };
  if (found.kind === "ambiguous") {
    return { kind: "ambiguous", candidates: found.candidates.map((t) => t.name) };
  }
  return { kind: "not-found" };
}

export type RosterMemberProfile = {
  playerId: number;
  canonicalName: string;
  ageRange: string | null;
  singlesRecord: WindowedRecordResult; // six-month
  doublesRecord: WindowedRecordResult; // six-month
  slotTendencies: SlotTendency[];
};

export type TeamCrossHeadToHead = HeadToHeadResult & {
  playerId: number;
  /** The opposing player's canonical name — resolved here (this is the DB-access assembly layer,
   * not `derive.ts`'s pure `headToHead`), so a renderer never has to print a raw `opponentId`.
   * Falls back to `player #<id>` only if the id somehow has no matching roster row (should not
   * happen in practice: `opponentId` always comes from `versusPlayerIds`, which IS the query this
   * name map is built from), matching the existing `player-profile.ts` convention for an
   * unresolved partner id. */
  opponentName: string;
};

/** One NOT REGISTERED player (#113, the HC's 2026-08-05 dossier mock): name and a single rating
 * value only — deliberately no record, no tendencies. It exists so a late add is RECOGNISED, not
 * SCOUTED; full detail for a non-traveling player is exactly the noise issues #97/#108 removed. */
export type AbsentRosterMember = {
  playerId: number;
  canonicalName: string;
  /** This player's latest observation in `TeamProfile.absentRatingSource`, or `null` when they have
   * none there — printed as `—`, never omitted, per the mock. */
  rating: number | null;
};

export type TeamProfile = {
  teamId: number;
  teamName: string;
  /** Whether THIS team is the currently-designated home team (nadal ADR 0001,
   * `src/query/home-team.ts`'s `resolveHomeTeam`) — `false` both when a different team is home and
   * when no team is designated at all; a caller that needs to distinguish those two reads
   * `resolveHomeTeam` directly. */
  isHome: boolean;
  /** Alphabetical by canonical name (deterministic regardless of membership insertion order),
   * tie-broken by playerId — a member with no CURRENT `team_memberships` row is never included.
   * Issue #49: "current" excludes a soft-retired row (`retired_at IS NOT NULL`) as well as a
   * missing one, since a departed player must read the same as an absent one on every roster read
   * — the roster is that query filtered to `retired_at IS NULL`, not merely that query. Their
   * history is NOT similarly hidden: `getPlayerProfile`'s `teamMemberships` still lists a retired
   * team, and this team's own `teamRecord`/court-match history is untouched by a retirement.
   *
   * #113: drawn from `resolveRoster` (src/query/roster.ts) rather than a raw `team_memberships`
   * query run here — the REGISTERED roster when `rosterSource === "registered"`, the full season
   * roster otherwise. `rosterSource`/`absentRoster` below are the discriminated pair this reads as;
   * see `resolveRoster`'s own doc comment for the fallback rule. */
  roster: RosterMemberProfile[];
  /** Which roster `roster` above actually is — `resolveRoster`'s own discriminant, carried through
   * unchanged so the roster used and the roster claimed cannot disagree (#113). */
  rosterSource: "registered" | "season";
  registeredCount: number;
  seasonCount: number;
  /** Season-roster players who did NOT register for the scoped event — populated ONLY when
   * `rosterSource === "registered"`. An empty array in the `season` branch means "the concept does
   * not apply here", never "everyone is absent" — the HC's "an event with no registered memberships
   * renders exactly as today" rule (#113). */
  absentRoster: AbsentRosterMember[];
  /** The single rating source `absentRoster`'s values were drawn from (`derive.ts`'s
   * `selectRosterRatingSource` — the same single-source discipline `getLineupPlan` uses to rank the
   * traveling roster) — `null` when `absentRoster` is empty or nobody in it has any rating on file. */
  absentRatingSource: RatingSource | null;
  teamRecord: TeamMatchRecordResult;
  /** Per-slot counts aggregated across the whole roster. */
  slotTendencies: SlotTendency[];
  /** One row per (own roster player, versus roster player) cross pair, including explicit
   * zero rows for a pair that never met. `null` — not an empty array — when no `versusTeamId`
   * was given, so "not requested" stays distinguishable from "requested, nothing found". */
  headToHead: TeamCrossHeadToHead[] | null;
  /** #97: what every roster record, every slot tendency (per-member AND aggregated) and every
   * head-to-head row above was computed over. ONE summary for the whole profile, not one per roster
   * member, because all of them derive from a single `courtMatchRowsForPlayers` call — per-member
   * copies would be N restatements of one fact, and any two of them drifting would be a lie the
   * type made possible. */
  evidenceScope: EvidenceScopeSummary;
};

/**
 * `options.leagueScope` (#97) restricts the court matches every derived section below draws on —
 * including `headToHead`, which is the same evidence question asked across two rosters: a prior
 * meeting in mixed doubles says as little about a Sectionals court as a mixed record does.
 *
 * Omitted, every league counts, byte-identical to the pre-#97 behavior — and `evidenceScope` says so
 * explicitly rather than leaving a reader to infer it from the absence of a filter line.
 *
 * `options.eventId` (#113) — the ALREADY-RESOLVED event's id, never a name looked up again here —
 * scopes the roster itself (and the `versusTeamId` opponent roster the same way, or a dossier would
 * scope itself and not its opponent) via `resolveRoster`. Omitted or `null`, this is byte-identical
 * to the pre-#113 behavior: the full season roster, `rosterSource: "season"`.
 */
export function getTeamProfile(
  db: Db,
  teamId: number,
  options: { since: string; versusTeamId?: number; leagueScope?: LeagueScope | null; eventId?: number | null },
): TeamProfile {
  const teamRow = db.select().from(teams).where(eq(teams.id, teamId)).all()[0];
  if (teamRow === undefined) throw new Error(`getTeamProfile: no team with id ${teamId}`);

  const resolved = resolveRoster(db, { teamId, eventId: options.eventId });
  const rosterPlayerRows = resolved.members;

  const versusPlayerRows =
    options.versusTeamId === undefined
      ? []
      : resolveRoster(db, { teamId: options.versusTeamId, eventId: options.eventId }).members;
  const versusPlayerIds = versusPlayerRows.map((r) => r.playerId);
  // Resolved once here (DB access lives in this assembly layer, not in derive.ts's pure
  // `headToHead`) so every cross-pair row below can carry the opponent's NAME, not just their id —
  // a rendered dossier prints "vs player #<id>" otherwise (a raw database id in a printed courtside
  // binder), which was a latent, untested defect until Task 5 (#17) wired a real `versusTeamId` for
  // the first time in production.
  const versusPlayerNamesById = new Map(versusPlayerRows.map((r) => [r.playerId, r.canonicalName]));

  // THIS ROSTER's court matches only — not the union with `versusPlayerIds`, which is what this
  // read used to fetch.
  //
  // The union was redundant for every consumer and actively wrong for the disclosure. Redundant:
  // each of the three things derived below is computed FOR a roster member — `windowedRecord` and
  // `slotTendencies` take a roster player id, and `derive.ts`'s `headToHead` opens with
  // `if (self === undefined) continue`, skipping every row the roster member did not play in. A
  // court match that only OUR players played can therefore reach no section on this page. And any
  // match that IS a prior meeting necessarily has a roster member in it, so it is already in this
  // narrower set — the union added exactly the rows nothing can use.
  //
  // Wrong for the disclosure, which is what made it a defect rather than a wasted fetch (#97's
  // scope item 3): `evidenceScope` must count the evidence the page DISPLAYS. Fetching the union
  // meant an opposing player's own out-of-league match — invisible in every section — still moved
  // `considered` and `excluded`, so a dossier could report a filter that set aside rows it never
  // showed. A count that does not describe what is on the page is the same class of silent
  // misstatement this issue exists to remove.
  // (Codex adversarial review of PR #99, round 1, Finding 2 [medium].)
  const evidence = courtMatchRowsForPlayers(db, rosterPlayerRows.map((r) => r.playerId), options.leagueScope);
  const courtRows = evidence.rows;

  const roster: RosterMemberProfile[] = rosterPlayerRows.map((p) => ({
    playerId: p.playerId,
    canonicalName: p.canonicalName,
    ageRange: p.ageRange,
    singlesRecord: windowedRecord(courtRows, p.playerId, { since: options.since, discipline: "singles" }),
    doublesRecord: windowedRecord(courtRows, p.playerId, { since: options.since, discipline: "doubles" }),
    slotTendencies: slotTendencies(courtRows, p.playerId),
  }));

  const aggregatedSlotCounts = new Map<string, number>();
  for (const member of roster) {
    for (const st of member.slotTendencies) {
      aggregatedSlotCounts.set(st.slot, (aggregatedSlotCounts.get(st.slot) ?? 0) + st.count);
    }
  }
  const aggregatedSlotTendencies: SlotTendency[] = Array.from(aggregatedSlotCounts.entries())
    .map(([slot, count]) => ({ slot, count }))
    .sort((a, b) => b.count - a.count || a.slot.localeCompare(b.slot));

  const teamMatchRows: TeamMatchRow[] = db
    .select()
    .from(teamMatches)
    .where(or(eq(teamMatches.homeTeamId, teamId), eq(teamMatches.visitingTeamId, teamId)))
    .all();

  const headToHeadRows: TeamCrossHeadToHead[] | null =
    options.versusTeamId === undefined
      ? null
      : roster.flatMap((member) =>
          headToHead(courtRows, member.playerId, versusPlayerIds).map((h) => ({
            playerId: member.playerId,
            opponentName: versusPlayerNamesById.get(h.opponentId) ?? `player #${h.opponentId}`,
            ...h,
          })),
        );

  // #113: the NOT REGISTERED block's ratings, drawn ONLY when there is an absent list to draw them
  // for — `resolved.absent` is already `[]` in the `season` branch (see `resolveRoster`'s doc
  // comment), so this is a no-op query there rather than a wasted fetch guarded by a second check.
  const absentPlayerIds = resolved.absent.map((m) => m.playerId);
  const absentObservationRows =
    absentPlayerIds.length === 0
      ? []
      : db.select().from(ratingObservations).where(inArray(ratingObservations.playerId, absentPlayerIds)).all();
  const absentObservationsByPlayer = new Map<number, typeof absentObservationRows>();
  for (const obs of absentObservationRows) {
    const list = absentObservationsByPlayer.get(obs.playerId) ?? [];
    list.push(obs);
    absentObservationsByPlayer.set(obs.playerId, list);
  }
  // The single-source discipline `getLineupPlan` already enforces for the TRAVELING roster
  // (`derive.ts`: ranking/presenting across sources is not sound) — chosen over the ABSENT players
  // themselves, since they are who the printed rating actually describes.
  const absentRating = selectRosterRatingSource({
    rosterPlayerIds: absentPlayerIds,
    ratings: absentPlayerIds.map((playerId) => ({
      playerId,
      observations: absentObservationsByPlayer.get(playerId) ?? [],
    })),
  });
  const absentRoster: AbsentRosterMember[] = resolved.absent.map((m) => ({
    playerId: m.playerId,
    canonicalName: m.canonicalName,
    rating: absentRating.latestBySource.get(m.playerId)?.value ?? null,
  }));

  return {
    teamId: teamRow.id,
    teamName: teamRow.name,
    isHome: resolveHomeTeam(db)?.id === teamRow.id,
    roster,
    rosterSource: resolved.source,
    registeredCount: resolved.registeredCount,
    seasonCount: resolved.seasonCount,
    absentRoster,
    absentRatingSource: absentRating.source,
    teamRecord: teamMatchRecord(teamMatchRows, teamId, { since: options.since }),
    slotTendencies: aggregatedSlotTendencies,
    headToHead: headToHeadRows,
    // Carried straight from the read that produced `courtRows` — see the same note in
    // `getPlayerProfile`. Note what it does NOT describe: `teamRecord`, which is derived from
    // `team_matches` and carries no league context of its own, so no scope has ever applied to it.
    evidenceScope: evidence.scope,
  };
}
