import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  courtMatchPlayers,
  courtMatches,
  players,
  ratingObservations,
  teamMatches,
  teamMemberships,
  teams,
} from "../db/schema.js";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
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

/**
 * Team's own natural key is `teams.name` (existing unique index `teams_name_unique`).
 *
 * On conflict, only the columns this pull actually CARRIES are written. Writing `values.x ?? null`
 * across the board instead would mean a TennisRecord pull — which knows nothing about
 * `tennislink_url` and passes `district: null` unconditionally — silently erased whatever another
 * source had already recorded there, on every re-pull. Nothing sets those columns today, so the
 * erasure is latent rather than live; #27 (TennisLink) is the run that would have hit it.
 */
export function upsertTeam(db: Db, values: TeamInsert): TeamRow {
  const set: Partial<TeamInsert> = {};
  if (values.section !== undefined && values.section !== null) set.section = values.section;
  if (values.district !== undefined && values.district !== null) set.district = values.district;
  if (values.tennislinkUrl !== undefined && values.tennislinkUrl !== null) {
    set.tennislinkUrl = values.tennislinkUrl;
  }
  if (values.tennisrecordUrl !== undefined && values.tennisrecordUrl !== null) {
    set.tennisrecordUrl = values.tennisrecordUrl;
  }
  // SQLite rejects an empty `DO UPDATE SET`, and a pull that carries no optional column at all is
  // a real case — re-assign the conflict key to itself as a no-op so the row is still returned.
  if (Object.keys(set).length === 0) set.name = values.name;

  return db
    .insert(teams)
    .values(values)
    .onConflictDoUpdate({ target: teams.name, set })
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
    // A row with no source id still has to be idempotent, and the partial index deliberately does
    // NOT cover it. An UNPLAYED fixture on a team page is exactly this case — its result cell has
    // no result link, so no `mid=` — and re-pulling that page weekly through a plain insert grew
    // one duplicate row per unplayed fixture per pull.
    //
    // The fallback key is the UNORDERED team pair plus the date. Ordered `(home, visiting, date)`
    // is not an identity here: team-pull assigns the PULLED team to `home`, so the same fixture
    // pulled from the opposing team's page searches `(B,A,date)`, misses `(A,B,date)`, and inserts
    // a duplicate anyway — the first fix reproduced the very defect it was closing, one perspective
    // over. (Codex adversarial review, PR #31, rated high.) Home/visiting is page perspective, not
    // real home/away, so it cannot be part of an identity; the pair-as-a-set can.
    // Date alone is NOT an identity: two fixtures between the same pair on the same day (a
    // doubleheader at 09:00 and 17:00) would collapse into one row and the second would be lost
    // with nothing left to detect it by. (Codex adversarial review, PR #31, rated high.) Scheduled
    // time and site are now persisted precisely so they can discriminate here.
    const matchesColumn = (column: AnySQLiteColumn, value: string | null | undefined) =>
      value === null || value === undefined ? isNull(column) : eq(column, value);

    const existing = db
      .select()
      .from(teamMatches)
      .where(
        and(
          isNull(teamMatches.sourceMatchId),
          matchesColumn(teamMatches.playedOn, values.playedOn),
          matchesColumn(teamMatches.scheduledTime, values.scheduledTime),
          matchesColumn(teamMatches.site, values.site),
          or(
            and(
              eq(teamMatches.homeTeamId, values.homeTeamId),
              eq(teamMatches.visitingTeamId, values.visitingTeamId),
            ),
            and(
              eq(teamMatches.homeTeamId, values.visitingTeamId),
              eq(teamMatches.visitingTeamId, values.homeTeamId),
            ),
          ),
        ),
      )
      .all()[0];
    if (existing === undefined) return db.insert(teamMatches).values(values).returning().get();
    // The stored row may hold the OPPOSITE orientation (it was first written from the other team's
    // page). Court counts are orientation-bound, so they are swapped to match the stored row rather
    // than written straight through — otherwise a re-pull from the other side would silently invert
    // the score while leaving the team columns alone.
    const reversed = existing.homeTeamId === values.visitingTeamId && existing.visitingTeamId === values.homeTeamId;
    const incomingHome = values.homeCourtsWon ?? null;
    const incomingVisiting = values.visitingCourtsWon ?? null;
    return db
      .update(teamMatches)
      .set({
        eventId: values.eventId ?? null,
        homeCourtsWon: reversed ? incomingVisiting : incomingHome,
        visitingCourtsWon: reversed ? incomingHome : incomingVisiting,
      })
      .where(eq(teamMatches.id, existing.id))
      .returning()
      .get();
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
    // Unreachable from `pullPlayer` today — the match-history parser throws rather than emit a
    // court with no `mid=`. It is still deduped on its natural composite rather than blind-inserted,
    // because the blind insert is a silent non-idempotency landmine for the next source that CAN
    // produce an id-less court (the same defect that shipped in `upsertTeamMatch` above).
    const existing = db
      .select()
      .from(courtMatches)
      .where(
        and(
          isNull(courtMatches.sourceMatchId),
          eq(courtMatches.slot, values.slot),
          values.playedOn === null || values.playedOn === undefined
            ? isNull(courtMatches.playedOn)
            : eq(courtMatches.playedOn, values.playedOn),
          values.teamMatchId === null || values.teamMatchId === undefined
            ? isNull(courtMatches.teamMatchId)
            : eq(courtMatches.teamMatchId, values.teamMatchId),
        ),
      )
      .all()[0];
    if (existing === undefined) return db.insert(courtMatches).values(values).returning().get();
    return db
      .update(courtMatches)
      .set({
        discipline: values.discipline,
        winnerSide: values.winnerSide ?? null,
        score: values.score ?? null,
        leagueContext: values.leagueContext ?? null,
      })
      .where(eq(courtMatches.id, existing.id))
      .returning()
      .get();
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
