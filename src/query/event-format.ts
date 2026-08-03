// The shape of an event's court format (#63) — spec § Domain model names `events.format` as one of
// the two things that legitimately vary per event (the other is the roster). This module owns BOTH
// directions of it: a human-typed CLI/MCP string in (`parseEventFormat`) and the stored column value
// back out (`readEventFormat`), through one shared validator each direction defers to, so the writer
// and the reader can never disagree about what a legal format is.
//
// `Discipline` in `src/query/types.ts` is deliberately an OPEN string — it mirrors whatever a scraped
// SOURCE says, and `derive.ts`'s correctness rules require an unenumerated value to be carried through
// rather than dropped. A human-typed format is a different input class: `derive.ts` places any
// non-"singles" slot as a two-player court, so an unvalidated typo ("single") would silently become a
// doubles court — the silent-lie class this repo has logged before. `discipline` here is therefore a
// CLOSED zod enum, and a value outside it is refused, naming both legal values, rather than carried
// through or guessed at. Discipline is likewise never INFERRED from a slot's own spelling: `derive.ts`
// (`disciplineRank`'s doc comment) deliberately ranks by the OBSERVED discipline rather than the
// slot's name "so the order survives a source that names its courts something other than S1/D1";
// inferring "S" -> singles here would reintroduce exactly that assumption for a human-typed format.

import { z } from "zod";

export type EventCourt = { slot: string; discipline: "singles" | "doubles" };

/** Every reason a format (human-typed or stored) is rejected — one class, so both directions collapse
 * to the same caller-fixable refusal rather than each inventing its own. */
export class InvalidEventFormatError extends Error {}

const disciplineSchema = z.enum(["singles", "doubles"]);

const eventCourtSchema = z.object({
  slot: z.string().min(1),
  discipline: disciplineSchema,
});

/** Refuses a list of courts that share a slot — a duplicate would silently collapse two courts into
 * one wherever this list is consumed, most sharply in `derive.ts`'s slot ordering/lookup. Shared by
 * both directions rather than checked once each. */
function requireDistinctSlots(courts: EventCourt[]): void {
  const seen = new Set<string>();
  for (const court of courts) {
    if (seen.has(court.slot)) {
      throw new InvalidEventFormatError(`duplicate slot "${court.slot}" in event format`);
    }
    seen.add(court.slot);
  }
}

/**
 * CLI/MCP text -> a validated, ORDER-PRESERVING court list. Syntax:
 * `S1:singles,D1:doubles,D2:doubles,D3:doubles` — split on `,`, then each entry on its FIRST `:`
 * (so a stray extra colon lands in the discipline half and refuses there, rather than being silently
 * absorbed into the slot). Both halves are trimmed, so whitespace around either the comma or the
 * colon is accepted.
 *
 * Refuses (never guesses, never drops an entry): an empty or all-whitespace input; an entry with no
 * colon at all; a blank slot or a blank discipline; a discipline outside `singles | doubles`; and a
 * repeated slot. Every refusal names what was wrong, either the offending entry or the input class
 * that failed, so the message tells an operator what to fix rather than only that something failed.
 */
export function parseEventFormat(input: string): EventCourt[] {
  if (input.trim().length === 0) {
    throw new InvalidEventFormatError(
      `event format is empty — expected a comma-separated list like "S1:singles,D1:doubles"`,
    );
  }

  const courts: EventCourt[] = [];
  for (const rawEntry of input.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      throw new InvalidEventFormatError(`event format "${input}" contains a blank entry`);
    }

    const colonIndex = entry.indexOf(":");
    if (colonIndex === -1) {
      throw new InvalidEventFormatError(`event format entry "${entry}" is missing "slot:discipline"`);
    }

    const slot = entry.slice(0, colonIndex).trim();
    const disciplineText = entry.slice(colonIndex + 1).trim();

    if (slot.length === 0) {
      throw new InvalidEventFormatError(`event format entry "${entry}" has a blank slot`);
    }

    const disciplineResult = disciplineSchema.safeParse(disciplineText);
    if (!disciplineResult.success) {
      throw new InvalidEventFormatError(
        `event format entry "${entry}" has an unknown discipline "${disciplineText}" (expected singles | doubles)`,
      );
    }

    courts.push({ slot, discipline: disciplineResult.data });
  }

  requireDistinctSlots(courts);
  return courts;
}

/**
 * A validated court list -> the exact string written to `events.format`. Paired with
 * `readEventFormat` below so ONE module owns the on-disk encoding as well as the shape: the column
 * is plain `text` rather than drizzle `{ mode: "json" }` precisely so that nothing else in the
 * codebase ever decodes it (see `src/db/schema.ts`'s comment on the column).
 */
export function encodeEventFormat(courts: EventCourt[]): string {
  return JSON.stringify(courts);
}

/**
 * The stored `events.format` column value -> a validated court list, or `null` when the column is
 * null (no format recorded yet). **Fails closed**: anything that our own writer (`parseEventFormat`
 * + `encodeEventFormat`, via `addEvent`) would not have produced throws a named
 * `InvalidEventFormatError`, rather than being coerced, silently dropped, or surfacing as some other
 * library's exception.
 *
 * **Decoding happens here, and only here.** The column is plain `text`, so this function owns the
 * `JSON.parse` and converts its `SyntaxError` into the same refusal class as every other malformed
 * value. Under drizzle's `{ mode: "json" }` that parse would instead run inside drizzle's row mapper
 * for every reader of the table — so a hand-corrupted value would throw a raw `SyntaxError` out of
 * `eventsForDay`, `match add` and `addEvent` before any guard ran. That is the whole reason the mode
 * is not used; keeping the two in sync is this function's job.
 *
 * Defense in depth: only `addEvent` writes this column in production, but SQLite enforces no shape
 * on a `text` column, so a hand-edited database is exactly the case this exists for.
 */
export function readEventFormat(raw: unknown): EventCourt[] | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw !== "string") {
    throw new InvalidEventFormatError(`stored event format is not text: ${JSON.stringify(raw)}`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // The message deliberately does NOT echo the stored bytes: an unparseable column value is
    // arbitrary content, and the operator needs the event and the fix, not the garbage.
    throw new InvalidEventFormatError(
      "stored event format is not valid JSON — re-record it with tn event add <name> <kind> <starts-on> <ends-on> <format>",
    );
  }

  if (!Array.isArray(decoded)) {
    throw new InvalidEventFormatError(`stored event format is not an array: ${JSON.stringify(decoded)}`);
  }
  if (decoded.length === 0) {
    throw new InvalidEventFormatError("stored event format is an empty array");
  }

  const courts: EventCourt[] = [];
  for (const entry of decoded) {
    const result = eventCourtSchema.safeParse(entry);
    if (!result.success) {
      throw new InvalidEventFormatError(`stored event format entry is malformed: ${JSON.stringify(entry)}`);
    }
    courts.push(result.data);
  }

  requireDistinctSlots(courts);
  return courts;
}
