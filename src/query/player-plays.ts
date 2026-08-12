// Play-style write service (#149 Task 2) — the captain's recorded statement of which disciplines a
// player plays. Mirrors `src/query/availability.ts`'s shape: a scalar rather than a per-day key, so
// re-writing is a plain UPDATE rather than an upsert against a composite index, and there is no
// day/event to disambiguate.

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { players, teamMemberships } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import { ambiguousMessage } from "../ingest/errors.js";
import { PlayerNotOnHomeRosterError } from "./availability.js";
import { NoHomeTeamError, requireHomeTeam } from "./home-team.js";
import { resolvePlayerTarget } from "./player-profile.js";

// Re-exported so a caller of this write service sees the SAME classes `setAvailability` already
// throws for the identical reasons — "our team only, by design" (spec § Domain model) and "not a
// current roster member" are facts about the home team and the roster, not about availability
// specifically, and #149 does not invent a second name for either one.
export { NoHomeTeamError, PlayerNotOnHomeRosterError };

export class InvalidPlaysError extends Error {}
export class UnknownPlayerTargetError extends Error {}
export class AmbiguousPlayerTargetError extends Error {
  constructor(
    message: string,
    readonly candidates: string[],
  ) {
    super(message);
  }
}

/**
 * The only captured value today. `"singles-only"` is deliberately NOT in this enum — #149 measured
 * zero captured captain statements using it, and an untested branch is forbidden
 * (rules/testing.md). Widen this the day a captain actually says it, with the test that proves it.
 */
const playsSchema = z.enum(["both", "doubles-only"]);
export type Plays = z.infer<typeof playsSchema>;

export type SetPlaysInput = {
  /** A `resolvePlayerTarget`-shaped target — a bare name, an alias, or a `usta:`/`wtn:`/`tr:`
   * prefixed source id — the identical grammar `tn player avail`'s target resolves against. */
  player: string;
  plays: string;
};

export type SetPlaysResult = {
  playerId: number;
  canonicalName: string;
  plays: Plays;
};

/**
 * Records `input.player`'s play-style constraint, resolving the target through `resolvePlayerTarget`
 * (never creates — spec: `pull` enriches, everything else reads or records against what is already
 * on file) and writing it as a plain UPDATE on `players.plays`, since it is a scalar column with no
 * day or event to key on: a second call simply overwrites the first, always leaving exactly one
 * value per player.
 *
 * Refuses, one distinct class per reason (asserted by class, never message text, per this
 * codebase's standing convention): a `plays` value outside the closed enum
 * (`InvalidPlaysError`); no home team designated at all (`NoHomeTeamError`); the target does not
 * resolve to exactly one player (`UnknownPlayerTargetError` / `AmbiguousPlayerTargetError`, the
 * identical taxonomy `resolvePlayerTarget`'s other callers already use); or the resolved player is
 * not a CURRENT (non-retired) member of the home team's roster (`PlayerNotOnHomeRosterError`,
 * reused from `setAvailability` rather than redeclared — see the re-export above).
 *
 * Everything after target resolution runs inside ONE `BEGIN IMMEDIATE` transaction, the same
 * discipline `setAvailability` uses for the identical reason: the roster check and the write must
 * observe one consistent snapshot, not two.
 */
export function setPlays(db: Db, input: SetPlaysInput): SetPlaysResult {
  const playsResult = playsSchema.safeParse(input.plays);
  if (!playsResult.success) {
    throw new InvalidPlaysError(`invalid plays value "${input.plays}" (expected both | doubles-only)`);
  }
  const plays = playsResult.data;

  return db.transaction((tx) => {
    const homeTeam = requireHomeTeam(tx);

    const resolution = resolvePlayerTarget(tx, input.player);
    if (resolution.kind === "not-found") {
      throw new UnknownPlayerTargetError(`unknown target "${input.player}"`);
    }
    if (resolution.kind === "ambiguous") {
      throw new AmbiguousPlayerTargetError(
        ambiguousMessage({
          incoming: input.player,
          candidates: resolution.candidates,
          context: "player name target",
        }),
        resolution.candidates,
      );
    }
    const playerId = resolution.playerId;

    const onRoster =
      tx
        .select({ id: teamMemberships.id })
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.playerId, playerId),
            eq(teamMemberships.teamId, homeTeam.id),
            // Issue #49's rule, unchanged one door over: a retired row is not a CURRENT roster row.
            isNull(teamMemberships.retiredAt),
          ),
        )
        .all().length > 0;
    if (!onRoster) {
      throw new PlayerNotOnHomeRosterError(`player ${playerId} is not on the home team's roster`);
    }

    const row = tx.update(players).set({ plays }).where(eq(players.id, playerId)).returning().get();

    return { playerId: row.id, canonicalName: row.canonicalName, plays };
  }, { behavior: "immediate" });
}
