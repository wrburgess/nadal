// DB assembly for a team's predicted lineup (#17 PR B) — the sibling of `team-profile.ts` and
// `player-profile.ts`, and thin for the same reason: it fetches rows with drizzle, hands them to
// `derive.ts`'s pure `predictedLineup`, and attaches the names a presenter needs. The heuristic
// itself lives entirely in `derive.ts`, where it can be tested exhaustively against hand-built
// inputs; nothing here re-implements a rule.
//
// Spec § Deliverables 1 asks for "a predicted lineup honestly labeled a guess". Every name this
// module resolves exists so a presenter can print a person rather than a database id — the exact
// defect #16 shipped and #17 PR A fixed one layer over.

import { eq, inArray } from "drizzle-orm";
import { players, ratingObservations, teamMemberships, teams } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import { NoCourtMatchHistoryError, predictedLineup } from "./derive.js";
import { courtMatchRowsForPlayers } from "./player-profile.js";
import type { LineupBasis, LineupConfidence, PredictedLineupResult, RatingSource } from "./types.js";

export { NoCourtMatchHistoryError };

export type LineupPlanPlayer = {
  playerId: number;
  canonicalName: string;
};

export type LineupPlanSlot = {
  slot: string;
  discipline: string;
  players: LineupPlanPlayer[];
  confidence: LineupConfidence;
  basis: LineupBasis;
  support: number;
};

export type LineupPlan = {
  teamId: number;
  teamName: string;
  slots: LineupPlanSlot[];
  unplaced: (LineupPlanPlayer & { courtMatches: number })[];
  /** The single rating scale every comparison was made within — `null` when nobody is rated. */
  ratingSource: RatingSource | null;
  /** Roster players ranked within `ratingSource`, strongest first. Carried through rather than
   * dropped because it is the only observable record of the ORDER every tie-break and every
   * rating-based pairing used — without it, a caller (or a test) can see which players were rated
   * but not how they compared, which is the half that actually drives placement. */
  ranked: LineupPlanPlayer[];
  /** Roster players with no observation in `ratingSource`, by name, so the gap is printable. */
  unranked: LineupPlanPlayer[];
  slotSource: PredictedLineupResult["slotSource"];
  observedCourtMatches: number;
  rosterSize: number;
};

/**
 * Builds a team's predicted lineup: the roster from `team_memberships`, that roster's court-match
 * history, and every rating observation for those players, run through `predictedLineup`.
 *
 * Throws `NoCourtMatchHistoryError` when the team has no court matches on file — a caller renders
 * that as an honest absence rather than an empty lineup, which would read as "we predict nobody
 * plays". `report build` catches it for exactly that reason.
 *
 * A player on the roster more than once (one `team_memberships` row per event — the schema allows
 * it, and a district roster plus a travel roster is the normal case) is counted ONCE here: the
 * roster is a set of people, and a duplicate id would let the same player be placed on two courts.
 */
export function getLineupPlan(db: Db, teamId: number): LineupPlan {
  const teamRow = db.select().from(teams).where(eq(teams.id, teamId)).all()[0];
  if (teamRow === undefined) throw new Error(`getLineupPlan: no team with id ${teamId}`);

  const rosterRows = db
    .select({ playerId: teamMemberships.playerId, canonicalName: players.canonicalName })
    .from(teamMemberships)
    .innerJoin(players, eq(teamMemberships.playerId, players.id))
    .where(eq(teamMemberships.teamId, teamId))
    .all();

  const nameById = new Map<number, string>();
  for (const r of rosterRows) nameById.set(r.playerId, r.canonicalName);
  // Sorted so the roster handed to the pure layer is order-stable, and de-duplicated via the Map
  // above (see the doc comment: one person, however many event-scoped membership rows).
  const rosterPlayerIds = Array.from(nameById.keys()).sort((a, b) => a - b);

  const courtRows = courtMatchRowsForPlayers(db, rosterPlayerIds);

  const observationRows =
    rosterPlayerIds.length === 0
      ? []
      : db.select().from(ratingObservations).where(inArray(ratingObservations.playerId, rosterPlayerIds)).all();
  const observationsByPlayer = new Map<number, typeof observationRows>();
  for (const obs of observationRows) {
    const list = observationsByPlayer.get(obs.playerId) ?? [];
    list.push(obs);
    observationsByPlayer.set(obs.playerId, list);
  }

  const prediction = predictedLineup({
    rows: courtRows,
    rosterPlayerIds,
    ratings: rosterPlayerIds.map((playerId) => ({
      playerId,
      observations: (observationsByPlayer.get(playerId) ?? []).map((o) => ({
        id: o.id,
        source: o.source,
        value: o.value,
        ratingType: o.ratingType,
        observedOn: o.observedOn,
      })),
    })),
  });

  // `player #<id>` is unreachable in practice — every id below came from the roster query this map
  // was built from — and is kept only so a presenter can never be handed `undefined`, matching the
  // existing convention in `player-profile.ts` / `team-profile.ts`.
  const named = (playerId: number): LineupPlanPlayer => ({
    playerId,
    canonicalName: nameById.get(playerId) ?? `player #${playerId}`,
  });

  return {
    teamId: teamRow.id,
    teamName: teamRow.name,
    slots: prediction.slots.map((s) => ({
      slot: s.slot,
      discipline: s.discipline,
      players: s.playerIds.map(named),
      confidence: s.confidence,
      basis: s.basis,
      support: s.support,
    })),
    unplaced: prediction.unplaced.map((u) => ({ ...named(u.playerId), courtMatches: u.courtMatches })),
    ratingSource: prediction.ratingSource,
    ranked: prediction.rankedPlayerIds.map(named),
    unranked: prediction.unrankedPlayerIds.map(named),
    slotSource: prediction.slotSource,
    observedCourtMatches: prediction.observedCourtMatches,
    rosterSize: rosterPlayerIds.length,
  };
}
