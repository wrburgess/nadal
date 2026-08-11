import { eq, isNotNull } from "drizzle-orm";
import { normalizeGender } from "../ingest/normalize-gender.js";
import { players } from "./schema.js";
import type { Db } from "../ingest/db-types.js";

/**
 * Normalizes every NON-NULL `players.gender` already on disk (issue #130). Follows the precedent
 * `backfillNameKeys` sets (`src/db/name-key.ts:268`) — called from `runMigrations()`
 * (`src/db/client.ts`) right after it, so an existing local DB carrying the 77 rows written by the
 * pre-fix code path gets cleaned up automatically the next time anything migrates it, rather than
 * needing a separate manual step.
 *
 * Deliberately NOT `WHERE gender IS NULL` the way `backfillNameKeys` scopes its own `WHERE` —
 * that shape fills a column NOTHING has written yet; this one CORRECTS a column something already
 * wrote wrong. Every non-null value is re-checked on every migration run, and only a row whose
 * normalized value actually differs from what is stored gets written — which is what makes running
 * this twice a no-op (idempotent by comparison, not merely by re-deriving the same answer): a row
 * already holding `"Male"` is read and skipped, never written, on every subsequent pass.
 *
 * FAILS CLOSED, same as `normalizeGender` itself: a value this function does not recognise
 * (`"Mixed"`, a future source's own unmapped label) is written as `NULL`, not left holding the raw
 * string — see `normalizeGender`'s doc comment for why storing the raw value forever, rather than
 * `NULL`, is the defect this whole class of fix exists to close. A `NULL` row is untouched: there
 * is nothing to normalize, and manufacturing a value for it is not this function's job.
 */
export function backfillGenders(db: Db): void {
  const rows = db
    .select({ id: players.id, gender: players.gender })
    .from(players)
    .where(isNotNull(players.gender))
    .all();

  for (const row of rows) {
    const normalized = normalizeGender(row.gender);
    if (normalized !== row.gender) {
      db.update(players).set({ gender: normalized }).where(eq(players.id, row.id)).run();
    }
  }
}
