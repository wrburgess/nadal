// Availability write service (Task 3). Spec § Domain model: "structured per-player per-event-day
// … lineup planning depends on it" and, per CaptainNote's sibling note, populated "for our team
// only, by design" — so every write here is scoped to the currently-designated home team (nadal
// ADR 0001), never any team on file. `availability.eventId` is resolved from a bare day rather than
// taken as a fourth caller-supplied field (Task 3 decision 2): the event whose `starts_on`..`ends_on`
// range contains the day, inclusive at both ends.

import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { availability, events, teamMemberships } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import { NoHomeTeamError, requireHomeTeam } from "./home-team.js";

type EventRow = typeof events.$inferSelect;
type AvailabilityRow = typeof availability.$inferSelect;

// Re-exported so an existing `import { NoHomeTeamError } from "./availability.js"` keeps working —
// the class itself now lives in `home-team.ts`, shared with `captain-notes.ts` (both are "our team
// only, by design" per spec § Domain model, and both need the identical refusal).
export { NoHomeTeamError };

export class InvalidAvailabilityStatusError extends Error {}
export class PlayerNotOnHomeRosterError extends Error {}
export class NoEventForDayError extends Error {}
export class AmbiguousEventForDayError extends Error {
  constructor(
    message: string,
    readonly candidates: { id: number; name: string }[],
  ) {
    super(message);
  }
}

const availabilityStatusSchema = z.enum(["available", "unavailable", "uncertain"]);

export type SetAvailabilityInput = {
  playerId: number;
  /** ISO date, e.g. "2026-08-29". */
  day: string;
  status: string;
};

export type SetAvailabilityResult = {
  availabilityId: number;
  eventId: number;
  eventName: string;
  status: AvailabilityRow["status"];
};

/**
 * Every event whose `starts_on`..`ends_on` range contains `day`, inclusive at both ends. An event
 * with either date `null` never matches — a null range must not silently swallow every date, which
 * is exactly what an unguarded string comparison against `null` would do in JS (though not in SQL,
 * where `NULL <= x` is simply never true; `isNotNull` documents the intent explicitly rather than
 * relying on that SQL behavior being obvious to the next reader).
 */
function eventsForDay(db: Db, day: string): EventRow[] {
  return db
    .select()
    .from(events)
    .where(and(isNotNull(events.startsOn), isNotNull(events.endsOn), lte(events.startsOn, day), gte(events.endsOn, day)))
    .all();
}

/**
 * Records `playerId`'s availability for the event day resolved from `input.day`, upserting on the
 * schema's existing `(player_id, event_id, day)` unique index — idempotent per spec § Ingestion
 * discipline: a second call with the same (player, day) updates the status in place rather than
 * duplicating a row.
 *
 * Refuses, naming the reason via a distinct error class (never a shared generic error — Task 3's
 * testing strategy: assert on class, never on message text), when: the status is not one of the
 * three known values; no home team is designated at all; the day resolves to zero or more than one
 * event; or the player is not on the home team's roster. "On the roster" is ANY
 * `team_memberships` row for (playerId, homeTeamId) regardless of `event_id` — including a NULL
 * `event_id`, which is what every roster `tn team pull` actually writes (docs/findings.md, #15) —
 * not a row scoped to the SAME event `day` resolved to; requiring that exact match would refuse
 * availability for every real pulled roster, since nothing in the current ingest pipeline ever
 * writes an event-scoped membership.
 */
export function setAvailability(db: Db, input: SetAvailabilityInput): SetAvailabilityResult {
  const statusResult = availabilityStatusSchema.safeParse(input.status);
  if (!statusResult.success) {
    throw new InvalidAvailabilityStatusError(
      `invalid availability status "${input.status}" (expected available | unavailable | uncertain)`,
    );
  }
  const status = statusResult.data;

  const homeTeam = requireHomeTeam(db);

  const onRoster =
    db
      .select({ id: teamMemberships.id })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.playerId, input.playerId), eq(teamMemberships.teamId, homeTeam.id)))
      .all().length > 0;
  if (!onRoster) {
    throw new PlayerNotOnHomeRosterError(`player ${input.playerId} is not on the home team's roster`);
  }

  const candidateEvents = eventsForDay(db, input.day);
  if (candidateEvents.length === 0) {
    throw new NoEventForDayError(`no event on file covers day "${input.day}"`);
  }
  if (candidateEvents.length > 1) {
    throw new AmbiguousEventForDayError(
      `day "${input.day}" falls within more than one event: ${candidateEvents.map((e) => e.name).join(", ")}`,
      candidateEvents.map((e) => ({ id: e.id, name: e.name })),
    );
  }
  const event = candidateEvents[0]!;

  const row = db
    .insert(availability)
    .values({ playerId: input.playerId, eventId: event.id, day: input.day, status })
    .onConflictDoUpdate({
      target: [availability.playerId, availability.eventId, availability.day],
      set: { status },
    })
    .returning()
    .get();

  return { availabilityId: row.id, eventId: event.id, eventName: event.name, status: row.status };
}
