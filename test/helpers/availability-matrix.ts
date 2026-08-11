// Shared fixture for every test that needs a RICH availability matrix — several players answering
// differently across several days of one event (#127). Before this, each caller hand-rolled its own
// nested loop over `setAvailability`, and the loops disagreed about the one thing that matters most:
// whether "no answer" is written as a row or left absent.
//
// It drives the REAL writer, once per (player, day), rather than inserting rows: `setAvailability`
// owns the day validation, the event resolution, and the idempotent upsert, and a fixture that
// bypassed it would let a test pass against rows the production path could never have produced.

import { setAvailability } from "../../src/query/availability.js";
import type { Db } from "../../src/ingest/db-types.js";

/** The three answers a captain can record. `null` is NOT one of them — see `statuses` below. */
export type MatrixStatus = "available" | "unavailable" | "uncertain";

export type SeedAvailabilityMatrixOptions = {
  /** One playerId per ROW of `statuses`. */
  players: number[];
  /** One ISO day per COLUMN of `statuses`. Every day must fall inside the event's range, since the
   * real writer resolves the event from the day. */
  days: string[];
  /**
   * `statuses[playerIndex][dayIndex]`.
   *
   * `null` means UNRECORDED and writes nothing at all — no `setAvailability` call, no row. That is
   * the whole reason this helper takes a matrix rather than a list of writes: "unrecorded" and
   * "recorded unavailable" are different states that a captain acts on differently, and a fixture
   * that could only express the second would make the distinction untestable.
   */
  statuses: (MatrixStatus | null)[][];
  /**
   * Passed straight through to `setAvailability` as its `eventName` disambiguator. Supply it
   * whenever the fixture has overlapping event ranges — without it the writer refuses an ambiguous
   * day, which is a fixture failure rather than the behavior under test.
   */
  eventName?: string;
};

/**
 * Records every non-null cell of `statuses` through `setAvailability`.
 *
 * Deliberately takes the event by NAME rather than by id: the real writer resolves the event from
 * the DAY (an id is not one of its inputs), so a helper accepting an `eventId` would either ignore
 * it — quietly writing against whichever event the day happened to resolve to — or bypass the
 * writer to honor it. Naming the event is the same disambiguation `tn player avail` exposes.
 *
 * Every refusal propagates: a fixture that writes an unrostered player, or a day outside the event,
 * must fail loudly at seed time rather than leave a test asserting over rows that were never
 * written.
 */
export function seedAvailabilityMatrix(db: Db, options: SeedAvailabilityMatrixOptions): void {
  if (options.statuses.length !== options.players.length) {
    throw new Error(
      `seedAvailabilityMatrix: ${options.statuses.length} status rows for ${options.players.length} players`,
    );
  }

  options.players.forEach((playerId, playerIndex) => {
    const row = options.statuses[playerIndex]!;
    if (row.length !== options.days.length) {
      throw new Error(
        `seedAvailabilityMatrix: player ${playerId} has ${row.length} statuses for ${options.days.length} days`,
      );
    }
    options.days.forEach((day, dayIndex) => {
      const status = row[dayIndex]!;
      if (status === null) return; // unrecorded: no row, on purpose
      setAvailability(db, { playerId, day, status, eventName: options.eventName });
    });
  });
}
