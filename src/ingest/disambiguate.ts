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

export type DeclareDistinctInput = {
  name: string;
  /**
   * The counterpart the pull's warning named, for the case where NEITHER side is on file (#142).
   *
   * A pull is one transaction and the fuzzy tier compares an incoming name against the names seen
   * so far *within* it, so two names first appearing in the same pull can be reported ambiguous
   * against each other and then both roll back. `nearNeighbours` reads committed rows, finds
   * nothing, and the typo guard below refuses — permanently, since every re-run rolls back again.
   *
   * Supplying the counterpart moves the guard from "does this name have a committed neighbour?" to
   * "are these two names actually near each other?", which is the question the typo guard was
   * always standing in for. Omit it and this function behaves exactly as it did before.
   */
  nearName?: string;
};

export type DeclareDistinctResult =
  /** Created. `distinctFrom` names the neighbours this ruling separates it from; `alsoCreated`
   * names the counterpart minted alongside it, which is empty for the single-name form. */
  | { kind: "created"; player: PlayerRow; distinctFrom: string[]; alsoCreated: string[] }
  /** Already on file under this name — the end state asked for, so a no-op rather than a refusal.
   * `alsoCreated` can still be non-empty: the counterpart may have been the only missing side. */
  | { kind: "already-on-file"; player: PlayerRow; alsoCreated: string[] }
  /** Two rows already share this name. A third cannot fix that; it needs a merge. `name` says
   * WHICH of the two arguments is the unusable one — in the pair form it can be the counterpart,
   * and a message that always named the target would send the caller after the wrong row. */
  | { kind: "already-ambiguous"; name: string; candidates: string[] }
  /** Near nothing, so nothing was ever refused for it — almost certainly a mistyped name. */
  | { kind: "not-ambiguous" }
  /** Pair form: the two names are further apart than the fuzzy radius, so no pull ever reported
   * them together — the typo guard, in the only form available when neither side is on file. */
  | { kind: "not-near" }
  /** Pair form: the two spellings fold to ONE comparison key, so they are not two people any
   * ladder could tell apart. Creating both would manufacture a permanent exact-tier ambiguity. */
  | { kind: "same-name" }
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

  const nearName = input.nearName;
  // A blank counterpart is refused rather than silently demoted to the single-name form: the caller
  // passed a second argument, so they meant to name someone, and the single-name form would then
  // refuse `not-ambiguous` for a completely unrelated reason.
  if (nearName !== undefined && nearName.trim() === "") return { kind: "empty-name" };

  assertPlayersKeyed(db);
  assertPlayerAliasesKeyed(db);

  const key = nameKey(name);

  // The pair form's guards, both BEFORE any read of the two names' rows — a refusal here is about
  // the arguments themselves, and nothing on disk can change the answer.
  let counterpartKey: string | undefined;
  if (nearName !== undefined) {
    counterpartKey = nameKey(nearName);
    // Checked on the KEY, not the raw strings: "Maria Negron" and "maria negron" are two edits
    // apart and so pass the nearness test below, while folding to one key. Creating both would put
    // two ids behind a single `name_key` — the `already-ambiguous` state this module refuses to
    // repair, manufactured by the command meant to prevent it.
    if (counterpartKey === key) return { kind: "same-name" };
    const distance = editDistance(name, nearName);
    if (distance === 0 || distance > FUZZY_MAX_DISTANCE) return { kind: "not-near" };
  }

  // EVERY read below decides whether to mint a player, so all of them run inside the same
  // `immediate` transaction as the writes (#144 review round 1, class A). Read-then-write across
  // separate statements is check-then-act against a WAL database: two concurrent
  // `tn player distinct` processes both observed an empty band, both minted, and the result was two
  // ids behind one `name_key` — the permanent exact-tier ambiguity this module has no merge
  // operation to repair, manufactured by the command whose whole purpose is preventing it.
  //
  // `immediate` takes the write lock at BEGIN rather than on first write, so the second process is
  // serialised behind the first and then reads what it committed, instead of proceeding on a
  // snapshot taken before it. Same idiom and same reason as `src/query/availability.ts` and
  // `src/query/events.ts`.
  //
  // The race PREDATES the pair form — `main`'s single-name path has the identical shape — so this
  // is not a regression being repaired but a widened window being closed: the pair form mints two
  // rows per call, so an interleaving corrupted two identities instead of one.
  //
  // Refusal paths return out of the transaction having written nothing; SQLite ends a read-only
  // `immediate` transaction with no work to commit.
  return db.transaction((tx): DeclareDistinctResult => {
    const exactIds = exactIdsFor(tx, key);
    if (exactIds.length > 1) {
      return {
        kind: "already-ambiguous",
        name,
        candidates: tx.select().from(players).where(inArray(players.id, exactIds)).all().map((p) => p.canonicalName),
      };
    }

    // The counterpart's own exact tier, checked before anything is written. A counterpart already
    // held by two rows cannot take this ruling either, and discovering that half-way through would
    // otherwise leave `name` minted against a ruling that was never applied.
    let counterpartIds: number[] = [];
    if (counterpartKey !== undefined) {
      counterpartIds = exactIdsFor(tx, counterpartKey);
      if (counterpartIds.length > 1) {
        return {
          kind: "already-ambiguous",
          name: nearName!,
          candidates: tx
            .select()
            .from(players)
            .where(inArray(players.id, counterpartIds))
            .all()
            .map((p) => p.canonicalName),
        };
      }
    }

    const existing =
      exactIds.length === 1
        ? tx.select().from(players).where(eq(players.id, exactIds[0]!)).all()[0]
        : undefined;
    const needsCounterpart = counterpartKey !== undefined && counterpartIds.length === 0;

    // Unchanged for the single-name form: a name already on file is the end state asked for. The
    // pair form only reaches past this when the counterpart is the missing side.
    if (existing !== undefined && !needsCounterpart) {
      return { kind: "already-on-file", player: existing, alsoCreated: [] };
    }

    const neighbours = nearNeighbours(tx, name, key);
    // The typo guard, and the one line #142 turns on: with a counterpart named, the ambiguity is
    // the argument itself, so an empty committed band is no longer evidence that nothing was
    // refused.
    if (neighbours.length === 0 && nearName === undefined) return { kind: "not-ambiguous" };

    // A player with no alias row would resolve through the fuzzy tier on the next pull instead of
    // the exact one, which is the state this whole operation exists to leave behind. Both sides
    // land together for the same reason — half a ruling leaves the pull still refusing.
    const mint = (mintName: string, mintKey: string): PlayerRow => {
      const row = tx.insert(players).values({ canonicalName: mintName, nameKey: mintKey }).returning().get();
      tx.insert(playerAliases).values({ playerId: row.id, alias: mintName, nameKey: mintKey }).run();
      return row;
    };
    const target = existing === undefined ? mint(name, key) : existing;
    const counterpart = needsCounterpart ? mint(nearName!, counterpartKey!) : undefined;
    const alsoCreated = counterpart === undefined ? [] : [counterpart.canonicalName];

    // Who this ruling separates `name` from: its committed neighbours, plus the counterpart named
    // on the command line. Deduped — a counterpart already on file is BOTH.
    const counterpartOnFile =
      counterpartIds.length === 1
        ? tx.select().from(players).where(eq(players.id, counterpartIds[0]!)).all()[0]?.canonicalName
        : undefined;
    const distinctFrom = Array.from(
      new Set([
        ...neighbours.map((p) => p.canonicalName),
        ...(counterpartOnFile !== undefined ? [counterpartOnFile] : []),
        ...(nearName !== undefined && counterpartOnFile === undefined ? [nearName] : []),
      ]),
    );

    if (existing !== undefined) return { kind: "already-on-file", player: existing, alsoCreated };
    return { kind: "created", player: target, distinctFrom, alsoCreated };
  }, { behavior: "immediate" });
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
