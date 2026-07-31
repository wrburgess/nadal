import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { editDistance, FUZZY_MAX_DISTANCE, nameKey, nameKeyLength } from "../db/name-key.js";
import { playerAliases, players, teamMemberships, teams } from "../db/schema.js";
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

  const fuzzy = fuzzyPlayerBand(db, nameKeyLength(key)).filter((row) => {
    const distance = editDistance(row.canonicalName, name);
    return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
  });
  if (fuzzy.length > 0) return { kind: "ambiguous", candidates: fuzzy };

  return { kind: "not-found" };
}

/**
 * Same as `findPlayerByName`, for teams — with one difference: unlike `players.name_key`,
 * `teams.name_key` is NOT DB-unique (only the exact `name` column is), so two rows can legitimately
 * share a nameKey (e.g. two differently-cased `team pull` scrapes of the same real team). A
 * same-nameKey collision is exactly as ambiguous as a fuzzy near-miss, so it gets the same
 * `"ambiguous"` outcome rather than the silent `exact[0]` pick this used to make (Codex round-4
 * sweep follow-up, HC-ruled in-scope for #18 since every caller already handles `"ambiguous"`
 * meaningfully — see `resolveTeamTarget`/`requireTeam`/`resolveTargetUrl`).
 */
export function findTeamByName(db: Db, name: string): NameLookup<TeamRow> {
  assertTeamsKeyed(db);
  const key = nameKey(name);

  const exact = db.select().from(teams).where(eq(teams.nameKey, key)).all();
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  if (exact[0] !== undefined) return { kind: "found", row: exact[0] };

  const fuzzy = fuzzyTeamBand(db, nameKeyLength(key)).filter((row) => {
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

  const fuzzyCandidates = fuzzyPlayerBand(db, nameKeyLength(key)).filter((p) => {
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

  const fuzzyCandidates = fuzzyTeamBand(db, nameKeyLength(key)).filter((t) => {
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

export type ResolveRosterPlayerInput = {
  /** A bare name, or a prefix-ID (`usta:` / `wtn:` / `tr:`) — the same three prefixes
   * `resolvePlayerTarget` (src/query/player-profile.ts) uses for a `player show`-style target. */
  name: string;
  teamId: number;
  /** Accepted for forward compatibility with an event-scoped roster; NOT required to match —
   * every real `team_memberships` row has a null `event_id` today (docs/findings.md:199), so
   * scoping this lookup on `eventId` as well would refuse every real roster. Currently unused by
   * the query below for exactly that reason. */
  eventId?: number | null;
};

/**
 * The outcome of a roster-scoped, NEVER-CREATE identity resolution (Task 2, #18). Unlike
 * `resolvePlayer`, a miss here is `unresolved`, never a new row: a name extracted from a scorecard
 * photo is agent vision, not a captain's own roster entry, and spec § Ingestion's "flag, never
 * guess" has no room for a misread name silently growing `players`. `ambiguous` and `unresolved`
 * both carry the candidates they saw (empty for a true `unresolved` miss), matching the shape of
 * every other resolution outcome in this module. `off-roster` (Codex adversarial review of PR #54,
 * High finding 1) is distinct from `unresolved`: the id/name resolved to a REAL player, just not one
 * on `teamId`'s roster — worth telling apart in a refusal message, and worth its own kind so a caller
 * cannot accidentally treat "found, wrong team" the same as "not found at all".
 */
export type RosterPlayerResolution =
  | { kind: "matched"; row: PlayerRow }
  | { kind: "ambiguous"; candidates: PlayerRow[] }
  | { kind: "unresolved"; candidates: PlayerRow[] }
  | { kind: "off-roster"; row: PlayerRow };

/** True when `playerId` has a CURRENT (non-retired) `team_memberships` row for `teamId` — the
 * roster-boundary check every tier of `resolveRosterPlayer` must pass, prefix-IDs included (Codex
 * adversarial review of PR #54, High finding 1: the three prefix branches used to skip this
 * entirely). `isNull(retiredAt)` matches issue #49's own idiom (`src/query/lineup.ts:84`): a
 * retired player must never resolve as on-roster here either, same as every sibling read/write
 * gate #49 named (`getTeamProfile`, `getLineupPlan`, `setAvailability`, `addCaptainNote`) — a
 * scorecard-extracted name is exactly the kind of write that invariant exists to protect. */
function isOnRoster(db: Db, playerId: number, teamId: number): boolean {
  return (
    db
      .select({ id: teamMemberships.id })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.playerId, playerId),
          eq(teamMemberships.teamId, teamId),
          isNull(teamMemberships.retiredAt),
        ),
      )
      .all().length > 0
  );
}

/**
 * Resolve one scorecard name against ONE team's roster. Ladder:
 *
 * 1. **Prefix-ID** (`usta:`/`wtn:`/`tr:`): a GLOBAL lookup by source id, same three prefixes
 *    `resolvePlayerTarget` uses, followed by the SAME roster-membership check every other tier
 *    goes through. An id names an exact identity, so a MISSPELLED name that IS on the roster can
 *    be corrected this way — that is the one thing a prefix-ID is for. It does NOT, and must not,
 *    let a payload name an arbitrary player from any other team (or no team at all) as a
 *    participant here: an id resolving to someone off this roster is `off-roster`, the same as a
 *    bare name would be, never `matched` (Codex adversarial review of PR #54, High finding 1 — the
 *    prior version treated an id as an unconditional override of roster scoping, which is a hole,
 *    not a feature, once a payload can name ANY known player's id).
 * 2. **Exact name**, restricted to `teamId`'s `team_memberships` — `players.name_key` OR
 *    `player_aliases.name_key`, the same fold `resolvePlayer` uses, but the candidate set is
 *    narrowed to the roster FIRST. This is the whole point of Task 2: a same-named player on a
 *    different team (or on no team at all) must NOT match here, even though `players` may have
 *    exactly one row with that name globally.
 * 3. **Fuzzy**, also restricted to the roster: a near-miss NEVER auto-matches — it reports
 *    `ambiguous` with every roster candidate within `FUZZY_MAX_DISTANCE`, same as `resolvePlayer`'s
 *    own tier 3, leaving the correction to a human via a prefix-ID.
 *
 * A name matching nothing at any tier — because it is not on `teamId`'s roster at all, not because
 * it was merely misspelled — is `unresolved`. This function never inserts a `players` row; that
 * stays `resolvePlayer`'s job for the scraping paths that want it.
 */
export function resolveRosterPlayer(db: Db, input: ResolveRosterPlayerInput): RosterPlayerResolution {
  // `usta:`/`wtn:` stay a plain `.all()[0]` DELIBERATELY, not by oversight: `players.usta_uaid` and
  // `players.wtn_tennis_id` are both declared `.unique()` in the schema, so `.all()` can never
  // return more than one row for either — there is no set to pick an unspecified member of.
  if (input.name.startsWith("usta:")) {
    const row = db.select().from(players).where(eq(players.ustaUaid, input.name.slice("usta:".length))).all()[0];
    if (row === undefined) return { kind: "unresolved", candidates: [] };
    return isOnRoster(db, row.id, input.teamId) ? { kind: "matched", row } : { kind: "off-roster", row };
  }
  if (input.name.startsWith("wtn:")) {
    const row = db.select().from(players).where(eq(players.wtnTennisId, input.name.slice("wtn:".length))).all()[0];
    if (row === undefined) return { kind: "unresolved", candidates: [] };
    return isOnRoster(db, row.id, input.teamId) ? { kind: "matched", row } : { kind: "off-roster", row };
  }
  if (input.name.startsWith("tr:")) {
    // UNLIKE `usta_uaid`/`wtn_tennis_id` above, `players.tennisrecord_url` carries NO uniqueness
    // constraint (Codex adversarial review of PR #54 round 4, High finding 3) — two DISTINCT
    // players can legitimately share one, so a bare `.all()[0]` silently picked an unspecified row,
    // a guess in the one path whose entire purpose is flag-never-guess. Collect every match, then
    // narrow to the ones actually viable (on THIS team's current roster) before deciding: more than
    // one viable identity is `ambiguous`, carrying every viable candidate — never silently resolved
    // to one of them.
    const rawMatches = db
      .select()
      .from(players)
      .where(eq(players.tennisrecordUrl, input.name.slice("tr:".length)))
      .all();
    if (rawMatches.length === 0) return { kind: "unresolved", candidates: [] };
    const viable = rawMatches.filter((row) => isOnRoster(db, row.id, input.teamId));
    if (viable.length > 1) return { kind: "ambiguous", candidates: viable };
    if (viable.length === 1) return { kind: "matched", row: viable[0]! };
    // None of the matches are on this team's current roster — off-roster. WHICH raw match is named
    // here is cosmetic, not a data-integrity risk the way silently picking a VIABLE one would be:
    // this is a refusal either way (no write ever follows an off-roster flag), so naming an
    // arbitrary one of several off-roster identities does not change what gets persisted.
    return { kind: "off-roster", row: rawMatches[0]! };
  }

  assertPlayersKeyed(db);
  assertPlayerAliasesKeyed(db);

  // Issue #49: excludes a retired member the same way `isOnRoster` above does, and the same way
  // every sibling current-roster read/write gate does (`src/query/lineup.ts:84`'s idiom) — a
  // retired player must not be a fuzzy-tier candidate here any more than an exact one.
  const rosterPlayerIds = db
    .select({ playerId: teamMemberships.playerId })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, input.teamId), isNull(teamMemberships.retiredAt)))
    .all()
    .map((r) => r.playerId);
  if (rosterPlayerIds.length === 0) return { kind: "unresolved", candidates: [] };

  const key = nameKey(input.name);

  const exactByAlias = db
    .select({ playerId: playerAliases.playerId })
    .from(playerAliases)
    .where(and(eq(playerAliases.nameKey, key), inArray(playerAliases.playerId, rosterPlayerIds)))
    .all()
    .map((r) => r.playerId);
  const exactByCanonicalName = db
    .select({ id: players.id })
    .from(players)
    .where(and(eq(players.nameKey, key), inArray(players.id, rosterPlayerIds)))
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

  // Fuzzy tier: filtered directly over the roster's own rows rather than the length-banded index
  // query `fuzzyPlayerBand` uses — a roster is small (a handful of players), so there is no scan
  // cost this needs to avoid, unlike `resolvePlayer`'s whole-table tier 3.
  const rosterRows = db.select().from(players).where(inArray(players.id, rosterPlayerIds)).all();
  const fuzzyCandidates = rosterRows.filter((p) => {
    const distance = editDistance(p.canonicalName, input.name);
    return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
  });
  if (fuzzyCandidates.length > 0) {
    return { kind: "ambiguous", candidates: fuzzyCandidates };
  }

  return { kind: "unresolved", candidates: [] };
}
