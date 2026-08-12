// The one choke point every roster read goes through (Task 2, #113). Before this, `team-profile.ts`
// (twice — the team's own roster AND the `versusTeamId` opponent roster) and `lineup.ts` each ran
// their own byte-identical `team_memberships` query, none of them aware an event could narrow the
// roster at all. `resolveRoster` replaces all three.

import { and, eq, isNull } from "drizzle-orm";
import { players, teamMemberships } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";

export type RosterMember = {
  playerId: number;
  canonicalName: string;
  ageRange: string | null;
  /** The captain's recorded play-style constraint, RAW off `players.plays` — undecoded, exactly as
   * `ageRange` above. `tn lineup build` (src/query/lineup-build.ts's `readPlays`) is the fail-closed
   * decoder; this join only carries the column through (#149 Task 3). */
  plays: string | null;
};

/**
 * A discriminated pair, in the shape of `slotSource`/`slotEvent` (`src/query/lineup.ts:58-60`) — the
 * roster a caller actually gets and the roster it may CLAIM cannot disagree, because both come off
 * the SAME field rather than being independently inferred at each of the three call sites.
 *
 * `"registered"` — at least one CURRENT (non-retired) `(team_id, event_id)` membership exists.
 * `members` is that registered set; `absent` is the season-roster complement (a season member who
 * did not register), populated ONLY here — the HC's 2026-08-05 dossier mock (TRAVELING / NOT
 * REGISTERED). `"season"` — no event was named, OR an event was named but has zero current
 * registered rows, OR every registered row for it is retired. The last of those three is the
 * fallback boundary the issue's own verification bar turns on: an event that once had a roster but
 * now reads as empty must not silently empty the whole dossier, so it falls back to the full season
 * roster rather than rendering nobody.
 *
 * Scope-or-fallback, never a union: `getTeamProfile`'s roster read is not de-duplicated by
 * `playerId` (unlike `getLineupPlan`'s), so unioning registered + season rows would double a player
 * who is both — every roster read below is drawn from exactly ONE of the two queries, never both.
 */
export type ResolvedRoster =
  | { source: "registered"; members: RosterMember[]; absent: RosterMember[]; registeredCount: number; seasonCount: number }
  | { source: "season"; members: RosterMember[]; absent: []; registeredCount: number; seasonCount: number };

/** Alphabetical by canonical name, tie-broken by playerId — the exact ordering
 * `getTeamProfile`'s roster read has always produced, preserved here now that this module owns the
 * query. */
function orderedMembers(rows: RosterMember[]): RosterMember[] {
  return [...rows].sort(
    (a, b) => a.canonicalName.toLowerCase().localeCompare(b.canonicalName.toLowerCase()) || a.playerId - b.playerId,
  );
}

/**
 * BOTH scopes in ONE statement, then partitioned in memory — deliberately not two queries.
 *
 * Two reads are two SNAPSHOTS. `tn mcp serve` runs beside a CLI against one WAL database, so a
 * `tn team pull` landing between a season read and an event read retires a season membership the
 * first query already returned: the roster would then report a `seasonCount` and an `absent` list
 * drawn from a state the registered set was never compared against, and a dossier would print a
 * departed player under NOT REGISTERED. One statement is one implicit read transaction, so the two
 * scopes are necessarily consistent with each other. (Codex adversarial review of PR #121, round 1,
 * finding 2 [medium].)
 *
 * Rows for OTHER events are read and then dropped here rather than excluded in SQL — the filter has
 * to be applied to a snapshot that already contains them, since "which event is this row for" is
 * exactly the partition being made.
 */
function queryBothScopes(
  db: Db,
  teamId: number,
  eventId: number | null,
): { season: RosterMember[]; registered: RosterMember[] } {
  const rows = db
    .select({
      playerId: teamMemberships.playerId,
      eventId: teamMemberships.eventId,
      canonicalName: players.canonicalName,
      ageRange: players.ageRange,
      plays: players.plays,
    })
    .from(teamMemberships)
    .innerJoin(players, eq(teamMemberships.playerId, players.id))
    .where(and(eq(teamMemberships.teamId, teamId), isNull(teamMemberships.retiredAt)))
    .all();

  const season: RosterMember[] = [];
  const registered: RosterMember[] = [];
  for (const row of rows) {
    const member = {
      playerId: row.playerId,
      canonicalName: row.canonicalName,
      ageRange: row.ageRange,
      plays: row.plays,
    };
    if (row.eventId === null) season.push(member);
    else if (eventId !== null && row.eventId === eventId) registered.push(member);
  }
  return { season: orderedMembers(season), registered: orderedMembers(registered) };
}

/**
 * `options.eventId` is the ALREADY-RESOLVED event's id (`ResolvedEvent.event.id`), threaded down by
 * every caller — never a name looked up again here. `undefined` and `null` both mean "no event
 * scoping applies", matching `TeamProfile`'s existing `leagueScope?: LeagueScope | null` option
 * shape one field over: an OMITTED option and an EXPLICIT null both read as "season roster, no
 * fallback question to ask" rather than two different states a caller has to keep straight.
 */
export function resolveRoster(db: Db, options: { teamId: number; eventId?: number | null }): ResolvedRoster {
  const { teamId } = options;
  const eventId = options.eventId ?? null;

  const { season: seasonMembers, registered: registeredMembers } = queryBothScopes(db, teamId, eventId);
  const seasonCount = seasonMembers.length;

  if (eventId === null) {
    return { source: "season", members: seasonMembers, absent: [], registeredCount: 0, seasonCount };
  }

  const registeredCount = registeredMembers.length;

  if (registeredCount === 0) {
    return { source: "season", members: seasonMembers, absent: [], registeredCount: 0, seasonCount };
  }

  const registeredIds = new Set(registeredMembers.map((m) => m.playerId));
  const absent = seasonMembers.filter((m) => !registeredIds.has(m.playerId));
  return { source: "registered", members: registeredMembers, absent, registeredCount, seasonCount };
}
