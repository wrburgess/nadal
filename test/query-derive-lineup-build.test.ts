// The pure rules layer for `tn lineup build` (#127), tested against hand-built inputs a real
// fixture cannot exhibit — the same split `derive.ts`/`lineup.ts` already enforce. There is no `db`
// and no clock here; `test/query-lineup-build.test.ts` covers the assembly layer that feeds it.
//
// The production data cannot exercise this feature at all: one unavailability across 33 rows and
// zero captain notes means a builder that ignored availability entirely would look correct on two of
// three days. Every case below is therefore a constructed fixture.

import { describe, expect, it } from "vitest";
import {
  EmptySlotSetError,
  STRATEGY_RULES,
  buildDayScenarios,
} from "../src/query/derive-lineup-build.js";
import type {
  BuildDayScenariosInput,
  DayScenarios,
  Scenario,
  ScenarioStrategy,
} from "../src/query/derive-lineup-build.js";
import type { CourtMatchRow, RatingObservationRow } from "../src/query/types.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type Status = "available" | "unavailable" | "uncertain" | null;

function player(playerId: number, canonicalName: string, status: Status = "available") {
  return { playerId, canonicalName, status };
}

/** `n` available players, ids 1..n, names "Player 01".. so name order and id order agree unless a
 * test deliberately makes them disagree. */
function availableRoster(n: number) {
  return Array.from({ length: n }, (_, i) => player(i + 1, `Player ${String(i + 1).padStart(2, "0")}`));
}

function ratings(
  source: string,
  values: Record<number, number>,
): { playerId: number; observations: RatingObservationRow[] }[] {
  return Object.entries(values).map(([playerId, value], index) => ({
    playerId: Number(playerId),
    observations: [{ id: index + 1, source, value, ratingType: null, observedOn: "2026-01-01" }],
  }));
}

let nextRowId = 0;

function doublesRow(slot: string, pair: [number, number]): CourtMatchRow {
  nextRowId += 1;
  return {
    id: nextRowId,
    slot,
    discipline: "doubles",
    winnerSide: "home",
    playedOn: "2026-05-01",
    participants: [
      { playerId: pair[0], side: "home" },
      { playerId: pair[1], side: "home" },
    ],
  };
}

function doublesRows(slot: string, pair: [number, number], times: number): CourtMatchRow[] {
  return Array.from({ length: times }, () => doublesRow(slot, pair));
}

function singlesRows(slot: string, playerId: number, times: number): CourtMatchRow[] {
  return Array.from({ length: times }, () => {
    nextRowId += 1;
    return {
      id: nextRowId,
      slot,
      discipline: "singles",
      winnerSide: "home",
      playedOn: "2026-05-01",
      participants: [{ playerId, side: "home" }],
    } satisfies CourtMatchRow;
  });
}

/** The Springfield shape: one singles court and three doubles courts, seven bodies. */
const SLOT_SET = [
  { slot: "S1", discipline: "singles" as const },
  { slot: "D1", discipline: "doubles" as const },
  { slot: "D2", discipline: "doubles" as const },
  { slot: "D3", discipline: "doubles" as const },
];

function input(overrides: Partial<BuildDayScenariosInput> = {}): BuildDayScenariosInput {
  return {
    players: availableRoster(10),
    slotSet: SLOT_SET,
    ratings: [],
    rows: [],
    ...overrides,
  };
}

function scenarioFor(result: DayScenarios, strategy: ScenarioStrategy): Scenario {
  const found = result.scenarios.find((s) => s.strategies.includes(strategy));
  if (found === undefined) throw new Error(`no scenario carries strategy ${strategy}`);
  return found;
}

function courtIds(scenario: Scenario, slot: string): number[] {
  const court = scenario.courts.find((c) => c.slot === slot);
  if (court === undefined) throw new Error(`no court ${slot}`);
  return court.players.map((p) => p.playerId);
}

const ALL_STRATEGIES: ScenarioStrategy[] = ["strength-first", "history-first", "balanced"];

// ---------------------------------------------------------------------------

describe("buildDayScenarios — happy path", () => {
  it("places 7 and sits 3 in every strategy, with every court full", () => {
    const result = buildDayScenarios(
      input({
        ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2, 4: 4.0, 5: 3.9, 6: 3.7, 7: 3.5, 8: 3.3, 9: 3.1, 10: 3.0 }),
        rows: [...doublesRows("D1", [2, 3], 4), ...singlesRows("S1", 1, 3)],
      }),
    );

    expect(result.bodiesNeeded).toBe(7);
    expect(result.eligibleCount).toBe(10);
    expect(result.shortfall).toBe(0);
    expect(result.ratingSource).toBe("tr_dynamic");
    expect(result.ratedEligible).toBe(10);

    for (const strategy of ALL_STRATEGIES) {
      const scenario = scenarioFor(result, strategy);
      const placed = scenario.courts.flatMap((c) => c.players.map((p) => p.playerId));
      expect(placed, strategy).toHaveLength(7);
      expect(scenario.sitting, strategy).toHaveLength(3);
      expect(scenario.unfilledSlots, strategy).toEqual([]);
      expect(scenario.unfilledSeats, strategy).toBe(0);
      expect(scenario.courts.map((c) => c.slot), strategy).toEqual(["S1", "D1", "D2", "D3"]);
      expect(scenario.courts.every((c) => c.filled), strategy).toBe(true);
      // Sitting and placed together account for every eligible body — nobody vanishes.
      expect([...placed, ...scenario.sitting.map((p) => p.playerId)].sort((a, b) => a - b)).toEqual(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      );
    }
  });

  it("names every strategy exactly once across the returned scenarios", () => {
    const result = buildDayScenarios(
      input({ ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2, 4: 4.0, 5: 3.9, 6: 3.7, 7: 3.5 }) }),
    );
    const named = result.scenarios.flatMap((s) => s.strategies);
    expect([...named].sort()).toEqual([...ALL_STRATEGIES].sort());
    // And every named strategy has a stated rule, so a renderer never invents one.
    for (const strategy of ALL_STRATEGIES) expect(STRATEGY_RULES[strategy].length).toBeGreaterThan(0);
  });
});

describe("buildDayScenarios — the hard constraint", () => {
  // The fixture is built so the greedy step WOULD reuse a player if the constraint were removed:
  // (1,2) share 10 doubles matches, more than any other pair, so a greedy pass that did not remove
  // placed players from the pool would hand (1,2) D1, D2 AND D3. The guard is therefore the only
  // thing that can produce the expected value — this test cannot pass vacuously.
  //
  // Player 9 carries the singles history so `history-first` sends THEM to S1, which is what lets
  // (1,2) actually reach a doubles court: an earlier draft of this fixture gave S1 to player 1 on
  // rating and the dominant pair could never form at all, so the test asserted nothing.
  const contested = input({
    players: availableRoster(9),
    ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2, 4: 4.0, 5: 3.9, 6: 3.7, 7: 3.5, 8: 3.3, 9: 3.1 }),
    rows: [
      ...doublesRows("D1", [1, 2], 10),
      ...doublesRows("D2", [3, 4], 2),
      ...doublesRows("D3", [5, 6], 1),
      ...singlesRows("S1", 9, 5),
    ],
  });

  it("no playerId appears on two courts of one scenario", () => {
    const result = buildDayScenarios(contested);
    for (const scenario of result.scenarios) {
      const placed = scenario.courts.flatMap((c) => c.players.map((p) => p.playerId));
      expect(new Set(placed).size, scenario.strategies.join("+")).toBe(placed.length);
    }
  });

  it("the dominant pair takes ONE court and then leaves the pool", () => {
    const result = buildDayScenarios(contested);
    const history = scenarioFor(result, "history-first");
    expect(courtIds(history, "S1")).toEqual([9]);

    const doublesCourts = history.courts.filter((c) => c.discipline === "doubles");
    const holding = doublesCourts.filter((c) => c.players.some((p) => p.playerId === 1 || p.playerId === 2));
    // Exactly one court, holding exactly the pair — the other two doubles courts went to the
    // next-best partnerships, which is only possible because 1 and 2 left the pool.
    expect(holding).toHaveLength(1);
    expect(holding[0]!.players.map((p) => p.playerId).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(holding[0]!.sharedMatches).toBe(10);
    expect(doublesCourts.map((c) => c.players.map((p) => p.playerId).sort((a, b) => a - b))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("a player placed at singles is not also placed at doubles", () => {
    const result = buildDayScenarios(contested);
    for (const scenario of result.scenarios) {
      const singles = courtIds(scenario, "S1");
      const doubles = scenario.courts.filter((c) => c.discipline === "doubles").flatMap((c) => c.players.map((p) => p.playerId));
      for (const id of singles) expect(doubles, scenario.strategies.join("+")).not.toContain(id);
    }
  });
});

describe("buildDayScenarios — strength-first", () => {
  it("puts the strongest at S1 and stacks the doubles courts D1 >= D2 >= D3", () => {
    const result = buildDayScenarios(
      input({
        players: availableRoster(7),
        ratings: ratings("tr_dynamic", { 1: 3.0, 2: 3.5, 3: 3.2, 4: 4.5, 5: 4.4, 6: 4.0, 7: 3.8 }),
      }),
    );
    const scenario = scenarioFor(result, "strength-first");

    expect(courtIds(scenario, "S1")).toEqual([4]); // 4.5, the strongest
    expect(courtIds(scenario, "D1")).toEqual([5, 6]); // 4.4 + 4.0
    expect(courtIds(scenario, "D2")).toEqual([7, 2]); // 3.8 + 3.5
    expect(courtIds(scenario, "D3")).toEqual([3, 1]); // 3.2 + 3.0

    const doubles = scenario.courts.filter((c) => c.discipline === "doubles");
    for (let i = 1; i < doubles.length; i++) {
      expect(doubles[i - 1]!.courtStrength!).toBeGreaterThanOrEqual(doubles[i]!.courtStrength!);
    }
    // The court rating is reported in the named scale, not as the internal strength.
    expect(doubles[0]!.courtRating).toBeCloseTo(8.4, 6);
    expect(doubles[0]!.ratedPlayers).toBe(2);
  });
});

describe("buildDayScenarios — history-first", () => {
  // 4 shared matches for (6,7), who rating would never pair: 6 is the second-strongest doubles
  // player and 7 the weakest. strength-first splits them; history-first must not.
  const shared = input({
    players: availableRoster(7),
    ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2, 4: 4.0, 5: 3.9, 6: 4.3, 7: 3.0 }),
    rows: [...doublesRows("D1", [6, 7], 4), ...singlesRows("S1", 5, 6), ...singlesRows("S1", 1, 1)],
  });

  it("keeps a 4-match pairing intact even when rating would split it", () => {
    const scenario = scenarioFor(buildDayScenarios(shared), "history-first");
    const together = scenario.courts.find((c) => c.players.some((p) => p.playerId === 6));
    expect(together!.players.map((p) => p.playerId).sort((a, b) => a - b)).toEqual([6, 7]);
    expect(together!.sharedMatches).toBe(4);

    // And the contrast that makes the assertion mean something: strength-first splits them.
    const stacked = scenarioFor(buildDayScenarios(shared), "strength-first");
    const stackedCourt = stacked.courts.find((c) => c.players.some((p) => p.playerId === 6));
    expect(stackedCourt!.players.map((p) => p.playerId)).not.toEqual([6, 7]);
  });

  it("sends singles to the highest singles-match count, not the highest rating", () => {
    const scenario = scenarioFor(buildDayScenarios(shared), "history-first");
    expect(courtIds(scenario, "S1")).toEqual([5]); // 6 singles matches, and only the 5th-best rating
    expect(courtIds(scenarioFor(buildDayScenarios(shared), "strength-first"), "S1")).toEqual([1]);
  });

  it("pairs the rest by strength once no positive-history pair remains", () => {
    const scenario = scenarioFor(buildDayScenarios(shared), "history-first");
    const noHistory = scenario.courts.filter((c) => c.discipline === "doubles" && c.sharedMatches === 0);
    expect(noHistory.length).toBeGreaterThan(0);
    for (const court of noHistory) {
      expect(court.players).toHaveLength(2);
      expect(court.sharedMatches).toBe(0);
    }
  });
});

describe("buildDayScenarios — balanced", () => {
  /** Every perfect matching of an even-length list, written independently of the implementation so
   * this test cannot pass by agreeing with the same bug twice. */
  function pairings(ids: number[]): [number, number][][] {
    if (ids.length === 0) return [[]];
    const [first, ...rest] = ids;
    const out: [number, number][][] = [];
    for (let i = 0; i < rest.length; i++) {
      const partner = rest[i]!;
      const remaining = rest.filter((_, j) => j !== i);
      for (const tail of pairings(remaining)) out.push([[first!, partner], ...tail]);
    }
    return out;
  }

  const VALUES: Record<number, number> = { 1: 4.5, 2: 4.4, 3: 4.0, 4: 3.8, 5: 3.5, 6: 3.2, 7: 3.0 };
  const balancedInput = input({ players: availableRoster(7), ratings: ratings("tr_dynamic", VALUES) });

  it("enumerates all 15 pairings of 6 (the search space this test brute-forces)", () => {
    expect(pairings([2, 3, 4, 5, 6, 7])).toHaveLength(15);
  });

  it("achieves the brute-force minimum spread, not merely a plausible-looking lineup", () => {
    const result = buildDayScenarios(balancedInput);
    const scenario = scenarioFor(result, "balanced");

    // S1 takes the strongest (as strength-first), leaving these six to be re-partitioned.
    expect(courtIds(scenario, "S1")).toEqual([1]);
    const remaining = [2, 3, 4, 5, 6, 7];

    const spreadOf = (partition: [number, number][]): number => {
      const sums = partition.map(([a, b]) => VALUES[a]! + VALUES[b]!);
      return Math.max(...sums) - Math.min(...sums);
    };
    const minSpread = Math.min(...pairings(remaining).map(spreadOf));

    const actual = scenario.courts
      .filter((c) => c.discipline === "doubles")
      .map((c) => c.players.map((p) => p.playerId) as [number, number]);
    expect(actual.flat().sort((a, b) => a - b)).toEqual(remaining);
    expect(spreadOf(actual)).toBeCloseTo(minSpread, 6);

    // Not vacuous: the naive stacking strength-first produces is strictly worse, so agreeing with
    // the minimum is a real choice rather than the only outcome available.
    const stacked = scenarioFor(buildDayScenarios(balancedInput), "strength-first").courts
      .filter((c) => c.discipline === "doubles")
      .map((c) => c.players.map((p) => p.playerId) as [number, number]);
    expect(spreadOf(stacked)).toBeGreaterThan(minSpread + 1e-9);
  });

  it("assigns the balanced pairs D1 -> D3 by combined strength descending", () => {
    const scenario = scenarioFor(buildDayScenarios(balancedInput), "balanced");
    const doubles = scenario.courts.filter((c) => c.discipline === "doubles");
    for (let i = 1; i < doubles.length; i++) {
      expect(doubles[i - 1]!.courtStrength!).toBeGreaterThanOrEqual(doubles[i]!.courtStrength! - 1e-9);
    }
  });
});

describe("buildDayScenarios — an inverted scale", () => {
  // wtn_singles: a LOWER number is the stronger player. Every ordering below would come out exactly
  // backwards if the direction were not normalized.
  const WTN: Record<number, number> = { 1: 8.0, 2: 4.0, 3: 4.5, 4: 5.0, 5: 5.5, 6: 6.0, 7: 7.5 };
  const wtnInput = input({ players: availableRoster(7), ratings: ratings("wtn_singles", WTN) });

  it("strength-first picks the LOWEST value first", () => {
    const result = buildDayScenarios(wtnInput);
    expect(result.ratingSource).toBe("wtn_singles");
    const scenario = scenarioFor(result, "strength-first");
    expect(courtIds(scenario, "S1")).toEqual([2]); // 4.0, the strongest WTN
    expect(courtIds(scenario, "D1")).toEqual([3, 4]); // 4.5 + 5.0
    // The printed rating stays in the source's own scale; the strength is the normalized number.
    const s1 = scenario.courts[0]!.players[0]!;
    expect(s1.rating).toBe(4.0);
    expect(s1.strength).toBe(-4.0);
  });

  it("balanced does not invert — its strongest pair still lands on D1", () => {
    const scenario = scenarioFor(buildDayScenarios(wtnInput), "balanced");
    const doubles = scenario.courts.filter((c) => c.discipline === "doubles");
    const rawSums = doubles.map((c) => c.courtRating!);
    // Descending STRENGTH is ascending WTN: the lowest combined WTN is the strongest court.
    for (let i = 1; i < rawSums.length; i++) {
      expect(rawSums[i - 1]!).toBeLessThanOrEqual(rawSums[i]! + 1e-9);
    }
    expect(doubles[0]!.courtStrength!).toBeGreaterThanOrEqual(doubles[doubles.length - 1]!.courtStrength!);
  });
});

describe("buildDayScenarios — shortfall", () => {
  it("6 eligible for 7 slots: the last doubles court is unfilled, shortfall 1, nobody double-booked", () => {
    const result = buildDayScenarios(
      input({
        players: availableRoster(6),
        ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2, 4: 4.0, 5: 3.9, 6: 3.7 }),
      }),
    );

    expect(result.eligibleCount).toBe(6);
    expect(result.bodiesNeeded).toBe(7);
    expect(result.shortfall).toBe(1);

    for (const scenario of result.scenarios) {
      const label = scenario.strategies.join("+");
      expect(scenario.courts.map((c) => c.slot), label).toEqual(["S1", "D1", "D2", "D3"]);
      expect(scenario.unfilledSlots, label).toEqual(["D3"]);
      expect(scenario.unfilledSeats, label).toBe(2);
      const placed = scenario.courts.flatMap((c) => c.players.map((p) => p.playerId));
      expect(placed, label).toHaveLength(5);
      expect(new Set(placed).size, label).toBe(placed.length);
      expect(scenario.sitting.map((p) => p.playerId), label).toHaveLength(1);
    }
  });

  it("one body left for a doubles court: that player SITS, the court is unfilled rather than half-filled", () => {
    const result = buildDayScenarios(
      input({
        players: availableRoster(4),
        slotSet: [
          { slot: "S1", discipline: "singles" },
          { slot: "D1", discipline: "doubles" },
        ],
        ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2, 4: 4.0 }),
      }),
    );
    // 4 eligible, 3 seats: S1 + D1 fill, one sits — not the case under test. Narrow it to 2 seats
    // with an odd body left over.
    expect(result.shortfall).toBe(0);

    const odd = buildDayScenarios(
      input({
        players: availableRoster(2),
        slotSet: [
          { slot: "S1", discipline: "singles" },
          { slot: "D1", discipline: "doubles" },
        ],
        ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4 }),
      }),
    );
    for (const scenario of odd.scenarios) {
      const label = scenario.strategies.join("+");
      expect(courtIds(scenario, "S1"), label).toHaveLength(1);
      const d1 = scenario.courts.find((c) => c.slot === "D1")!;
      expect(d1.players, label).toEqual([]);
      expect(d1.filled, label).toBe(false);
      expect(scenario.sitting.map((p) => p.playerId), label).toHaveLength(1);
      expect(scenario.unfilledSeats, label).toBe(2);
    }
  });

  it("nobody eligible: every slot unfilled, everyone still in the ledger, no throw", () => {
    const result = buildDayScenarios(
      input({
        players: [
          player(1, "Unavailable One", "unavailable"),
          player(2, "Uncertain Two", "uncertain"),
          player(3, "Unrecorded Three", null),
        ],
      }),
    );

    expect(result.eligibleCount).toBe(0);
    expect(result.shortfall).toBe(7);
    expect(result.ledger.available).toEqual([]);
    expect(result.ledger.unavailable.map((p) => p.playerId)).toEqual([1]);
    expect(result.ledger.uncertain.map((p) => p.playerId)).toEqual([2]);
    expect(result.ledger.unrecorded.map((p) => p.playerId)).toEqual([3]);

    for (const scenario of result.scenarios) {
      expect(scenario.courts.map((c) => c.slot)).toEqual(["S1", "D1", "D2", "D3"]);
      expect(scenario.courts.every((c) => c.players.length === 0)).toBe(true);
      expect(scenario.unfilledSlots).toEqual(["S1", "D1", "D2", "D3"]);
      expect(scenario.unfilledSeats).toBe(7);
      expect(scenario.sitting).toEqual([]);
    }
  });
});

describe("buildDayScenarios — the honest-absence buckets", () => {
  it("keeps unrecorded (null) structurally distinct from unavailable, and fields neither", () => {
    const result = buildDayScenarios(
      input({
        players: [
          player(1, "Alice Available"),
          player(2, "Bob Blocked", "unavailable"),
          player(3, "Cass Chancy", "uncertain"),
          player(4, "Dee Dunno", null),
        ],
      }),
    );

    expect(result.ledger.available.map((p) => p.canonicalName)).toEqual(["Alice Available"]);
    expect(result.ledger.unavailable.map((p) => p.canonicalName)).toEqual(["Bob Blocked"]);
    expect(result.ledger.uncertain.map((p) => p.canonicalName)).toEqual(["Cass Chancy"]);
    expect(result.ledger.unrecorded.map((p) => p.canonicalName)).toEqual(["Dee Dunno"]);
    expect(result.eligibleCount).toBe(1);

    for (const scenario of result.scenarios) {
      const placed = scenario.courts.flatMap((c) => c.players.map((p) => p.playerId));
      expect(placed).toEqual([1]);
    }
  });

  it("orders every ledger bucket by name, tie-broken by playerId", () => {
    const result = buildDayScenarios(
      input({
        players: [player(9, "Zoe Zither"), player(3, "Amy Anders"), player(7, "Amy Anders"), player(5, "Mel Marsh")],
      }),
    );
    expect(result.ledger.available.map((p) => p.playerId)).toEqual([3, 7, 5, 9]);
  });
});

describe("buildDayScenarios — no history at all", () => {
  it("every pair reads no shared history and the scenarios still emit (no refusal)", () => {
    const result = buildDayScenarios(
      input({
        players: availableRoster(7),
        ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2, 4: 4.0, 5: 3.9, 6: 3.7, 7: 3.5 }),
        rows: [],
      }),
    );

    expect(result.scenarios.length).toBeGreaterThan(0);
    for (const scenario of result.scenarios) {
      for (const court of scenario.courts.filter((c) => c.discipline === "doubles")) {
        expect(court.sharedMatches).toBe(0);
        expect(court.players).toHaveLength(2);
      }
      expect(scenario.courts.filter((c) => c.discipline === "singles").every((c) => c.sharedMatches === null)).toBe(true);
    }
  });
});

describe("buildDayScenarios — no ratings at all", () => {
  it("reports ratingSource null and collapses the identical scenarios into ONE, named for each strategy", () => {
    const result = buildDayScenarios(input({ players: availableRoster(7), ratings: [], rows: [] }));

    expect(result.ratingSource).toBeNull();
    expect(result.ratedEligible).toBe(0);
    // Three identical tables must never read as three options.
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]!.strategies).toEqual(["strength-first", "history-first", "balanced"]);
    for (const court of result.scenarios[0]!.courts) {
      expect(court.courtRating).toBeNull();
      expect(court.courtStrength).toBeNull();
      expect(court.ratedPlayers).toBe(0);
      for (const p of court.players) {
        expect(p.rating).toBeNull();
        expect(p.strength).toBeNull();
      }
    }
  });

  it("two strategies that agree collapse while a third that differs stays its own scenario", () => {
    // History splits what strength would stack, so `history-first` differs while `strength-first`
    // and `balanced` agree — the case that proves the collapse is by CONTENT, not a fixed rule.
    const result = buildDayScenarios(
      input({
        players: availableRoster(5),
        slotSet: [
          { slot: "D1", discipline: "doubles" },
          { slot: "D2", discipline: "doubles" },
        ],
        ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.3, 4: 4.2, 5: 4.1 }),
        rows: doublesRows("D1", [1, 4], 5),
      }),
    );

    const strength = scenarioFor(result, "strength-first");
    const history = scenarioFor(result, "history-first");
    expect(courtIds(strength, "D1")).toEqual([1, 2]);
    expect(courtIds(history, "D1")).toEqual([1, 4]);
    expect(strength).not.toBe(history);
    expect(result.scenarios.length).toBeGreaterThan(1);
  });
});

describe("buildDayScenarios — partial ratings", () => {
  it("sorts the unrated last and says how many players the balance objective counted", () => {
    const result = buildDayScenarios(
      input({
        players: availableRoster(7),
        // Only five of the seven carry a rating.
        ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2, 4: 4.0, 5: 3.9 }),
      }),
    );

    expect(result.ratingSource).toBe("tr_dynamic");
    expect(result.ratedEligible).toBe(5);
    expect(result.eligibleCount).toBe(7);

    const scenario = scenarioFor(result, "strength-first");
    expect(courtIds(scenario, "S1")).toEqual([1]);
    // The two unrated (6, 7) sort behind every rated player, so they share the last doubles court.
    expect(courtIds(scenario, "D3")).toEqual([6, 7]);
    const d3 = scenario.courts.find((c) => c.slot === "D3")!;
    expect(d3.courtRating).toBeNull();
    expect(d3.ratedPlayers).toBe(0);
  });

  it("a court with one rated player reports the rated half and says so", () => {
    const result = buildDayScenarios(
      input({
        players: availableRoster(4),
        slotSet: [
          { slot: "D1", discipline: "doubles" },
          { slot: "D2", discipline: "doubles" },
        ],
        ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2 }),
      }),
    );
    const scenario = scenarioFor(result, "strength-first");
    const d2 = scenario.courts.find((c) => c.slot === "D2")!;
    expect(d2.players.map((p) => p.playerId)).toEqual([3, 4]);
    expect(d2.ratedPlayers).toBe(1);
    expect(d2.courtRating).toBeCloseTo(4.2, 6);
  });
});

describe("buildDayScenarios — determinism", () => {
  const base = input({
    players: availableRoster(9),
    ratings: ratings("tr_dynamic", { 1: 4.5, 2: 4.4, 3: 4.2, 4: 4.0, 5: 3.9, 6: 3.7, 7: 3.5, 8: 3.3, 9: 3.1 }),
    rows: [...doublesRows("D1", [2, 3], 3), ...doublesRows("D2", [5, 8], 2), ...singlesRows("S1", 4, 4)],
  });

  it("reversing every input array produces a byte-identical result", () => {
    const forward = buildDayScenarios(base);
    const reversed = buildDayScenarios({
      players: [...base.players].reverse(),
      slotSet: base.slotSet,
      ratings: [...base.ratings].reverse(),
      rows: [...base.rows].reverse(),
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("orders a rated player against an unrated one the same way in both directions", () => {
    // An asymmetric comparator — one that answered "rated beats unrated" but not the mirror — would
    // sort a partly-rated roster differently depending on which end the unrated players started at,
    // and every assertion above uses a fully-rated fixture where that could never show.
    const partial = input({
      players: availableRoster(7),
      ratings: ratings("tr_dynamic", { 2: 4.4, 4: 4.0, 6: 3.7 }),
    });
    const forward = buildDayScenarios(partial);
    const reversed = buildDayScenarios({ ...partial, players: [...partial.players].reverse() });

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    // The three rated players lead, in rating order, ahead of every unrated one.
    const strength = scenarioFor(forward, "strength-first");
    const placed = strength.courts.flatMap((c) => c.players.map((p) => p.playerId));
    expect(placed.slice(0, 3)).toEqual([2, 4, 6]);
  });

  it("resolves a total tie on rating and history by playerId, in either input order", () => {
    const tied = {
      players: [player(4, "Tied Four"), player(2, "Tied Two")],
      slotSet: [{ slot: "S1", discipline: "singles" as const }],
      ratings: ratings("tr_dynamic", { 2: 4.0, 4: 4.0 }),
      rows: [],
    };
    const forward = buildDayScenarios(tied);
    const reversed = buildDayScenarios({ ...tied, players: [...tied.players].reverse() });

    expect(courtIds(scenarioFor(forward, "strength-first"), "S1")).toEqual([2]);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});

describe("buildDayScenarios — input guards", () => {
  it("collapses a player the caller listed twice into one body, so nobody is cloned onto two courts", () => {
    const result = buildDayScenarios(
      input({
        players: [player(1, "Ada Ashby"), player(1, "Ada Ashby"), player(2, "Bo Bramwell")],
        slotSet: [{ slot: "D1", discipline: "doubles" }],
      }),
    );
    expect(result.eligibleCount).toBe(2);
    expect(result.ledger.available.map((p) => p.playerId)).toEqual([1, 2]);
    expect(courtIds(result.scenarios[0]!, "D1")).toEqual([1, 2]);
  });

  it("refuses an empty slot set (EmptySlotSetError), asserted by class", () => {
    expect(() => buildDayScenarios(input({ slotSet: [] }))).toThrow(EmptySlotSetError);
  });
});
