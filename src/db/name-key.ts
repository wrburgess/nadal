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
 * A name of nothing but invisible characters folds to `""` by the same rule, not to anything nullish.
 *
 * ## The fold has three steps, and each one is here for a defect on the record (#62)
 *
 * 1. **Strip `\p{Cf}`** (category Format: RIGHT-TO-LEFT OVERRIDE, the zero-width space/joiner/
 *    non-joiner, soft hyphen, BOM). Without it, `Versteeg` and `Versteeg<U+202E>` render identically
 *    to a human and produce two keys, so a scraped page carrying an invisible character forks one
 *    person into two rows. Derived from the Unicode general category rather than an enumerated
 *    character list, so a Cf character nobody here thought to name is still folded.
 *
 *    Worth knowing how it actually failed, because it was not a single failure: one or two format
 *    characters left an `editDistance` of 1-2, inside `FUZZY_MAX_DISTANCE`, so tier 3 caught them
 *    and returned `ambiguous` — wrong, but loud, and it halted a pull to ask about a player already
 *    on file. THREE pushed the distance past the band, so the ladder fell through every tier and
 *    created a second row silently. An upstream page picks that count for free.
 *
 * 2. **`.trim()` — and it MUST run after the strip, never before.** A leading format character holds
 *    the leading whitespace against the trim (`" <RLO> Name "` trims to `"<RLO> Name"`), and
 *    stripping afterwards leaves `" name"` — a third key for the same visible name, i.e. the same
 *    defect wearing the fix's clothes. The ordering is asserted in `test/name-key.test.ts`.
 *
 * 3. **`.normalize("NFKC")`, not NFC.** NFC is CANONICAL normalization: it composes combining marks
 *    but does not fold compatibility variants, so `Norbury` and `Ｎｏｒｂｕｒｙ` (full-width) were also
 *    two identities — the sibling defect logged at `docs/findings.md:319`, found while proving out
 *    scorecard ingestion, where a vision model transcribing a photo has no particular reason to
 *    prefer ASCII. NFKC still folds everything NFC did, so the composed/decomposed guarantee above
 *    is unchanged.
 *
 *    **NFKC does not subsume step 1** — `NFKC("Vers<U+202E>teeg") !== "Versteeg"`, verified in the
 *    test suite rather than assumed. Neither half is redundant.
 *
 * ## The accepted limit, stated where the next reader stands
 *
 * `\p{Cf}` includes ZERO WIDTH JOINER, ZERO WIDTH NON-JOINER and SOFT HYPHEN, which are
 * **semantically meaningful** in Indic, Persian and Arabic orthography — stripping them can fold two
 * genuinely different spellings together. For a Springfield USTA league roster that is the right
 * trade (the bidi-spoof and transcription risks are real and these are not), but it is a real limit
 * and not a hypothetical one. It would be the wrong fold for a general-purpose name index.
 *
 * Deliberately NOT folded, because each is a different class rather than an invisible-character one:
 * curly vs straight apostrophe (`O’Brien` / `O'Brien`), a real hyphen vs a soft hyphen once the
 * latter is stripped, and homoglyphs (Cyrillic `А` for Latin `A`) — the last would want a confusables
 * skeleton, which changes the false-merge risk profile substantially and has no instance on record.
 * `test/name-key.test.ts` asserts these stay distinct, because an over-merge is the silent failure
 * here and spec § Ingestion forbids it outright.
 *
 * ## Changing this function invalidates every stored key
 *
 * `backfillNameKeys` below only fills keys that are `NULL`, and the fail-closed probe in
 * `src/ingest/identity.ts` likewise only detects `NULL` — a key written under an OLDER fold is
 * non-null and wrong, so nothing detects it and tier 2 simply misses, creating the very duplicate
 * this function exists to prevent. There is no fold-version stamp. Any future edit here therefore
 * needs a migration that NULLs `name_key` on `players`, `player_aliases` and `teams` so the backfill
 * re-derives them — `drizzle/0010_moaning_sasquatch.sql` is the worked example.
 */
export function nameKey(s: string): string {
  return s.replace(/\p{Cf}/gu, "").trim().normalize("NFKC").toLowerCase();
}

/** Case-insensitive, Unicode-aware, whitespace-trimmed name comparison — by construction the same
 * notion of "equal" that the stored `name_key` column encodes. */
export function namesEqual(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

/**
 * The length of a key **in the same unit the stored `name_key_length` column counts** — SQLite's
 * `length()` on TEXT counts CODE POINTS, while JavaScript's `.length` counts UTF-16 CODE UNITS.
 * The two diverge by one per astral-plane character (verified: `length()` of `𠀀𠀁𠀂𠀃` is 4, its JS
 * `.length` is 8), so feeding a JS `.length` into the tier-3 band would compare a target measured
 * in one unit against candidates measured in another — and a name carrying enough astral
 * characters would shift the band clean past its own true candidates, dropping them. That failure
 * is silent and it is the worst one available here: a dropped fuzzy candidate is a duplicate player
 * created for someone already on file, which is precisely what tier 3 exists to prevent.
 *
 * Counting code points keeps the band's necessary condition valid even though `editDistance` below
 * still operates on UTF-16 units: a single unit-edit changes the code-point count by at most one,
 * so a code-point gap wider than `FUZZY_MAX_DISTANCE` still forces a distance wider than it.
 *
 * **`nameKey`'s NFKC step decides which names are still astral by the time this is called** (#62),
 * and the example above was changed for exactly that reason. It used to read `𝕁𝕠𝕙𝕟`
 * (MATHEMATICAL DOUBLE-STRUCK), which NFKC compatibility-decomposes to ASCII `john` — a BMP key,
 * whose units do not diverge at all. CJK Extension B is NFKC-stable and does diverge. Anything
 * choosing an astral fixture to exercise this divergence — `test/helpers/players.ts`'s shared corpus
 * among them — has to pick an NFKC-stable one, or it silently tests the BMP path while reading as
 * though it covers this one.
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
