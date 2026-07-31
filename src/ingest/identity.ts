import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { editDistance, FUZZY_MAX_DISTANCE, nameKey } from "../db/name-key.js";
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

/**
 * Thrown by the fail-closed unkeyed-row probe below (issue #32) when a table has a row with no
 * `name_key` — meaning a DB that hasn't been through `tn db migrate` since migration 0004, whose
 * own `runMigrations()` backfills every existing row (`src/db/name-key.ts`'s `backfillNameKeys`).
 * Missing this loudly, rather than having the unkeyed row silently fail to match, is the deliberate
 * counter to the fail-open shape that bit PR #31 round 3 and PR #38 round 2: a name that fails to
 * match an existing (but unkeyed) row would otherwise create a silent duplicate.
 */
export class NameKeyNotBackfilledError extends Error {
  constructor(tableLabel: string) {
    super(
      `${tableLabel} has a row with no name_key — run \`tn db migrate\` to backfill it before resolving names.`,
    );
    this.name = "NameKeyNotBackfilledError";
  }
}

// Verified index-backed (`SEARCH ... USING COVERING INDEX`): this is one constant-cost query per
// call, not a scan, so the fail-closed guarantee below costs nothing material to keep.
//
// Exported (not module-private) because src/query/player-profile.ts's `findPlayerByNameOrAlias`
// queries `players.name_key` / `player_aliases.name_key` directly rather than through one of this
// module's own functions, and needs the same fail-closed guard before doing so.
export function assertPlayersKeyed(db: Db): void {
  const probe = db.select({ one: sql<number>`1` }).from(players).where(isNull(players.nameKey)).limit(1).all();
  if (probe.length > 0) throw new NameKeyNotBackfilledError("players");
}

export function assertPlayerAliasesKeyed(db: Db): void {
  const probe = db
    .select({ one: sql<number>`1` })
    .from(playerAliases)
    .where(isNull(playerAliases.nameKey))
    .limit(1)
    .all();
  if (probe.length > 0) throw new NameKeyNotBackfilledError("player_aliases");
}

function assertTeamsKeyed(db: Db): void {
  const probe = db.select({ one: sql<number>`1` }).from(teams).where(isNull(teams.nameKey)).limit(1).all();
  if (probe.length > 0) throw new NameKeyNotBackfilledError("teams");
}

/**
 * Every row whose `name_key_length` is within `FUZZY_MAX_DISTANCE` of `targetLength` — a
 * NECESSARY condition for a Levenshtein distance within that same radius (each edit changes length
 * by at most 1), so narrowing on it can never drop a true fuzzy candidate. This is what makes
 * "recall provably unchanged" a checked claim (test/identity-fuzzy-recall.test.ts) rather than an
 * argument: the caller still runs the exact Levenshtein over this band, unabridged.
 */
function fuzzyPlayerBand(db: Db, targetLength: number): PlayerRow[] {
  return db
    .select()
    .from(players)
    .where(
      and(
        gte(players.nameKeyLength, targetLength - FUZZY_MAX_DISTANCE),
        lte(players.nameKeyLength, targetLength + FUZZY_MAX_DISTANCE),
      ),
    )
    .all();
}

function fuzzyTeamBand(db: Db, targetLength: number): TeamRow[] {
  return db
    .select()
    .from(teams)
    .where(
      and(
        gte(teams.nameKeyLength, targetLength - FUZZY_MAX_DISTANCE),
        lte(teams.nameKeyLength, targetLength + FUZZY_MAX_DISTANCE),
      ),
    )
    .all();
}

/**
 * Look up an already-known player by name only (exact, then fuzzy) — never creates. For the CLI's
 * "known player name" target case: a target that matches nothing is a mistyped/unknown target, not
 * an instruction to create a new player.
 */
export function findPlayerByName(db: Db, name: string): NameLookup<PlayerRow> {
  assertPlayersKeyed(db);
  const key = nameKey(name);

  const exact = db.select().from(players).where(eq(players.nameKey, key)).all();
  if (exact[0] !== undefined) return { kind: "found", row: exact[0] };

  const fuzzy = fuzzyPlayerBand(db, key.length).filter((row) => {
    const distance = editDistance(row.canonicalName, name);
    return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
  });
  if (fuzzy.length > 0) return { kind: "ambiguous", candidates: fuzzy };

  return { kind: "not-found" };
}

/** Same as `findPlayerByName`, for teams. */
export function findTeamByName(db: Db, name: string): NameLookup<TeamRow> {
  assertTeamsKeyed(db);
  const key = nameKey(name);

  const exact = db.select().from(teams).where(eq(teams.nameKey, key)).all();
  if (exact[0] !== undefined) return { kind: "found", row: exact[0] };

  const fuzzy = fuzzyTeamBand(db, key.length).filter((row) => {
    const distance = editDistance(row.name, name);
    return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
  });
  if (fuzzy.length > 0) return { kind: "ambiguous", candidates: fuzzy };

  return { kind: "not-found" };
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
 *
 * Tiers 2-3 are indexed lookups on `players.name_key` / `player_aliases.name_key` (issue #32):
 * equality for tier 2, a length-banded Levenshtein for tier 3 (`fuzzyPlayerBand` above) — rather
 * than loading every player into memory on every call.
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

  assertPlayersKeyed(db);
  assertPlayerAliasesKeyed(db);

  // Case-folded via `nameKey` (src/db/name-key.ts), NOT SQLite's `lower()`, which is ASCII-only —
  // this is what keeps the JS notion of "the same name" and the stored `name_key` column in
  // agreement by construction (the class-level close of the #31 "one ladder, two notions of a
  // name" defect: an alias `Élodie` failing to match a source spelling `élodie` created a SECOND
  // player row for someone already on file).
  const key = nameKey(input.name);

  const exactByAlias = db
    .select({ playerId: playerAliases.playerId })
    .from(playerAliases)
    .where(eq(playerAliases.nameKey, key))
    .all()
    .map((r) => r.playerId);
  const exactByCanonicalName = db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.nameKey, key))
    .all()
    .map((r) => r.id);
  const exactIds = Array.from(new Set([...exactByAlias, ...exactByCanonicalName]));

  if (exactIds.length === 1) {
    const row = db.select().from(players).where(eq(players.id, exactIds[0]!)).all()[0];
    if (row !== undefined) return { kind: "matched", row };
  }
  if (exactIds.length > 1) {
    return {
      kind: "ambiguous",
      candidates: db.select().from(players).where(inArray(players.id, exactIds)).all(),
    };
  }

  const fuzzyCandidates = fuzzyPlayerBand(db, key.length).filter((p) => {
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
      nameKey: key,
    })
    .returning()
    .get();
  // Recorded as its own first alias so a second pull of the same name resolves here via tier 2
  // rather than re-running (and risking a different verdict from) the fuzzy tier.
  db.insert(playerAliases).values({ playerId: created.id, alias: input.name, nameKey: key }).run();

  return { kind: "created", row: created };
}

/**
 * Resolve a team against the same three-tier shape as `resolvePlayer`, scoped to
 * `teams.tennisrecord_url` (tier 1) and `teams.name` (tiers 2-3; already unique, so tier 2 is a
 * single-row lookup rather than an alias join). Same "never a silent merge" contract on tier 3.
 * Tiers 2-3 are indexed on `teams.name_key` / `teams.name_key_length`, same as `resolvePlayer`.
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

  assertTeamsKeyed(db);
  const key = nameKey(input.name);

  const exact = db.select().from(teams).where(eq(teams.nameKey, key)).all();
  if (exact[0] !== undefined) return { kind: "matched", row: exact[0] };

  const fuzzyCandidates = fuzzyTeamBand(db, key.length).filter((t) => {
    const distance = editDistance(t.name, input.name);
    return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
  });
  if (fuzzyCandidates.length > 0) {
    return { kind: "ambiguous", candidates: fuzzyCandidates };
  }

  // `.returning()` for the same reason as `resolvePlayer` above.
  const created = db
    .insert(teams)
    .values({ name: input.name, tennisrecordUrl: input.tennisrecordUrl ?? null, nameKey: key })
    .returning()
    .get();
  return { kind: "created", row: created };
}
