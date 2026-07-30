import { eq } from "drizzle-orm";
import { playerAliases, players, teams } from "../db/schema.js";
import type { Db } from "./db-types.js";

type PlayerRow = typeof players.$inferSelect;
type TeamRow = typeof teams.$inferSelect;

/**
 * The outcome of resolving a name (plus optional source ids) against the database. `ambiguous`
 * NEVER creates or modifies a row — spec § Ingestion puts a silent merge out of bounds entirely;
 * the caller is expected to list `candidates` and exit non-zero rather than guess.
 */
export type IdentityResolution<T> =
  | { kind: "matched"; row: T }
  | { kind: "created"; row: T }
  | { kind: "ambiguous"; candidates: T[] };

export type ResolvePlayerInput = {
  ustaUaid?: string | null;
  wtnTennisId?: string | null;
  tennisrecordUrl?: string | null;
  name: string;
};

export type ResolveTeamInput = {
  tennisrecordUrl?: string | null;
  name: string;
};

/**
 * The outcome of a NAME-ONLY lookup that never creates — used by the CLI's target resolution
 * (Task 7/8), which needs to tell "no such team/player on file" apart from "ambiguous" without
 * ever inserting a placeholder row just because someone mistyped a target.
 */
export type NameLookup<T> =
  | { kind: "found"; row: T }
  | { kind: "not-found" }
  | { kind: "ambiguous"; candidates: T[] };

// Near-identical, not "vaguely similar": a one- or two-character typo distance, small enough that
// two genuinely different names in the same roster essentially never collide by accident (the
// fixture rosters are all distinct first+last combinations well outside this radius).
const FUZZY_MAX_DISTANCE = 2;

/** Case-insensitive comparison only — spec § Ingestion: no other name normalization at ingest. */
function namesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Classic Levenshtein edit distance over case-folded, whitespace-trimmed strings. */
function editDistance(a: string, b: string): number {
  const s = a.trim().toLowerCase();
  const t = b.trim().toLowerCase();
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

/** Exact (case-insensitive) then fuzzy name matching, shared by the resolve* and find*By Name functions. */
function matchByName<T>(
  candidates: T[],
  nameOf: (row: T) => string,
  name: string,
): NameLookup<T> {
  const exact = candidates.find((row) => namesEqual(nameOf(row), name));
  if (exact !== undefined) return { kind: "found", row: exact };

  const fuzzy = candidates.filter((row) => {
    const distance = editDistance(nameOf(row), name);
    return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
  });
  if (fuzzy.length > 0) return { kind: "ambiguous", candidates: fuzzy };

  return { kind: "not-found" };
}

/**
 * Look up an already-known player by name only (exact, then fuzzy) — never creates. For the CLI's
 * "known player name" target case: a target that matches nothing is a mistyped/unknown target, not
 * an instruction to create a new player.
 */
export function findPlayerByName(db: Db, name: string): NameLookup<PlayerRow> {
  return matchByName(db.select().from(players).all(), (p) => p.canonicalName, name);
}

/** Same as `findPlayerByName`, for teams. */
export function findTeamByName(db: Db, name: string): NameLookup<TeamRow> {
  return matchByName(db.select().from(teams).all(), (t) => t.name, name);
}

/**
 * Resolve a player, per spec § Ingestion's identity ladder — followed EXACTLY, in order:
 *
 * 1. **Source ids**: `players.usta_uaid`, `players.wtn_tennis_id`, `players.tennisrecord_url`.
 * 2. **Exact name**: `player_aliases.alias` (case-insensitive), which also covers the common case
 *    of a player already created by this same function — every creation records the name it was
 *    created under as its own first alias, so a second pull of the same roster resolves to the
 *    same row rather than creating a duplicate.
 * 3. **Fuzzy**: a near-identical (but not exact) name against every other player's canonical name.
 *    This tier NEVER merges — it reports `ambiguous` with every candidate and creates nothing,
 *    leaving the merge decision to an HC.
 *
 * A name with no match at any tier creates exactly one new player, `canonicalName` set to the
 * name exactly as given (the page's own spelling — never title-cased or otherwise normalized).
 */
export function resolvePlayer(db: Db, input: ResolvePlayerInput): IdentityResolution<PlayerRow> {
  const idMatches: PlayerRow[] = [];
  if (input.ustaUaid !== undefined && input.ustaUaid !== null) {
    idMatches.push(...db.select().from(players).where(eq(players.ustaUaid, input.ustaUaid)).all());
  }
  if (idMatches.length === 0 && input.wtnTennisId !== undefined && input.wtnTennisId !== null) {
    idMatches.push(
      ...db.select().from(players).where(eq(players.wtnTennisId, input.wtnTennisId)).all(),
    );
  }
  if (
    idMatches.length === 0 &&
    input.tennisrecordUrl !== undefined &&
    input.tennisrecordUrl !== null
  ) {
    idMatches.push(
      ...db.select().from(players).where(eq(players.tennisrecordUrl, input.tennisrecordUrl)).all(),
    );
  }
  if (idMatches[0] !== undefined) return { kind: "matched", row: idMatches[0] };

  const allPlayers = db.select().from(players).all();

  // Case-folded in JS, NOT in SQL. SQLite's `lower()` is ASCII-only, while the canonical-name half
  // of this same tier uses JavaScript's Unicode-aware `toLowerCase()` — so an alias `Élodie` would
  // never match a source spelling `élodie`, the tier-2 lookup would miss, and a SECOND player row
  // would be created for someone already on file. One identity ladder cannot run two different
  // notions of "the same name". (Codex adversarial review, PR #31, rated medium.)
  const exactByAlias = db
    .select({ playerId: playerAliases.playerId, alias: playerAliases.alias })
    .from(playerAliases)
    .all()
    .filter((r) => namesEqual(r.alias, input.name))
    .map((r) => r.playerId);
  const exactByCanonicalName = allPlayers
    .filter((p) => namesEqual(p.canonicalName, input.name))
    .map((p) => p.id);
  const exactIds = Array.from(new Set([...exactByAlias, ...exactByCanonicalName]));

  if (exactIds.length === 1) {
    const row = allPlayers.find((p) => p.id === exactIds[0]);
    if (row !== undefined) return { kind: "matched", row };
  }
  if (exactIds.length > 1) {
    return { kind: "ambiguous", candidates: allPlayers.filter((p) => exactIds.includes(p.id)) };
  }

  const fuzzyCandidates = allPlayers.filter((p) => {
    const distance = editDistance(p.canonicalName, input.name);
    return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
  });
  if (fuzzyCandidates.length > 0) {
    return { kind: "ambiguous", candidates: fuzzyCandidates };
  }

  // `.returning()` rather than a read-back query: the old read-back matched on
  // `lower(canonical_name)`, which is SQLite's ASCII-only `lower()` and so shared the defect fixed
  // in tier 2 above, and it had to disambiguate the freshly-inserted row from prior ones by id.
  // The insert can just hand back the row it wrote.
  const created = db
    .insert(players)
    .values({
      canonicalName: input.name,
      ustaUaid: input.ustaUaid ?? null,
      wtnTennisId: input.wtnTennisId ?? null,
      tennisrecordUrl: input.tennisrecordUrl ?? null,
    })
    .returning()
    .get();
  // Recorded as its own first alias so a second pull of the same name resolves here via tier 2
  // rather than re-running (and risking a different verdict from) the fuzzy tier.
  db.insert(playerAliases).values({ playerId: created.id, alias: input.name }).run();

  return { kind: "created", row: created };
}

/**
 * Resolve a team against the same three-tier shape as `resolvePlayer`, scoped to
 * `teams.tennisrecord_url` (tier 1) and `teams.name` (tiers 2-3; already unique, so tier 2 is a
 * single-row lookup rather than an alias join). Same "never a silent merge" contract on tier 3.
 */
export function resolveTeam(db: Db, input: ResolveTeamInput): IdentityResolution<TeamRow> {
  if (input.tennisrecordUrl !== undefined && input.tennisrecordUrl !== null) {
    const idMatch = db
      .select()
      .from(teams)
      .where(eq(teams.tennisrecordUrl, input.tennisrecordUrl))
      .all();
    if (idMatch[0] !== undefined) return { kind: "matched", row: idMatch[0] };
  }

  const allTeams = db.select().from(teams).all();
  const exact = allTeams.find((t) => namesEqual(t.name, input.name));
  if (exact !== undefined) return { kind: "matched", row: exact };

  const fuzzyCandidates = allTeams.filter((t) => {
    const distance = editDistance(t.name, input.name);
    return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
  });
  if (fuzzyCandidates.length > 0) {
    return { kind: "ambiguous", candidates: fuzzyCandidates };
  }

  // `.returning()` for the same reason as `resolvePlayer` above.
  const created = db
    .insert(teams)
    .values({ name: input.name, tennisrecordUrl: input.tennisrecordUrl ?? null })
    .returning()
    .get();
  return { kind: "created", row: created };
}
