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
 * **Writes only a POSITIVE normalization, and never nulls a value it cannot map.** This is the one
 * place where "fail closed" would be the wrong instinct, and the distinction is between two
 * different jobs that an earlier cut of this function conflated (Codex adversarial review round 1,
 * PR #138, class B):
 *
 *  - `normalizeGender` guards the WRITE path, where failing closed to `NULL` is right: it stops a
 *    value nobody has taught us — a future source's label — from ENTERING the column, which is the
 *    defect #130 was.
 *  - This function corrects DATA ALREADY ON DISK, where failing closed is destructive. A row
 *    holding a legitimate-but-unmapped spelling (`"Non-binary"`, some future source's own
 *    vocabulary) is a source fact nobody has mapped yet, not garbage. Nulling it here would
 *    discard it permanently: the `WHERE gender IS NOT NULL` scope below means a row this function
 *    nulled is never selected again, so teaching `normalizeGender` that spelling later could NOT
 *    repair it. `normalizeGender`'s own doc comment used to claim exactly that recovery — the claim
 *    was false while this function nulled on failure, and it is true now that it does not.
 *
 * So an unrecognised value is LEFT EXACTLY AS IT IS, and stays visible to a later run. The 77 rows
 * #130 identified all normalize positively (`Competition Category: MALE` → `Male`), so the scope
 * this widened past — every non-null row rather than only the labelled ones — costs nothing and
 * catches any other writer that got there first. A `NULL` row is untouched: there is nothing to
 * normalize, and manufacturing a value for it is not this function's job.
 */
export function backfillGenders(db: Db): void {
  const rows = db
    .select({ id: players.id, gender: players.gender })
    .from(players)
    .where(isNotNull(players.gender))
    .all();

  for (const row of rows) {
    const normalized = normalizeGender(row.gender);
    if (normalized !== null && normalized !== row.gender) {
      db.update(players).set({ gender: normalized }).where(eq(players.id, row.id)).run();
    }
  }
}
