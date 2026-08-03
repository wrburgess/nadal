// Event write service (#17 PR B, Defect 2). Spec § Domain model: an Event is the "competition
// context (district season, Tulsa 2025, Springfield 2026)" that Availability hangs off — and until
// this module existed, nothing in production ever wrote one. `team pull` writes `eventId: null` at
// both of its call sites, so `setAvailability`, which resolves its event from the day, could never
// find one: `tn player avail` shipped in PR A as unreachable code. This is the minimum writer that
// makes it reachable.
//
// Deliberately narrow. `tn event show`, which the spec's *Planned* grammar list does name, stays
// unbuilt. `events.format` (court slots) DOES take a value here (#63) — the predicted-lineup slot
// set can now be supplied by a named event's format instead of always being derived from observed
// court-match history (see `derive.ts`'s `predictedLineup` and `query/lineup.ts`'s `getLineupPlan`);
// this is the one writer for it, sharing `event-format.ts`'s validator with the reader so the two can
// never disagree about what a legal format is.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { availability, events } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import { type EventCourt, parseEventFormat } from "./event-format.js";
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
  /** Raw text, `parseEventFormat`'s syntax (e.g. `"S1:singles,D1:doubles"`) — the SAME validator the
   * CLI and MCP surfaces both defer to, so the two can never accept a shape the other would refuse.
   * Omitted (never an empty string — a caller that means "no format" leaves this `undefined`)
   * preserves whatever is already stored; given, it REPLACES the stored value. There is no way to
   * CLEAR a stored format back to `null` in v1 — a stated limitation, not an oversight. */
  format?: string;
};

export type AddEventResult = {
  eventId: number;
  name: string;
  kind: "league" | "tournament";
  startsOn: string;
  endsOn: string;
  /** `null` when no format has ever been stored for this event. */
  format: EventCourt[] | null;
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
 * inverted; the format text does not parse (`InvalidEventFormatError`, from `event-format.ts`); or
 * an UPDATE would move the range off availability already recorded against this event. Every check —
 * including the format parse — runs BEFORE any write, so a refusal leaves the table untouched.
 *
 * Both endpoints go through the shared `isIsoDay` rule rather than a local copy. `starts_on` and
 * `ends_on` are compared as TEXT by `setAvailability`'s day lookup, so a malformed endpoint here
 * would produce a range that sorts unpredictably against days that ARE well-formed — the two
 * writers have to agree on what a day is, or a range written by one is unmatchable by the other.
 *
 * The range is inclusive at both ends, matching `eventsForDay`'s `starts_on <= day <= ends_on`, so
 * a single-day event (`startsOn === endsOn`) is legal and resolves for that one day.
 *
 * `input.format` follows the same "never clobber a stored value with an incoming null" semantics
 * `upsertTeamMatch` already runs for `scheduledTime`/`site` (`src/ingest/match-add.ts`): omitted
 * (`undefined`) PRESERVES whatever format is already stored, and given REPLACES it outright. Without
 * this, a routine `tn event add` call made only to correct a date would silently delete a format
 * recorded earlier. There is no way to CLEAR a stored format back to `null` in v1 — an accepted
 * limitation, not an oversight.
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

  // Parsed BEFORE the transaction, alongside every other input check — a malformed format must
  // refuse without ever opening a write, exactly like the kind/date checks above it.
  const incomingFormat: EventCourt[] | undefined =
    input.format === undefined ? undefined : parseEventFormat(input.format);

  // Everything below runs in ONE `BEGIN IMMEDIATE` transaction, because the range guard is a
  // read-then-write and the two halves must not be separable.
  //
  // `better-sqlite3` is synchronous, so nothing can interleave within one Node event loop — but
  // that is not the threat. nadal runs an MCP server (`tn mcp serve`) against the same WAL database
  // a CLI invocation uses, so an agent chat recording availability and a terminal correcting event
  // dates are genuinely concurrent PROCESSES. Without this, `setAvailability` can resolve the OLD
  // range and commit between the check below and the upsert, and the update then strands the row it
  // just wrote — reintroducing the exact invisible defect the guard exists to prevent, in the one
  // deployment shape this app actually has. `IMMEDIATE` (not the default deferred) takes the write
  // lock up front, so the guard's read is already serialized against any other writer rather than
  // upgrading mid-transaction and losing the race it was meant to win.
  // (Found by the independent Codex review of PR #47: rated medium as a check-then-act on `created`
  // in round 4, then high as a cross-process TOCTOU on the range guard in round 12.)
  return db.transaction((tx) => {
    // The pre-read decides only what to REPORT (`created`); the write itself is an upsert on the
    // `events.name` unique index, so the database — not this read — is what guarantees one row per
    // name even if this transaction were ever removed.
    const existing = tx.select().from(events).where(eq(events.name, name)).all()[0];

    // Narrowing or moving an existing range must not strand availability recorded against it.
    // `setAvailability` checks coverage only when a row is WRITTEN, so without this a routine date
    // correction would silently leave rows attached to an event that no longer contains their day —
    // invisible until someone reads per-event-day availability and finds days the event never
    // covered. Refusing (rather than deleting the rows, or silently keeping them) is the only option
    // that neither destroys data nor invents a policy: which of the two the operator meant is
    // genuinely ambiguous, so the diagnostic names the days and lets them decide.
    if (existing !== undefined) {
      const orphanedDays = tx
        .select({ day: availability.day })
        .from(availability)
        .where(eq(availability.eventId, existing.id))
        .all()
        .map((r) => r.day)
        .filter((day) => day < input.startsOn || day > input.endsOn)
        .sort();
      if (orphanedDays.length > 0) {
        // Thrown inside the transaction, so it rolls back rather than leaving a partial edit.
        throw new EventRangeExcludesAvailabilityError(
          `event "${name}" has availability recorded on ${orphanedDays.join(", ")}, which the new range ` +
            `${input.startsOn}..${input.endsOn} does not cover — widen the range, or remove that availability first`,
          orphanedDays,
        );
      }
    }

    // Omitted -> preserve whatever is already stored (`null` for a brand-new event); given ->
    // replace outright. Computed once so the SAME value is written and returned — `row.format` is
    // read back below only to confirm the write, never re-derived independently of it.
    const formatToWrite: EventCourt[] | null =
      incomingFormat !== undefined ? incomingFormat : ((existing?.format as EventCourt[] | null | undefined) ?? null);

    const row = tx
      .insert(events)
      .values({ name, kind, startsOn: input.startsOn, endsOn: input.endsOn, format: formatToWrite })
      .onConflictDoUpdate({
        target: events.name,
        set: { kind, startsOn: input.startsOn, endsOn: input.endsOn, format: formatToWrite },
      })
      .returning()
      .get();

    return {
      eventId: row.id,
      name: row.name,
      kind,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      format: formatToWrite,
      created: existing === undefined,
    };
  }, { behavior: "immediate" });
}
