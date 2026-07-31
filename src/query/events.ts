// Event write service (#17 PR B, Defect 2). Spec § Domain model: an Event is the "competition
// context (district season, Tulsa 2025, Springfield 2026)" that Availability hangs off — and until
// this module existed, nothing in production ever wrote one. `team pull` writes `eventId: null` at
// both of its call sites, so `setAvailability`, which resolves its event from the day, could never
// find one: `tn player avail` shipped in PR A as unreachable code. This is the minimum writer that
// makes it reachable.
//
// Deliberately narrow. `tn event show`, which the spec's *Planned* grammar list does name, stays
// unbuilt, and `events.format` (court slots) takes no value here — the predicted-lineup slot set
// derives from observed court-match history instead (see `derive.ts`'s `predictedLineup`), so a
// `--format` input would be a promise the code does not keep.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { availability, events } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import { isIsoDay } from "./iso-day.js";

export class MissingEventNameError extends Error {}
export class InvalidEventKindError extends Error {}
export class InvalidEventDayError extends Error {}
export class EventRangeInvertedError extends Error {}
export class EventRangeExcludesAvailabilityError extends Error {
  constructor(
    message: string,
    readonly orphanedDays: string[],
  ) {
    super(message);
  }
}

const eventKindSchema = z.enum(["league", "tournament"]);

export type AddEventInput = {
  name: string;
  kind: string;
  /** ISO date, inclusive. */
  startsOn: string;
  /** ISO date, inclusive. */
  endsOn: string;
};

export type AddEventResult = {
  eventId: number;
  name: string;
  kind: "league" | "tournament";
  startsOn: string;
  endsOn: string;
  /** False when this call updated an event that already existed under the same name. */
  created: boolean;
};

/**
 * Creates the named event, or updates it in place when one already exists under that name —
 * idempotent per spec § Ingestion discipline, keyed on `events.name` (already `unique` in the
 * schema), so re-running a setup script does not grow the table.
 *
 * Refuses, naming the reason via a distinct error class, when: the name is blank; the kind is not
 * `league` or `tournament`; either endpoint is not a real `YYYY-MM-DD` calendar date; the range is
 * inverted; or an UPDATE would move the range off availability already recorded against this event.
 * Every check runs BEFORE any write, so a refusal leaves the table untouched.
 *
 * Both endpoints go through the shared `isIsoDay` rule rather than a local copy. `starts_on` and
 * `ends_on` are compared as TEXT by `setAvailability`'s day lookup, so a malformed endpoint here
 * would produce a range that sorts unpredictably against days that ARE well-formed — the two
 * writers have to agree on what a day is, or a range written by one is unmatchable by the other.
 *
 * The range is inclusive at both ends, matching `eventsForDay`'s `starts_on <= day <= ends_on`, so
 * a single-day event (`startsOn === endsOn`) is legal and resolves for that one day.
 */
export function addEvent(db: Db, input: AddEventInput): AddEventResult {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new MissingEventNameError("event name is required");
  }

  const kindResult = eventKindSchema.safeParse(input.kind);
  if (!kindResult.success) {
    throw new InvalidEventKindError(`invalid event kind "${input.kind}" (expected league | tournament)`);
  }
  const kind = kindResult.data;

  for (const [label, value] of [
    ["starts-on", input.startsOn],
    ["ends-on", input.endsOn],
  ] as const) {
    if (!isIsoDay(value)) {
      throw new InvalidEventDayError(`invalid ${label} "${value}" (expected a real YYYY-MM-DD date)`);
    }
  }

  // Safe as a string comparison precisely because both endpoints are now known-good ISO days, which
  // sort lexically in date order. This is the same property `eventsForDay` relies on.
  if (input.endsOn < input.startsOn) {
    throw new EventRangeInvertedError(`ends-on "${input.endsOn}" is before starts-on "${input.startsOn}"`);
  }

  // The pre-read decides only what to REPORT (`created`); the write itself is an upsert on the
  // `events.name` unique index, so the database — not this read — is what guarantees one row per
  // name. A select-then-insert would be a check-then-act race: two concurrent adds of the same
  // event both read `undefined`, both insert, and the loser dies on a raw constraint violation
  // instead of the clean idempotent update this service promises (`rules/backend.md`: "a validation
  // is not a guarantee under concurrency"). Under that race `created` can be optimistically `true`
  // for the loser, which is cosmetic — the row is correct either way.
  const existing = db.select().from(events).where(eq(events.name, name)).all()[0];

  // Narrowing or moving an existing range must not strand availability that was recorded against
  // it. `setAvailability` checks coverage only when a row is WRITTEN, so without this a routine
  // date correction would silently leave rows attached to an event that no longer contains their
  // day — invisible until someone reads per-event-day availability and finds days the event never
  // covered. Refusing (rather than deleting the rows, or silently keeping them) is the only option
  // that does not destroy data or invent a policy: which of the two the operator meant is genuinely
  // ambiguous, so the diagnostic names the days and lets them decide.
  // (Found by the independent Codex review of PR #47, rated medium.)
  if (existing !== undefined) {
    const orphanedDays = db
      .select({ day: availability.day })
      .from(availability)
      .where(eq(availability.eventId, existing.id))
      .all()
      .map((r) => r.day)
      .filter((day) => day < input.startsOn || day > input.endsOn)
      .sort();
    if (orphanedDays.length > 0) {
      throw new EventRangeExcludesAvailabilityError(
        `event "${name}" has availability recorded on ${orphanedDays.join(", ")}, which the new range ` +
          `${input.startsOn}..${input.endsOn} does not cover — widen the range, or remove that availability first`,
        orphanedDays,
      );
    }
  }

  const row = db
    .insert(events)
    .values({ name, kind, startsOn: input.startsOn, endsOn: input.endsOn })
    .onConflictDoUpdate({
      target: events.name,
      set: { kind, startsOn: input.startsOn, endsOn: input.endsOn },
    })
    .returning()
    .get();

  return {
    eventId: row.id,
    name: row.name,
    kind,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    created: existing === undefined,
  };
}
