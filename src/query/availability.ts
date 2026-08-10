// Availability write service (Task 3). Spec § Domain model: "structured per-player per-event-day
// … lineup planning depends on it" and, per CaptainNote's sibling note, populated "for our team
// only, by design" — so every write here is scoped to the currently-designated home team (nadal
// ADR 0001), never any team on file. `availability.eventId` is resolved from a bare day rather than
// taken as a fourth caller-supplied field (Task 3 decision 2): the event whose `starts_on`..`ends_on`
// range contains the day, inclusive at both ends.

import { and, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { availability, events, teamMemberships } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import { NoHomeTeamError, requireHomeTeam } from "./home-team.js";
import { enumerateIsoDays, isIsoDay } from "./iso-day.js";
import { resolveRoster } from "./roster.js";

type EventRow = typeof events.$inferSelect;
type AvailabilityRow = typeof availability.$inferSelect;

// Re-exported so an existing `import { NoHomeTeamError } from "./availability.js"` keeps working —
// the class itself now lives in `home-team.ts`, shared with `captain-notes.ts` (both are "our team
// only, by design" per spec § Domain model, and both need the identical refusal).
export { NoHomeTeamError };

export class InvalidAvailabilityStatusError extends Error {}
export class InvalidAvailabilityDayError extends Error {}
export class PlayerNotOnHomeRosterError extends Error {}
export class NoEventForDayError extends Error {}
export class UnknownEventError extends Error {}
export class EventDoesNotCoverDayError extends Error {}
export class AmbiguousEventForDayError extends Error {
  constructor(
    message: string,
    readonly candidates: { id: number; name: string }[],
  ) {
    super(message);
  }
}

const availabilityStatusSchema = z.enum(["available", "unavailable", "uncertain"]);

/**
 * Rejects anything that is not a real `YYYY-MM-DD` calendar date.
 *
 * `day` is half of this table's `(player_id, event_id, day)` upsert key, and `eventsForDay`
 * compares it as TEXT — so before this guard existed, any malformed string that merely SORTED
 * inside an event's range matched that event and was stored verbatim, defeating the idempotent
 * upsert the unique index exists to give and inventing days that no per-event-day read will ever
 * match. It is closed at the write service, where BOTH presenters (CLI `tn player avail` and the
 * MCP `player_avail` tool) inherit it, rather than in either presenter.
 *
 * The *rule* now lives in `iso-day.ts`, shared with `events.ts` — whose `starts_on`/`ends_on` are
 * the other half of the same TEXT comparison, so the two must agree on what a day is or a range
 * written by one could never be matched by the other. The error CLASS stays local: callers assert
 * on class, never on message text.
 */
function requireIsoDay(day: string): string {
  if (!isIsoDay(day)) {
    throw new InvalidAvailabilityDayError(`invalid day "${day}" (expected a real YYYY-MM-DD date)`);
  }
  return day;
}

export type SetAvailabilityInput = {
  playerId: number;
  /** ISO date, e.g. "2026-08-29". */
  day: string;
  status: string;
  /**
   * Which event this day belongs to, by name — required only when the day falls inside more than
   * one event's range, and rejected if the named event does not actually cover the day.
   *
   * This exists because overlapping ranges are a NORMAL domain state, not a misconfiguration: a
   * district league season runs Mar-Jun and a districts tournament sits inside it in May, so every
   * day in that window resolves to two events and day-only lookup can only refuse. Before #17 PR B
   * nothing wrote the `events` table at all, so the overlap was unreachable and the refusal looked
   * theoretical; `addEvent` made it the first thing a real setup hits. (Found by the independent
   * Codex review of PR #47, rated high.)
   *
   * A disambiguator rather than a guess, matching how every other ambiguous target in this CLI is
   * resolved — GRAMMAR.md: "Ambiguous names error with candidates listed — never guess."
   */
  eventName?: string;
};

export type SetAvailabilityResult = {
  availabilityId: number;
  eventId: number;
  eventName: string;
  status: AvailabilityRow["status"];
  /**
   * #129: whether `playerId` is in `resolveRoster`'s `members` for the resolved event — the SAME
   * set the dossier's availability grid renders over (`getTeamProfile` → `resolveRoster`,
   * src/query/roster.ts:96). `false` does not mean the write above was refused; `onRoster` above
   * still accepts ANY current home-team membership, season-scoped included, by design (a real
   * `tn team pull` roster always writes `event_id: null`) — so a season-roster player who has not
   * registered for THIS event still passes it and is still stored. It simply will not render on
   * that event's dossier until they register, and before this field existed nothing said so: a
   * missing SIGNAL, not data loss, the same class #126/PR #134 closed one door over (captain notes,
   * the home-team read) — read from `resolved.members` rather than re-derived, so an event with no
   * registered roster at all (which falls back to the season roster inside `resolveRoster`) reports
   * `true` for a season player without this needing to special-case that fallback itself.
   */
  onEventRoster: boolean;
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
 * Picks which of the day's candidate events this write belongs to.
 *
 * Unambiguous day (exactly one candidate) → that event, and a supplied `eventName` still has to
 * match it: silently ignoring a name the caller went out of their way to give would be the same
 * "accepted but not honored" failure the grammar's unrecognized-flag rule exists to prevent.
 *
 * Ambiguous day → the caller must name the event. That is a disambiguator, never a guess: picking
 * the narrowest range, or the tournament over the league, would be inventing a domain rule nobody
 * stated, and GRAMMAR.md's standing answer for an ambiguous target is to error with the candidates
 * listed. The refusal message now names the fix rather than only the problem.
 *
 * Matching is exact on the trimmed name, the same key `addEvent` writes on — no fuzzy fallback, so
 * a near-miss refuses loudly instead of resolving to a neighbouring event.
 */
function selectEvent(db: Db, day: string, candidates: EventRow[], eventName?: string): EventRow {
  if (eventName !== undefined) {
    const wanted = eventName.trim();
    const chosen = candidates.find((e) => e.name === wanted);
    if (chosen !== undefined) return chosen;
    // Distinguish "no such event at all" from "that event exists but not on this day" — they call
    // for different corrections, and collapsing them would send the caller hunting the wrong one.
    const existsElsewhere = db.select().from(events).where(eq(events.name, wanted)).all().length > 0;
    if (existsElsewhere) {
      throw new EventDoesNotCoverDayError(`event "${wanted}" does not cover day "${day}"`);
    }
    throw new UnknownEventError(`no event named "${wanted}"`);
  }

  if (candidates.length > 1) {
    throw new AmbiguousEventForDayError(
      `day "${day}" falls within more than one event: ${candidates.map((e) => e.name).join(", ")}` +
        ` — name the one you mean`,
      candidates.map((e) => ({ id: e.id, name: e.name })),
    );
  }
  return candidates[0]!;
}

/**
 * Records `playerId`'s availability for the event day resolved from `input.day`, upserting on the
 * schema's existing `(player_id, event_id, day)` unique index — idempotent per spec § Ingestion
 * discipline: a second call with the same (player, day) updates the status in place rather than
 * duplicating a row.
 *
 * Refuses, naming the reason via a distinct error class (never a shared generic error — Task 3's
 * testing strategy: assert on class, never on message text), when: the status is not one of the
 * three known values; the day is not a real `YYYY-MM-DD` calendar date (see `requireIsoDay` — it is
 * half the upsert key, so an unnormalized one silently splits a single day across rows); no home
 * team is designated at all; the day resolves to zero events, or to more than one with no
 * `eventName` given to choose between them, or to an `eventName` that is unknown or does not cover
 * the day; or the player is not on the home team's CURRENT roster. "On the roster" is ANY
 * non-retired `team_memberships` row for (playerId, homeTeamId) regardless of `event_id` —
 * including a NULL `event_id`, which is what every roster `tn team pull` actually writes
 * (docs/findings.md, #15) — not a row scoped to the SAME event `day` resolved to; requiring that
 * exact match would refuse availability for every real pulled roster, since nothing in the current
 * ingest pipeline ever writes an event-scoped membership. Issue #49: "current" is the newer half of
 * that sentence — a soft-retired row (`retired_at IS NOT NULL`) no longer counts as "on the
 * roster" either, so `tn player avail` now refuses for a player the last successful `tn team pull`
 * did not see — a new refusal on a previously-working command, by design (stated in the PR body).
 */
export function setAvailability(db: Db, input: SetAvailabilityInput): SetAvailabilityResult {
  const statusResult = availabilityStatusSchema.safeParse(input.status);
  if (!statusResult.success) {
    throw new InvalidAvailabilityStatusError(
      `invalid availability status "${input.status}" (expected available | unavailable | uncertain)`,
    );
  }
  const status = statusResult.data;
  const day = requireIsoDay(input.day);

  // Every DB read and the write run in ONE `BEGIN IMMEDIATE` transaction — the OTHER half of the
  // event-range invariant, and it has to be here as well as in `addEvent` because the race runs in
  // both directions.
  //
  // `addEvent` serializing its own check-then-update closes the ordering where the event moves
  // second. This closes the one where it moves FIRST: without it, this function resolves an event
  // (and its range), another process narrows that event — finding no availability to strand,
  // because none is committed yet — and this upsert then lands a row outside the range that now
  // exists. Same stranded row, opposite order, and `addEvent`'s guard cannot see it. Two
  // `IMMEDIATE` writers cannot overlap, so whichever commits first, the second observes the
  // committed state and validates against reality rather than a snapshot it already lost.
  // (Found by the independent Codex review of PR #47, rounds 12-13, rated high.)
  //
  // NOTE for a future caller: this takes a connection, not a transaction handle. Nesting would
  // become a savepoint and the `immediate` behavior would not apply — if this ever needs to compose
  // inside a larger transaction, that outer transaction must itself be `IMMEDIATE`.
  return db.transaction((tx) => {
    const homeTeam = requireHomeTeam(tx);

    const onRoster =
      tx
        .select({ id: teamMemberships.id })
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.playerId, input.playerId),
            eq(teamMemberships.teamId, homeTeam.id),
            // Issue #49: a retired row is not a CURRENT roster row — recording availability for a
            // player the last successful pull did not see is the same error as printing them on
            // the roster.
            isNull(teamMemberships.retiredAt),
          ),
        )
        .all().length > 0;
    if (!onRoster) {
      throw new PlayerNotOnHomeRosterError(`player ${input.playerId} is not on the home team's roster`);
    }

    const candidateEvents = eventsForDay(tx, day);
    if (candidateEvents.length === 0) {
      throw new NoEventForDayError(`no event on file covers day "${day}"`);
    }

    const event = selectEvent(tx, day, candidateEvents, input.eventName);

    // #129: the SAME roster the dossier's availability grid will render for this event, resolved
    // inside this transaction alongside the `onRoster` check above — never a second, separate read
    // outside the lock, for the identical reason `eventsForDay`/`selectEvent` already run in here.
    const resolvedRoster = resolveRoster(tx, { teamId: homeTeam.id, eventId: event.id });
    const onEventRoster = resolvedRoster.members.some((member) => member.playerId === input.playerId);

    const row = tx
      .insert(availability)
      .values({ playerId: input.playerId, eventId: event.id, day, status })
      .onConflictDoUpdate({
        target: [availability.playerId, availability.eventId, availability.day],
        set: { status },
      })
      .returning()
      .get();

    return { availabilityId: row.id, eventId: event.id, eventName: event.name, status: row.status, onEventRoster };
  }, { behavior: "immediate" });
}

export type AvailabilityStatus = AvailabilityRow["status"];

/** One player's answer for every day of the event — `null` where no row exists. */
export type PlayerAvailability = {
  playerId: number;
  canonicalName: string;
  days: { day: string; status: AvailabilityStatus | null }[];
};

export type EventAvailability = {
  /** Every day in the event's range, inclusive — see `getAvailabilityForEvent`. */
  days: string[];
  /** One entry per CURRENT roster member, name-ordered. Empty only when the roster is. */
  players: PlayerAvailability[];
};

/**
 * Reads back what `setAvailability` wrote, as content rather than as a count (#126).
 *
 * Two shape decisions carry the feature's correctness, and both exist to make a plausible renderer
 * bug unrepresentable rather than merely untested:
 *
 * 1. **`days` comes from the EVENT's range, never from the rows returned.** A day nobody has
 *    answered for is exactly the day the captain most needs to see, and a list derived from stored
 *    rows would omit it — rendering "who is available Saturday?" as though there were no Saturday.
 *    The bug would be invisible, because the grid it produces looks complete.
 * 2. **Every player carries an entry for EVERY day**, with `status: null` for unrecorded. A renderer
 *    zipping a sparse list against a day header can misalign; one that reads a dense per-day list
 *    cannot. It also keeps "not recorded" and "recorded unavailable" structurally distinct, which is
 *    the distinction the captain acts on.
 *
 * **The roster is supplied by the caller, not re-derived here**, and that is the third correctness
 * decision. `buildTeamDossier` has already resolved which roster this dossier is ABOUT — the
 * registered field when an event was named, the season roster otherwise (#113, #125) — and the grid
 * has to be the same set of people the roster table three sections above it lists. Re-querying
 * `team_memberships` here produced exactly that disagreement: against the real database the grid
 * listed 13 while the roster table said "registered 11", and the two players it added were the very
 * ones the dossier's own "Not registered (watch for adds)" section names. One page cannot hold two
 * answers to "who is on this team", so there is only one place that question is answered.
 *
 * Note this is deliberately NARROWER than what `setAvailability` will accept: the writer takes any
 * non-retired membership regardless of `event_id`, because a `tn team pull` roster writes
 * `event_id: null` and requiring an event-scoped row would refuse every real roster. Recording
 * availability for a season-roster player who has not registered is therefore still allowed and
 * still stored — it simply does not appear in an event-scoped grid until they register, which is
 * when it starts to matter.
 *
 * Unlike the write service this takes no `teamId` and never calls `requireHomeTeam`: the caller has
 * already resolved the home team and decided this dossier is ours, and re-resolving it would be the
 * second read of one row that #97 and #125 both closed.
 */
export function getAvailabilityForEvent(
  db: Db,
  input: { eventId: number; roster: { playerId: number; canonicalName: string }[] },
): EventAvailability {
  const event = db.select().from(events).where(eq(events.id, input.eventId)).get();
  const days =
    event?.startsOn != null && event.endsOn != null ? enumerateIsoDays(event.startsOn, event.endsOn) : [];

  // One entry per player even if the caller's roster somehow repeats one — a player legitimately
  // holds both a season and an event membership row for the same team (docs/findings.md #15), the
  // same duplicate pair `tn player show` prints twice (#131), so a caller assembling this list from
  // membership rows could hand us two. The grid wants one row per person.
  const byId = new Map<number, { playerId: number; canonicalName: string }>();
  for (const member of input.roster) byId.set(member.playerId, member);

  const recorded = db
    .select({ playerId: availability.playerId, day: availability.day, status: availability.status })
    .from(availability)
    .where(eq(availability.eventId, input.eventId))
    .all();
  // Nested, rather than a composite `${playerId}<sep>${day}` string key. A composite key has to
  // invent a separator, and that is a decision with a wrong answer: an earlier revision of these
  // two lines carried a literal NUL byte as the separator. It was invisible in an editor and
  // behaviourally harmless only because the write and the read happened to carry the SAME byte,
  // so no test could see it - `test/source-no-nul-bytes.test.ts` caught it at the byte level.
  // A Map of Maps has no delimiter to get wrong.
  const statusFor = new Map<number, Map<string, AvailabilityStatus>>();
  for (const row of recorded) {
    let byDay = statusFor.get(row.playerId);
    if (byDay === undefined) {
      byDay = new Map<string, AvailabilityStatus>();
      statusFor.set(row.playerId, byDay);
    }
    byDay.set(row.day, row.status);
  }

  const rosterPlayers = Array.from(byId.values()).sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));

  return {
    days,
    players: rosterPlayers.map((member) => ({
      playerId: member.playerId,
      canonicalName: member.canonicalName,
      days: days.map((day) => ({ day, status: statusFor.get(member.playerId)?.get(day) ?? null })),
    })),
  };
}
