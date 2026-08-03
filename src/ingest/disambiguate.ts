// Issue #94, second half: the two rulings a human can make about an ambiguous identity, and the
// only writes in the codebase that touch `players` / `player_aliases` outside a scrape.
//
// Before this module, an ambiguity reported by `resolvePlayer` was PERMANENT. Every write path
// (`team pull`, `player pull`, `match add`) routes through the identity ladder, and the ladder's
// tier-3 contract is "never a silent merge — report the candidates and create nothing" (spec §
// Ingestion). That is the right refusal, but it left the decision with nowhere to go: `NE/Penland`
// could not be pulled at all because an incoming `Andy Wang` sat one edit from an on-file
// `Andy Banh`, and three `OK/Dickason` roster members kept roster rows with no enrichment.
//
// There are exactly two rulings, and they are the two the ladder cannot make for itself:
//
//   DIFFERENT people (`declareDistinctPlayer`) — create the incoming name as its own player, so the
//     exact tier matches it and the fuzzy tier is never consulted for it again.
//   The SAME person (`recordPlayerAlias`) — record the incoming spelling against the known player,
//     so the exact tier resolves it there.
//
// Both work by making the EXACT tier answer first. Neither weakens the fuzzy tier, deletes a row,
// or merges two existing players — a merge is a different, destructive operation that would have to
// reassign court matches, memberships and ratings, and it is deliberately not here.

import { and, eq, inArray } from "drizzle-orm";
import { editDistance, FUZZY_MAX_DISTANCE, nameKey, nameKeyLength } from "../db/name-key.js";
import { playerAliases, players } from "../db/schema.js";
import type { Db } from "./db-types.js";
import type { AmbiguousIdentity } from "./errors.js";
import { assertPlayerAliasesKeyed, assertPlayersKeyed, fuzzyPlayerBand } from "./identity.js";
import { resolvePlayerTarget } from "../query/player-profile.js";

type PlayerRow = typeof players.$inferSelect;

/** Every player id whose canonical name OR one of whose aliases folds to `key` — `resolvePlayer`'s
 * own exact tier, extracted so both operations below reason about the same notion of "already on
 * file under this name" the ladder itself uses. Two ids here IS an exact-tier ambiguity. */
function exactIdsFor(db: Db, key: string): number[] {
  const byAlias = db
    .select({ playerId: playerAliases.playerId })
    .from(playerAliases)
    .where(eq(playerAliases.nameKey, key))
    .all()
    .map((r) => r.playerId);
  const byCanonicalName = db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.nameKey, key))
    .all()
    .map((r) => r.id);
  return Array.from(new Set([...byAlias, ...byCanonicalName]));
}

/** The fuzzy tier's candidates for `name` — `resolvePlayer`'s own `fuzzyPlayerBand` plus its own
 * exact Levenshtein filter, not a second implementation. "Is this name ambiguous?" has to be
 * answered here exactly as the ladder answers it: a nearness notion that drifted by one row would
 * let this module report a ruling applied while the very next pull went on refusing. */
function nearNeighbours(db: Db, name: string, key: string): PlayerRow[] {
  return fuzzyPlayerBand(db, nameKeyLength(key)).filter((row) => {
    const distance = editDistance(row.canonicalName, name);
    return distance > 0 && distance <= FUZZY_MAX_DISTANCE;
  });
}

export type DeclareDistinctInput = { name: string };

export type DeclareDistinctResult =
  /** Created. `distinctFrom` names the neighbours this ruling separates it from. */
  | { kind: "created"; player: PlayerRow; distinctFrom: string[] }
  /** Already on file under this name — the end state asked for, so a no-op rather than a refusal. */
  | { kind: "already-on-file"; player: PlayerRow }
  /** Two rows already share this name. A third cannot fix that; it needs a merge. */
  | { kind: "already-ambiguous"; candidates: string[] }
  /** Near nothing, so nothing was ever refused for it — almost certainly a mistyped name. */
  | { kind: "not-ambiguous" }
  | { kind: "empty-name" };

/**
 * "These are DIFFERENT people." Creates `name` as its own player, recorded as its own first alias
 * exactly the way `resolvePlayer`'s creation path does — after which the ladder's EXACT tier matches
 * it and the fuzzy tier is never reached for that name again. The neighbour it was near is
 * untouched and still resolves to itself.
 *
 * Refuses a name that is near NOTHING (`not-ambiguous`). That is the typo guard, and it is the one
 * judgement call in this module: the command exists to settle an ambiguity the tool reported, so a
 * name the ladder never blocked on is either mistyped — `tn player distinct "Karsen Davis"` when the
 * report said `Karson Davis` — or wants a pull, which is what legitimately creates players. Silently
 * accepting it would put a person on file that nobody meant to create, one letter off a real one,
 * and the next pull would then report BOTH as candidates.
 */
export function declareDistinctPlayer(db: Db, input: DeclareDistinctInput): DeclareDistinctResult {
  const name = input.name;
  if (name.trim() === "") return { kind: "empty-name" };

  assertPlayersKeyed(db);
  assertPlayerAliasesKeyed(db);

  const key = nameKey(name);
  const exactIds = exactIdsFor(db, key);
  if (exactIds.length > 1) {
    return {
      kind: "already-ambiguous",
      candidates: db.select().from(players).where(inArray(players.id, exactIds)).all().map((p) => p.canonicalName),
    };
  }
  if (exactIds.length === 1) {
    const player = db.select().from(players).where(eq(players.id, exactIds[0]!)).all()[0];
    if (player !== undefined) return { kind: "already-on-file", player };
  }

  const neighbours = nearNeighbours(db, name, key);
  if (neighbours.length === 0) return { kind: "not-ambiguous" };

  // One transaction: a player with no alias row would resolve through the fuzzy tier on the next
  // pull instead of the exact one, which is the state this whole operation exists to leave behind.
  const player = db.transaction((tx) => {
    const created = tx.insert(players).values({ canonicalName: name, nameKey: key }).returning().get();
    tx.insert(playerAliases).values({ playerId: created.id, alias: name, nameKey: key }).run();
    return created;
  });

  return { kind: "created", player, distinctFrom: neighbours.map((p) => p.canonicalName) };
}

export type RecordAliasInput = {
  /** A known player: a bare name, or a `usta:` / `wtn:` / `tr:` prefix-ID. */
  knownTarget: string;
  /** The OTHER spelling — the incoming name a pull could not resolve. */
  alias: string;
};

export type RecordAliasResult =
  | { kind: "recorded"; player: PlayerRow; alias: string }
  /** This spelling already resolves to this player — a no-op, so re-running a runbook step is fine. */
  | { kind: "already-recorded"; player: PlayerRow; alias: string }
  /** Another player already answers to this spelling. Recording it would make the name ambiguous
   * FOREVER: both ids would share one `name_key`, and nothing removes an alias. */
  | { kind: "held-by-another"; holder: PlayerRow }
  | { kind: "unknown-target" }
  | ({ kind: "ambiguous-target" } & AmbiguousIdentity)
  | { kind: "empty-alias" };

/**
 * "These are the SAME person, spelled two ways." Records `alias` against the known player, after
 * which the ladder's exact tier resolves that spelling there — no second `players` row, and the
 * known player's matches, memberships and ratings all stay on the one identity.
 *
 * Permissive where `declareDistinctPlayer` is strict: the alias does NOT have to be currently
 * ambiguous. A spelling more than `FUZZY_MAX_DISTANCE` away ("Bob" for "Robert") is never reported
 * as ambiguous at all — it silently creates a DUPLICATE player on the next pull — so requiring an
 * existing ambiguity would block the one case worth recording ahead of time. The asymmetry is
 * deliberate: `distinct` mints an identity, so a mistyped argument leaves a person on file; `alias`
 * only ever points an existing spelling at an existing row.
 *
 * The genuinely dangerous mistake — aliasing a spelling another player already answers to — is
 * refused outright rather than guarded by convention.
 */
export function recordPlayerAlias(db: Db, input: RecordAliasInput): RecordAliasResult {
  const alias = input.alias;
  if (alias.trim() === "") return { kind: "empty-alias" };

  const resolution = resolvePlayerTarget(db, input.knownTarget);
  if (resolution.kind === "not-found") return { kind: "unknown-target" };
  if (resolution.kind === "ambiguous") {
    return {
      kind: "ambiguous-target",
      incoming: input.knownTarget,
      candidates: resolution.candidates,
      context: "player name target",
    };
  }
  const knownId = resolution.playerId;

  assertPlayersKeyed(db);
  assertPlayerAliasesKeyed(db);

  const key = nameKey(alias);
  const holderId = exactIdsFor(db, key).find((id) => id !== knownId);
  if (holderId !== undefined) {
    const holder = db.select().from(players).where(eq(players.id, holderId)).all()[0]!;
    return { kind: "held-by-another", holder };
  }

  const player = db.select().from(players).where(eq(players.id, knownId)).all()[0]!;

  // Checked on `name_key`, not on the raw `alias` string the DB's own unique index uses: two
  // spellings differing only in case fold to ONE key, and a second row for them would add nothing
  // the ladder can see while making a re-run report `recorded` forever.
  const existing = db
    .select({ id: playerAliases.id })
    .from(playerAliases)
    .where(and(eq(playerAliases.playerId, knownId), eq(playerAliases.nameKey, key)))
    .all();
  if (existing.length > 0) return { kind: "already-recorded", player, alias };

  db.insert(playerAliases).values({ playerId: knownId, alias, nameKey: key }).run();
  return { kind: "recorded", player, alias };
}
