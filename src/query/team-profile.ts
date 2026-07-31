// DB assembly for a team's dossier (Task 4) — the twin of player-profile.ts. Fetches rows with
// drizzle, hands them to `derive.ts`, and returns a typed profile; kept thin for the same reason.

import { eq, or } from "drizzle-orm";
import { players, teamMatches, teamMemberships, teams } from "../db/schema.js";
import { findTeamByName } from "../ingest/identity.js";
import type { Db } from "../ingest/db-types.js";
import { courtMatchRowsForPlayers } from "./player-profile.js";
import { headToHead, slotTendencies, teamMatchRecord, windowedRecord } from "./derive.js";
import type { HeadToHeadResult, SlotTendency, TeamMatchRecordResult, TeamMatchRow, WindowedRecordResult } from "./types.js";

export type TeamTargetResolution =
  | { kind: "ok"; teamId: number }
  | { kind: "not-found" }
  | { kind: "ambiguous"; candidates: string[] };

/**
 * Resolve a `team show`-style target to an existing team id — never creates. `tr:` selects by
 * `tennisrecord_url`; a bare name goes through `findTeamByName` (src/ingest/identity.ts, reused
 * unchanged — teams have no alias table, so no alias-folding wrapper is needed here the way
 * `resolvePlayerTarget` needs one for players).
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

export type TeamCrossHeadToHead = HeadToHeadResult & { playerId: number };

export type TeamProfile = {
  teamId: number;
  teamName: string;
  /** Alphabetical by canonical name (deterministic regardless of membership insertion order),
   * tie-broken by playerId — a member with no `team_memberships` row is never included, since the
   * roster IS that query. */
  roster: RosterMemberProfile[];
  teamRecord: TeamMatchRecordResult;
  /** Per-slot counts aggregated across the whole roster. */
  slotTendencies: SlotTendency[];
  /** One row per (own roster player, versus roster player) cross pair, including explicit
   * zero rows for a pair that never met. `null` — not an empty array — when no `versusTeamId`
   * was given, so "not requested" stays distinguishable from "requested, nothing found". */
  headToHead: TeamCrossHeadToHead[] | null;
};

export function getTeamProfile(
  db: Db,
  teamId: number,
  options: { since: string; versusTeamId?: number },
): TeamProfile {
  const teamRow = db.select().from(teams).where(eq(teams.id, teamId)).all()[0];
  if (teamRow === undefined) throw new Error(`getTeamProfile: no team with id ${teamId}`);

  const rosterPlayerRows = db
    .select({ playerId: teamMemberships.playerId, canonicalName: players.canonicalName, ageRange: players.ageRange })
    .from(teamMemberships)
    .innerJoin(players, eq(teamMemberships.playerId, players.id))
    .where(eq(teamMemberships.teamId, teamId))
    .all()
    .sort(
      (a, b) => a.canonicalName.toLowerCase().localeCompare(b.canonicalName.toLowerCase()) || a.playerId - b.playerId,
    );

  const versusPlayerIds =
    options.versusTeamId === undefined
      ? []
      : db
          .select({ playerId: teamMemberships.playerId })
          .from(teamMemberships)
          .where(eq(teamMemberships.teamId, options.versusTeamId))
          .all()
          .map((r) => r.playerId);

  const allRelevantPlayerIds = [...rosterPlayerRows.map((r) => r.playerId), ...versusPlayerIds];
  const courtRows = courtMatchRowsForPlayers(db, allRelevantPlayerIds);

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
          headToHead(courtRows, member.playerId, versusPlayerIds).map((h) => ({ playerId: member.playerId, ...h })),
        );

  return {
    teamId: teamRow.id,
    teamName: teamRow.name,
    roster,
    teamRecord: teamMatchRecord(teamMatchRows, teamId, { since: options.since }),
    slotTendencies: aggregatedSlotTendencies,
    headToHead: headToHeadRows,
  };
}
