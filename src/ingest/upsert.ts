import { eq, sql } from "drizzle-orm";
import {
  courtMatchPlayers,
  courtMatches,
  players,
  ratingObservations,
  teamMatches,
  teamMemberships,
  teams,
} from "../db/schema.js";
import type { Db } from "./db-types.js";

type TeamRow = typeof teams.$inferSelect;
type TeamInsert = typeof teams.$inferInsert;
type PlayerRow = typeof players.$inferSelect;
type TeamMembershipRow = typeof teamMemberships.$inferSelect;
type TeamMembershipInsert = typeof teamMemberships.$inferInsert;
type TeamMatchRow = typeof teamMatches.$inferSelect;
type TeamMatchInsert = typeof teamMatches.$inferInsert;
type CourtMatchRow = typeof courtMatches.$inferSelect;
type CourtMatchInsert = typeof courtMatches.$inferInsert;
type CourtMatchPlayerRow = typeof courtMatchPlayers.$inferSelect;
type CourtMatchPlayerInsert = typeof courtMatchPlayers.$inferInsert;
type RatingObservationRow = typeof ratingObservations.$inferSelect;
type RatingObservationInsert = typeof ratingObservations.$inferInsert;

/**
 * The idempotent write primitives every pipeline (Task 7) writes through, inside ONE
 * `sqlite.transaction` per run (spec § Ingestion: re-run anytime, nothing duplicates; a parse
 * failure mid-pull writes nothing rather than half a team). Six of these seven target a named
 * unique index directly with `onConflictDoUpdate`/`onConflictDoNothing` — the natural key is
 * known and DB-enforced. `upsertPlayer` is the one exception: no players column is both
 * non-nullable and globally unique for a TennisRecord-only pull (a bare `tennisrecord_url` is not
 * DB-unique on purpose — two page URLs can legitimately name the same person after a fuzzy-match
 * merge decision), so its identity is resolved in the application layer by
 * `src/ingest/identity.ts` BEFORE this module ever runs; `upsertPlayer` takes that resolved id and
 * writes to it directly, which is exactly as idempotent for a fixed id.
 */

/** Team's own natural key is `teams.name` (existing unique index `teams_name_unique`). */
export function upsertTeam(db: Db, values: TeamInsert): TeamRow {
  return db
    .insert(teams)
    .values(values)
    .onConflictDoUpdate({
      target: teams.name,
      set: {
        section: values.section ?? null,
        district: values.district ?? null,
        tennislinkUrl: values.tennislinkUrl ?? null,
        tennisrecordUrl: values.tennisrecordUrl ?? null,
      },
    })
    .returning()
    .get();
}

export type UpsertPlayerFields = {
  id: number;
  canonicalName?: string;
  ustaUaid?: string | null;
  wtnTennisId?: string | null;
  tennisrecordUrl?: string | null;
  ageRange?: string | null;
  gender?: string | null;
};

/** Writes to an id already resolved by `resolvePlayer` — see the module comment above. */
export function upsertPlayer(db: Db, values: UpsertPlayerFields): PlayerRow {
  const { id, ...fields } = values;
  const set: Partial<typeof players.$inferInsert> = {};
  if (fields.canonicalName !== undefined) set.canonicalName = fields.canonicalName;
  if (fields.ustaUaid !== undefined) set.ustaUaid = fields.ustaUaid;
  if (fields.wtnTennisId !== undefined) set.wtnTennisId = fields.wtnTennisId;
  if (fields.tennisrecordUrl !== undefined) set.tennisrecordUrl = fields.tennisrecordUrl;
  if (fields.ageRange !== undefined) set.ageRange = fields.ageRange;
  if (fields.gender !== undefined) set.gender = fields.gender;

  if (Object.keys(set).length > 0) {
    db.update(players).set(set).where(eq(players.id, id)).run();
  }
  const row = db.select().from(players).where(eq(players.id, id)).all()[0];
  if (row === undefined) throw new Error(`upsertPlayer: no player with id ${id}`);
  return row;
}

/**
 * Targets whichever of the two membership unique indexes applies: the 3-column
 * `membership_unique` when `eventId` is a real event, or the partial `membership_unique_no_event`
 * when it is null (SQLite treats NULLs as distinct, so the 3-column index alone fails open there).
 *
 * Membership carries no other mutable column, so the `set` re-assigns `playerId` to itself — a
 * genuine no-op, chosen over `onConflictDoNothing` because SQLite's upsert grammar puts a target's
 * `WHERE` clause (needed to match the PARTIAL no-event index) before `DO ...`, and drizzle's
 * `onConflictDoNothing` only ever emits it after `DO NOTHING`, which SQLite rejects outright for a
 * targeted conflict — confirmed empirically, not assumed from the docs.
 */
export function upsertMembership(db: Db, values: TeamMembershipInsert): TeamMembershipRow {
  if (values.eventId === null || values.eventId === undefined) {
    return db
      .insert(teamMemberships)
      .values({ ...values, eventId: null })
      .onConflictDoUpdate({
        target: [teamMemberships.teamId, teamMemberships.playerId],
        targetWhere: sql`event_id IS NULL`,
        set: { playerId: values.playerId },
      })
      .returning()
      .get();
  }
  return db
    .insert(teamMemberships)
    .values(values)
    .onConflictDoUpdate({
      target: [teamMemberships.playerId, teamMemberships.teamId, teamMemberships.eventId],
      set: { playerId: values.playerId },
    })
    .returning()
    .get();
}

/**
 * `source_match_id` (the `mid=` id) identifies the TEAM match and is the whole idempotency key —
 * partial predicate for the same NULLs-are-distinct reason as every other partial index here. A
 * row with no `source_match_id` (outside a TennisRecord pull) is always a plain insert: there is
 * no key to deduplicate on.
 */
export function upsertTeamMatch(db: Db, values: TeamMatchInsert): TeamMatchRow {
  if (values.sourceMatchId === null || values.sourceMatchId === undefined) {
    return db.insert(teamMatches).values(values).returning().get();
  }
  return db
    .insert(teamMatches)
    .values(values)
    .onConflictDoUpdate({
      target: teamMatches.sourceMatchId,
      targetWhere: sql`source_match_id IS NOT NULL`,
      set: {
        eventId: values.eventId ?? null,
        homeTeamId: values.homeTeamId,
        visitingTeamId: values.visitingTeamId,
        playedOn: values.playedOn ?? null,
        homeCourtsWon: values.homeCourtsWon ?? null,
        visitingCourtsWon: values.visitingCourtsWon ?? null,
      },
    })
    .returning()
    .get();
}

/**
 * The `mid=` id identifies the TEAM match, not the court within it — `slot` completes the pair,
 * which is why the conflict target is the two columns together, not `source_match_id` alone.
 */
export function upsertCourtMatch(db: Db, values: CourtMatchInsert): CourtMatchRow {
  if (values.sourceMatchId === null || values.sourceMatchId === undefined) {
    return db.insert(courtMatches).values(values).returning().get();
  }
  return db
    .insert(courtMatches)
    .values(values)
    .onConflictDoUpdate({
      target: [courtMatches.sourceMatchId, courtMatches.slot],
      targetWhere: sql`source_match_id IS NOT NULL`,
      set: {
        teamMatchId: values.teamMatchId ?? null,
        discipline: values.discipline,
        winnerSide: values.winnerSide ?? null,
        score: values.score ?? null,
        leagueContext: values.leagueContext ?? null,
        playedOn: values.playedOn ?? null,
      },
    })
    .returning()
    .get();
}

export function upsertCourtMatchPlayers(db: Db, values: CourtMatchPlayerInsert): CourtMatchPlayerRow {
  return db
    .insert(courtMatchPlayers)
    .values(values)
    .onConflictDoUpdate({
      target: [courtMatchPlayers.courtMatchId, courtMatchPlayers.playerId],
      set: { side: values.side },
    })
    .returning()
    .get();
}

export function upsertRatingObservation(db: Db, values: RatingObservationInsert): RatingObservationRow {
  return db
    .insert(ratingObservations)
    .values(values)
    .onConflictDoUpdate({
      target: [ratingObservations.playerId, ratingObservations.source, ratingObservations.observedOn],
      set: { value: values.value, ratingType: values.ratingType ?? null },
    })
    .returning()
    .get();
}
