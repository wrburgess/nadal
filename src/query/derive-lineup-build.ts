// The pure rules layer for `tn lineup build` (#127): who is eligible on one day, and the three
// disclosed ways to field them. No `db`, no clock — plain arrays in, a typed result out, exactly the
// split `derive.ts` / `lineup.ts` already enforce, so every rule below can be tested exhaustively
// against hand-built inputs a real fixture cannot exhibit. `lineup-build.ts` is the assembly layer
// that fetches the rows and hands them here.
//
// **`predictedLineup` is deliberately neither touched nor reused.** Its contention loop is an
// undisclosed optimizer — a pair-first cascade whose output reads as one answer with no way to see
// what it traded away — and an undisclosed optimizer is precisely what this feature exists to avoid.
// A captain choosing a lineup needs to see the choice, so this module names three strategies, states
// each one's rule, and prints all three. The small pure primitives ARE shared
// (`selectRosterRatingSource`, `partnerFrequency`, `INVERTED_RATING_SOURCES`), because those are
// facts about the data rather than opinions about how to field it.
//
// Everything here is deterministic: every ordering ends in an explicit `playerId` (or slot-name)
// tie-break, so no result depends on an input array's order — asserted by running the whole thing
// against a reversed input and comparing bytes.

import { INVERTED_RATING_SOURCES, partnerFrequency, selectRosterRatingSource } from "./derive.js";
import type { EventCourt } from "./event-format.js";
import type { CourtMatchRow, RatingObservationRow, RatingSource } from "./types.js";

/** The three availability answers, plus `null` for "nobody has recorded one". `null` is a REPORTED
 * state, never a synonym for `unavailable`: the captain acts on the difference, and collapsing them
 * is the defect this shape exists to make unrepresentable. */
export type EligibilityStatus = "available" | "unavailable" | "uncertain" | null;

export type RosterDayEntry = {
  playerId: number;
  canonicalName: string;
  /** This player's answer for the ONE day being built. */
  status: EligibilityStatus;
};

export type BuildDayScenariosInput = {
  /** Every roster member this day is being built over — the whole roster, not only the available,
   * so the ledger can name each absence in its own bucket. */
  players: RosterDayEntry[];
  /** The event's court list, in the event's own format order. */
  slotSet: readonly EventCourt[];
  /** Rating observations per player, in the shape `selectRosterRatingSource` consumes. */
  ratings: { playerId: number; observations: RatingObservationRow[] }[];
  /** This team's OWN court matches for these players (already scoped by
   * `ownTeamCourtMatchRows`) — the evidence behind every shared-match count below. */
  rows: CourtMatchRow[];
};

export type LedgerPlayer = { playerId: number; canonicalName: string };

/** Every roster member, in exactly one bucket, name-ordered. Four buckets rather than
 * "available/not": see `EligibilityStatus`. */
export type EligibilityLedger = {
  available: LedgerPlayer[];
  unavailable: LedgerPlayer[];
  uncertain: LedgerPlayer[];
  unrecorded: LedgerPlayer[];
};

export type ScenarioStrategy = "strength-first" | "history-first" | "balanced";

/** Each strategy's rule, in one sentence, so a presenter states the rule the code actually ran
 * rather than paraphrasing it into something the code does not do. */
export const STRATEGY_RULES: Record<ScenarioStrategy, string> = {
  "strength-first":
    "singles takes the strongest available player, then each doubles court in format order takes the two strongest left — stacks the top courts",
  "history-first":
    "singles goes to the most-played singles player, then doubles courts take the pairs with the most matches together for this team — keeps established partnerships intact",
  balanced:
    "singles as strength-first, then the remaining players are re-partitioned across the doubles courts to make the courts as even as possible — spreads strength rather than stacking it",
};

export type ScenarioPlayer = {
  playerId: number;
  canonicalName: string;
  /** The latest value in `DayScenarios.ratingSource`'s OWN scale — the number to print. `null` when
   * this player has no observation in it. */
  rating: number | null;
  /** The same value normalized for direction (negated for the inverted WTN sources), so higher is
   * always stronger — the number every ordering here used. `null` when unrated. */
  strength: number | null;
};

export type ScenarioCourt = {
  slot: string;
  discipline: "singles" | "doubles";
  /** Strongest first, ties by `playerId`. EMPTY when the court could not be filled — a doubles court
   * is filled with two bodies or with none, never with one (see `Scenario.unfilledSlots`). */
  players: ScenarioPlayer[];
  /** Bodies this court needs: 1 for singles, 2 for doubles. */
  seats: number;
  filled: boolean;
  /** Matches these two have played together, on the same side, for THIS team. `0` is a real
   * answer — "no shared history" — and is why a presenter must print it rather than omit it.
   * `null` where the question does not arise: a singles court, or an unfilled one. */
  sharedMatches: number | null;
  /** Sum of the placed players' RAW ratings, in `ratingSource`'s own scale, over the rated ones
   * only. `null` when nobody placed here is rated. Direction is NOT normalized: this is the number
   * to print beside the scale's name. */
  courtRating: number | null;
  /** The same sum over normalized strengths — the number the orderings and the balance objective
   * used. `null` when nobody placed here is rated. */
  courtStrength: number | null;
  /** How many of `players` contributed to the two sums above, so a partly-rated court is legible as
   * partly rated rather than as weak. */
  ratedPlayers: number;
};

export type Scenario = {
  /** Every strategy that produced exactly these court assignments. More than one name means the
   * strategies AGREED — the tables are printed once under both names rather than posing as separate
   * options. */
  strategies: ScenarioStrategy[];
  /** One entry per slot in the event's format order, including the unfilled ones — a slot with
   * nobody left is reported short, never omitted. */
  courts: ScenarioCourt[];
  /** Eligible players this scenario did not place, name-ordered. */
  sitting: LedgerPlayer[];
  unfilledSlots: string[];
  /** Seats no eligible body could fill — NOT the same as `DayScenarios.shortfall`, which counts
   * bodies: one body short of a doubles court leaves TWO seats empty and sits that body. */
  unfilledSeats: number;
};

export type DayScenarios = {
  ledger: EligibilityLedger;
  eligibleCount: number;
  /** Bodies the whole slot set needs: 1 per singles court, 2 per doubles court. */
  bodiesNeeded: number;
  /** Eligible bodies short of `bodiesNeeded`; `0` when there are enough. */
  shortfall: number;
  /** The ONE scale every comparison was made within, or `null` when nobody is rated. Chosen over the
   * whole roster rather than over the day's available subset, so the scale a captain reads does not
   * change from Friday to Saturday because one rated player answered differently. */
  ratingSource: RatingSource | null;
  /** Eligible players carrying a value in `ratingSource` — how many players the orderings and the
   * balance objective actually saw. */
  ratedEligible: number;
  /** One entry per DISTINCT set of court assignments, in strategy order. */
  scenarios: Scenario[];
};

/** An event format with no courts at all: refused rather than answered with an empty table, which
 * would read as "we field nobody". Unreachable through `tn event add` — `readEventFormat` refuses an
 * empty stored format — and guarded anyway, since this function is pure and callable directly with
 * any input, the same defense `predictedLineup` applies one module over. */
export class EmptySlotSetError extends Error {}

/** Ties on a float sum are compared within this tolerance. Ratings are decimals (4.1, 3.67), so
 * `4.4 + 3.0 === 7.4` is not something IEEE-754 guarantees, and an exact comparison would make the
 * balance tie-break depend on representation error rather than on the stated rule. */
const EPSILON = 1e-9;

function byNameThenId(a: LedgerPlayer, b: LedgerPlayer): number {
  return a.canonicalName.toLowerCase().localeCompare(b.canonicalName.toLowerCase()) || a.playerId - b.playerId;
}

/** Ascending-id tuple comparison, the last tie-break for a GROUP of players (a pair, or a whole
 * partition). Total, so nothing downstream can depend on input order. */
function compareIdTuples(a: number[], b: number[]): number {
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

/**
 * Every perfect matching of `ids` (which must have even length), yielded one at a time.
 *
 * The count is the double factorial `(2n-1)!!` for `n` pairs: 15 matchings for 3 courts, 105 for 4,
 * 945 for 5, 10,395 for 6, 135,135 for 7, 2,027,025 for 8. Exhaustive search is what makes "minimal
 * spread" a fact rather than a hope, and at the court counts real tennis formats use it is cheap —
 * nadal's own Springfield format is three doubles courts, which is 15.
 *
 * **A generator rather than an array, and the reason is measured rather than assumed.** An earlier
 * revision built the whole list before returning it, so memory grew with the *matching count* rather
 * than with the roster: measured on this machine, 8 doubles courts and 16 available players
 * allocated **1.7 GB** and took 4.2 s, and 9 courts — 17x more matchings — would exhaust the heap
 * and take the process down. Nothing enforces a court count: `events.format` is authored text and
 * `parseEventFormat` only requires the slots be distinct, so "the roster is a dozen people and four
 * courts" was a claim about input that the code did not hold anyone to. Yielding makes the memory
 * O(n) in the roster and independent of the matching count, so an implausible format degrades into
 * *slow* instead of into an out-of-memory crash. The search order is unchanged, which is what keeps
 * the determinism tests meaningful across this change.
 */
function* enumeratePairings(ids: number[]): Generator<[number, number][]> {
  if (ids.length === 0) {
    yield [];
    return;
  }
  const [first, ...rest] = ids;
  for (let i = 0; i < rest.length; i++) {
    const remaining = rest.filter((_, j) => j !== i);
    for (const tail of enumeratePairings(remaining)) yield [[first!, rest[i]!], ...tail];
  }
}

/**
 * The day's eligible field, the three strategies over it, and the ledger that says who is missing
 * and why.
 *
 * **Eligible means `status === "available"`, and only that.** `uncertain` and unrecorded are named in
 * the ledger and never fielded: silently promoting either would field somebody who has not said yes,
 * which is the one thing a captain cannot check by looking at the result.
 *
 * **No player is ever on two courts.** Every strategy draws without replacement, and the property is
 * pinned by a test built over a fixture where the greedy step WOULD reuse a player if the constraint
 * were removed. A doubles court short of bodies is left EMPTY and the odd body sits — never
 * half-filled, and never filled by double-booking somebody from another court.
 *
 * **No refusal for a roster with no history.** Availability is the input; shared history is a soft
 * signal. Every pair simply reads `sharedMatches: 0`, and `getLineupPlan`'s `NoCourtMatchHistoryError`
 * is deliberately NOT inherited — refusing here would fail on exactly the newly-assembled roster this
 * feature exists to serve.
 *
 * **Identical scenarios collapse.** Two strategies that produce the same assignments are returned
 * ONCE, carrying both names. Three identical tables must never read as three options — and the
 * degenerate case is real: with nothing rated and nothing played, all three fall through to the same
 * stable ordering.
 */
export function buildDayScenarios(input: BuildDayScenariosInput): DayScenarios {
  if (input.slotSet.length === 0) {
    throw new EmptySlotSetError("buildDayScenarios: the event's format has no courts to field");
  }

  // One entry per person even if the caller listed one twice — a player legitimately holds both a
  // season and an event membership row for the same team (docs/findings.md #15), the same duplicate
  // `getAvailabilityForEvent` and `getCaptainNotes` each collapse. Here it matters more than
  // presentation: a duplicated id is a body that could be placed on two courts at once.
  const byId = new Map<number, RosterDayEntry>();
  for (const entry of input.players) if (!byId.has(entry.playerId)) byId.set(entry.playerId, entry);
  const roster = Array.from(byId.values());

  const ledger: EligibilityLedger = { available: [], unavailable: [], uncertain: [], unrecorded: [] };
  for (const entry of roster) {
    const named = { playerId: entry.playerId, canonicalName: entry.canonicalName };
    if (entry.status === "available") ledger.available.push(named);
    else if (entry.status === "unavailable") ledger.unavailable.push(named);
    else if (entry.status === "uncertain") ledger.uncertain.push(named);
    else ledger.unrecorded.push(named);
  }
  for (const bucket of [ledger.available, ledger.unavailable, ledger.uncertain, ledger.unrecorded]) {
    bucket.sort(byNameThenId);
  }

  // The scale is chosen over the WHOLE roster — see `DayScenarios.ratingSource`.
  const selection = selectRosterRatingSource({
    rosterPlayerIds: roster.map((p) => p.playerId),
    ratings: input.ratings,
  });
  const inverted = selection.source !== null && INVERTED_RATING_SOURCES.has(selection.source);
  const ratingOf = (playerId: number): number | null => selection.latestBySource.get(playerId)?.value ?? null;
  /** The rating normalized for DIRECTION: negated for the inverted WTN sources, so "higher is
   * stronger" holds for every scale and no ordering here can silently run backwards on a WTN
   * roster. */
  const strengthOf = (playerId: number): number | null => {
    const value = ratingOf(playerId);
    if (value === null) return null;
    return inverted ? -value : value;
  };

  const nameOf = new Map(roster.map((p) => [p.playerId, p.canonicalName]));
  const eligible = ledger.available.map((p) => p.playerId).sort((a, b) => a - b);

  /**
   * Stronger first; unrated last; ties by `playerId`.
   *
   * No epsilon here, deliberately, unlike `byGroupStrength` below: a single player's strength is a
   * stored value, or that value negated, and negation is exact in IEEE-754 — no arithmetic
   * accumulates, so two strengths are equal exactly when the two stored ratings are. The tolerance
   * belongs where the error does, which is the SUMS.
   */
  const byStrength = (a: number, b: number): number => {
    const sa = strengthOf(a);
    const sb = strengthOf(b);
    if (sa !== sb) {
      if (sa === null) return 1;
      if (sb === null) return -1;
      return sb - sa;
    }
    return a - b;
  };

  const ratedCount = (ids: number[]): number => ids.filter((id) => strengthOf(id) !== null).length;
  const sumStrength = (ids: number[]): number =>
    ids.reduce((total, id) => total + (strengthOf(id) ?? 0), 0);

  /**
   * Orders GROUPS of players (a candidate pair, an assigned court): more rated members first, then
   * the greater combined strength, then the ascending id tuple.
   *
   * Rated-count leads deliberately, and it is not decoration. Summing "rated only" alone would score
   * an entirely unrated pair at 0, and on an inverted scale every real strength is NEGATIVE
   * (`strength = -WTN`) — so an unrated pair would outrank every rated one, putting the players we
   * know nothing about on the top court. Comparing coverage first keeps the rule scale-independent.
   */
  const byGroupStrength = (a: number[], b: number[]): number => {
    const ra = ratedCount(a);
    const rb = ratedCount(b);
    if (ra !== rb) return rb - ra;
    const sa = sumStrength(a);
    const sb = sumStrength(b);
    if (Math.abs(sa - sb) > EPSILON) return sb - sa;
    return compareIdTuples(a, b);
  };

  const singlesSlots = input.slotSet.filter((c) => c.discipline === "singles");
  const doublesSlots = input.slotSet.filter((c) => c.discipline === "doubles");
  const bodiesNeeded = singlesSlots.length + doublesSlots.length * 2;

  // Singles-court appearances per player, from this team's own rows.
  //
  // Counted for EVERY participant, including the opponents `courtMatchRowsForPlayers` pre-joins onto
  // each row. An earlier revision filtered to the eligible set first; that guard was provably
  // redundant — the only reader below is `singlesOrder`, which iterates `eligible`, so an entry for
  // anyone else can never be read — and a branch no fixture can distinguish reads as coverage while
  // giving the next reader nothing to check. Recorded here rather than re-added.
  const singlesCount = new Map<number, number>();
  for (const row of input.rows) {
    if (row.discipline !== "singles") continue;
    for (const p of row.participants) {
      singlesCount.set(p.playerId, (singlesCount.get(p.playerId) ?? 0) + 1);
    }
  }

  // Shared doubles matches, via `derive.ts`'s own `partnerFrequency` rather than a second count of
  // the same thing — "however many on a side", never `[0]`/`[1]`.
  const sharedWith = new Map<number, Map<number, number>>();
  for (const playerId of eligible) {
    const counts = new Map<number, number>();
    for (const entry of partnerFrequency(input.rows, playerId)) counts.set(entry.partnerId, entry.count);
    sharedWith.set(playerId, counts);
  }
  const sharedMatches = (a: number, b: number): number => sharedWith.get(a)?.get(b) ?? 0;

  type Assignment = Map<string, number[]>;

  /** The two strongest of `pool`, or the whole of it when there are not two. */
  const strongestPair = (pool: number[]): number[] => [...pool].sort(byStrength).slice(0, 2);

  const strengthFirst = (): Assignment => {
    const assignment: Assignment = new Map();
    const pool = [...eligible].sort(byStrength);
    for (const court of singlesSlots) {
      const pick = pool.shift();
      if (pick === undefined) break;
      assignment.set(court.slot, [pick]);
    }
    for (const court of doublesSlots) {
      if (pool.length < 2) break; // one body left is one body sitting, never a half-filled court
      assignment.set(court.slot, [pool.shift()!, pool.shift()!]);
    }
    return assignment;
  };

  const historyFirst = (): Assignment => {
    const assignment: Assignment = new Map();
    const taken = new Set<number>();
    const singlesOrder = [...eligible].sort((a, b) => {
      const ca = singlesCount.get(a) ?? 0;
      const cb = singlesCount.get(b) ?? 0;
      if (ca !== cb) return cb - ca;
      return byStrength(a, b);
    });
    for (const court of singlesSlots) {
      const pick = singlesOrder.find((id) => !taken.has(id));
      if (pick === undefined) break;
      assignment.set(court.slot, [pick]);
      taken.add(pick);
    }

    for (const court of doublesSlots) {
      const rest = eligible.filter((id) => !taken.has(id));
      if (rest.length < 2) break;

      const candidates: number[][] = [];
      for (let i = 0; i < rest.length; i++) {
        for (let j = i + 1; j < rest.length; j++) candidates.push([rest[i]!, rest[j]!]);
      }
      candidates.sort((a, b) => {
        const sa = sharedMatches(a[0]!, a[1]!);
        const sb = sharedMatches(b[0]!, b[1]!);
        if (sa !== sb) return sb - sa;
        return byGroupStrength(a, b);
      });
      const best = candidates[0]!;
      // Once no partnership with any shared history remains, the rest simply pair by strength —
      // stated as its own step rather than left to fall out of a zero-count tie-break.
      const chosen = sharedMatches(best[0]!, best[1]!) > 0 ? best : strongestPair(rest);
      assignment.set(court.slot, chosen);
      for (const id of chosen) taken.add(id);
    }
    return assignment;
  };

  const balanced = (): Assignment => {
    const assignment: Assignment = new Map();
    const pool = [...eligible].sort(byStrength);
    for (const court of singlesSlots) {
      const pick = pool.shift();
      if (pick === undefined) break;
      assignment.set(court.slot, [pick]);
    }

    const fillable = Math.min(doublesSlots.length, Math.floor(pool.length / 2));
    if (fillable === 0) return assignment;
    // The strongest 2n remaining, re-partitioned among themselves: the players are the same ones
    // strength-first would field, and only their DISTRIBUTION across the courts differs.
    const field = pool.slice(0, fillable * 2);

    let bestPairs: [number, number][] | null = null;
    let bestSpread = Number.POSITIVE_INFINITY;
    for (const partition of enumeratePairings(field)) {
      // The objective counts only RATED members (an unrated one adds nothing), which is why
      // `ratedEligible` is reported alongside — a court compared on fewer values is compared on
      // less, and the number that says so has to be on the page.
      const sums = partition.map(([a, b]) => sumStrength([a, b]));
      const spread = Math.max(...sums) - Math.min(...sums);
      // No id-tuple tie-break on an equal spread, and the equivalence argument is recorded here
      // rather than the branch being kept: every perfect matching of `field` flattens to the SAME
      // multiset of ids, and `compareIdTuples` sorts both sides ascending, so a comparison between
      // two partitions of one field is *always* 0. The clause could never switch `bestPairs` — a
      // branch no fixture can kill, which `rules/testing.md` says to delete rather than test.
      //
      // Determinism does not rest on it. `enumeratePairings` walks a fixed order over a field
      // already sorted by `byStrength`, so an equal-spread tie resolves to the first matching in
      // that order — itself a function of the ids alone, not of input array order. The
      // reversed-input test pins exactly that.
      const better = bestPairs === null || spread < bestSpread - EPSILON;
      if (better) {
        bestPairs = partition;
        bestSpread = spread;
      }
    }

    const ordered = [...bestPairs!].sort((a, b) => byGroupStrength([...a], [...b]));
    ordered.forEach((pair, index) => assignment.set(doublesSlots[index]!.slot, [...pair]));
    return assignment;
  };

  // `player #<id>` is unreachable in practice — every id placed below came from `eligible`, which
  // came from the ledger, which was built from `roster`, which is what `nameOf` was built from — and
  // is kept only so a presenter can never be handed `undefined`, matching the existing convention in
  // `lineup.ts` / `player-profile.ts` / `team-profile.ts` (and the same branch left uncovered there).
  // `test/query-lineup-build.test.ts` pins the guarantee the convention exists for, asserting the
  // whole result never contains that string — the defect #16 shipped into a printed dossier.
  const namedPlayer = (playerId: number): ScenarioPlayer => ({
    playerId,
    canonicalName: nameOf.get(playerId) ?? `player #${playerId}`,
    rating: ratingOf(playerId),
    strength: strengthOf(playerId),
  });

  const toScenario = (strategy: ScenarioStrategy, assignment: Assignment): Scenario => {
    const placed = new Set<number>();
    const courts: ScenarioCourt[] = input.slotSet.map((court) => {
      const seats = court.discipline === "singles" ? 1 : 2;
      const ids = [...(assignment.get(court.slot) ?? [])].sort(byStrength);
      for (const id of ids) placed.add(id);
      const rated = ratedCount(ids);
      return {
        slot: court.slot,
        discipline: court.discipline,
        players: ids.map(namedPlayer),
        seats,
        filled: ids.length === seats,
        sharedMatches: court.discipline === "doubles" && ids.length === 2 ? sharedMatches(ids[0]!, ids[1]!) : null,
        courtRating:
          rated === 0 ? null : ids.reduce((total, id) => total + (ratingOf(id) ?? 0), 0),
        courtStrength: rated === 0 ? null : sumStrength(ids),
        ratedPlayers: rated,
      };
    });

    const unfilled = courts.filter((c) => !c.filled);
    return {
      strategies: [strategy],
      courts,
      sitting: ledger.available.filter((p) => !placed.has(p.playerId)),
      unfilledSlots: unfilled.map((c) => c.slot),
      unfilledSeats: unfilled.reduce((total, c) => total + (c.seats - c.players.length), 0),
    };
  };

  /** Two scenarios are the same scenario when every court holds the same people. Compared on the
   * assignment alone — the derived numbers beside it are a function of that assignment, so adding
   * them to the key could only ever make two identical tables read as two different options. */
  const assignmentKey = (scenario: Scenario): string =>
    JSON.stringify(scenario.courts.map((c) => [c.slot, c.players.map((p) => p.playerId)]));

  const scenarios: Scenario[] = [];
  const seen = new Map<string, Scenario>();
  const built: [ScenarioStrategy, Assignment][] = [
    ["strength-first", strengthFirst()],
    ["history-first", historyFirst()],
    ["balanced", balanced()],
  ];
  for (const [strategy, assignment] of built) {
    const scenario = toScenario(strategy, assignment);
    const existing = seen.get(assignmentKey(scenario));
    if (existing !== undefined) {
      existing.strategies.push(strategy);
      continue;
    }
    seen.set(assignmentKey(scenario), scenario);
    scenarios.push(scenario);
  }

  return {
    ledger,
    eligibleCount: eligible.length,
    bodiesNeeded,
    shortfall: Math.max(0, bodiesNeeded - eligible.length),
    ratingSource: selection.source,
    ratedEligible: ratedCount(eligible),
    scenarios,
  };
}
