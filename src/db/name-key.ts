import { eq, isNull } from "drizzle-orm";
import { playerAliases, players, teams } from "./schema.js";
import type { Db } from "../ingest/db-types.js";

/**
 * The single definition of "the same name" (issue #32). Every JS comparison AND every stored
 * `name_key` column derives from this one function, so the two notions agree by construction
 * rather than by remembering to keep them in sync — the class-level close of the #31 "one ladder,
 * two notions of a name" defect (SQLite's `lower()` is ASCII-only; `select lower('ÉLODIE')`
 * returns `Élodie`, not `élodie`, so the fold MUST stay in JS, never in SQL).
 *
 * `""` (from an empty or whitespace-only name) is a legitimate key, deliberately distinct from SQL
 * `NULL` — `NULL` means "not yet backfilled" (see `backfillNameKeys` in `src/db/client.ts` and the
 * fail-closed probe in `src/ingest/identity.ts`). No non-null input may ever produce that sentinel.
 */
export function nameKey(s: string): string {
  return s.trim().normalize("NFC").toLowerCase();
}

/** Case-insensitive, Unicode-aware, whitespace-trimmed name comparison — by construction the same
 * notion of "equal" that the stored `name_key` column encodes. */
export function namesEqual(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

/**
 * The length of a key **in the same unit the stored `name_key_length` column counts** — SQLite's
 * `length()` on TEXT counts CODE POINTS, while JavaScript's `.length` counts UTF-16 CODE UNITS.
 * The two diverge by one per astral-plane character (verified: `length()` of `𝕁𝕠𝕙𝕟` is 4, its JS
 * `.length` is 8), so feeding a JS `.length` into the tier-3 band would compare a target measured
 * in one unit against candidates measured in another — and a name carrying enough astral
 * characters would shift the band clean past its own true candidates, dropping them. That failure
 * is silent and it is the worst one available here: a dropped fuzzy candidate is a duplicate player
 * created for someone already on file, which is precisely what tier 3 exists to prevent.
 *
 * Counting code points keeps the band's necessary condition valid even though `editDistance` below
 * still operates on UTF-16 units: a single unit-edit changes the code-point count by at most one,
 * so a code-point gap wider than `FUZZY_MAX_DISTANCE` still forces a distance wider than it.
 */
export function nameKeyLength(key: string): number {
  return [...key].length;
}

// Near-identical, not "vaguely similar": a one- or two-character typo distance, small enough that
// two genuinely different names in the same roster essentially never collide by accident (the
// fixture rosters are all distinct first+last combinations well outside this radius).
export const FUZZY_MAX_DISTANCE = 2;

/** Classic Levenshtein edit distance, over the same `nameKey` fold used everywhere else. */
export function editDistance(a: string, b: string): number {
  const s = nameKey(a);
  const t = nameKey(b);
  const rows = s.length + 1;
  const cols = t.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i]![0] = i;
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
    }
  }
  return d[rows - 1]![cols - 1]!;
}

/**
 * Fills `name_key` on every row that doesn't have one yet, across all three keyed tables. Called
 * from `runMigrations()` (`src/db/client.ts`) immediately after `migrate()`, so an existing local
 * DB upgrading past migration 0004 gets keyed automatically rather than needing a separate manual
 * step. Idempotent by construction: it only ever selects `WHERE name_key IS NULL`, so a row that
 * already has a key (including one backfilled by a prior run) is never touched again.
 *
 * This IS a query per row rather than one bulk statement — unavoidably so, since the fold
 * (`nameKey`) must run in JS, not SQL (module doc above). That cost is paid once per row, only on
 * the rows that still need it, not on every `tn db migrate` invocation once a DB is caught up.
 */
export function backfillNameKeys(db: Db): void {
  const unkeyedPlayers = db
    .select({ id: players.id, canonicalName: players.canonicalName })
    .from(players)
    .where(isNull(players.nameKey))
    .all();
  for (const row of unkeyedPlayers) {
    db.update(players).set({ nameKey: nameKey(row.canonicalName) }).where(eq(players.id, row.id)).run();
  }

  const unkeyedAliases = db
    .select({ id: playerAliases.id, alias: playerAliases.alias })
    .from(playerAliases)
    .where(isNull(playerAliases.nameKey))
    .all();
  for (const row of unkeyedAliases) {
    db.update(playerAliases).set({ nameKey: nameKey(row.alias) }).where(eq(playerAliases.id, row.id)).run();
  }

  const unkeyedTeams = db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(isNull(teams.nameKey))
    .all();
  for (const row of unkeyedTeams) {
    db.update(teams).set({ nameKey: nameKey(row.name) }).where(eq(teams.id, row.id)).run();
  }
}
