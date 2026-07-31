// The predicted-lineup heuristic (#17 PR B) — spec § Deliverables 1's "predicted lineup honestly
// labeled a guess", and spec § Open questions' "how court-assignment history + ratings become a
// labeled guess". The rule was chosen by the HC (issue #17, plan comment): **pair-first, then
// tendency, with ratings breaking every tie and filling every gap.**
//
// `predictedLineup` is pure — plain row arrays in, a typed result out, no `db` argument — like its
// siblings in derive.ts, and for the same reason: this is the layer that can be tested exhaustively
// with hand-built inputs no real fixture could exhibit. There is no real data on this project yet
// (no pull has ever run), so these tests are the ONLY specification of the rule; they are written to
// pin the rule down, not to demonstrate that the code runs.

import { describe, expect, it } from "vitest";
import { NoCourtMatchHistoryError, predictedLineup } from "../src/query/derive.js";
import type { CourtMatchRow, PredictedLineupInput, RatingSource, Side } from "../src/query/types.js";

let nextRowId = 0;
function row(
  slot: string,
  discipline: "singles" | "doubles",
  ours: number[],
  theirs: number[],
  options: { winnerSide?: Side | null; playedOn?: string | null } = {},
): CourtMatchRow {
  nextRowId += 1;
  return {
    id: nextRowId,
    slot,
    discipline,
    winnerSide: options.winnerSide === undefined ? "home" : options.winnerSide,
    playedOn: options.playedOn === undefined ? "2026-05-01" : options.playedOn,
    participants: [
      ...ours.map((playerId) => ({ playerId, side: "home" as Side })),
      ...theirs.map((playerId) => ({ playerId, side: "visiting" as Side })),
    ],
  };
}

/** Opponents are given negative ids and are never on the roster, so any pair count that leaks
 * across the net shows up as a wrong answer rather than as a plausible one. */
let nextOpponentId = 0;
function opponents(count: number): number[] {
  return Array.from({ length: count }, () => {
    nextOpponentId -= 1;
    return nextOpponentId;
  });
}

function doubles(slot: string, pair: [number, number], times: number): CourtMatchRow[] {
  return Array.from({ length: times }, () => row(slot, "doubles", pair, opponents(2)));
}

function singles(slot: string, playerId: number, times: number): CourtMatchRow[] {
  return Array.from({ length: times }, () => row(slot, "singles", [playerId], opponents(1)));
}

/** `{ 1: { ntrp: 4.0 } }` → the observation array shape `predictedLineup` consumes. Values are
 * dated identically on purpose: the "latest observation wins" rule has its own tests in
 * `query-derive.test.ts` (`ratingTrajectory`), and re-testing it here would obscure what these
 * cases are actually about. */
function ratingsFor(byPlayer: Record<number, Partial<Record<RatingSource, number>>>): PredictedLineupInput["ratings"] {
  let id = 0;
  return Object.entries(byPlayer).map(([playerId, sources]) => ({
    playerId: Number(playerId),
    observations: Object.entries(sources).map(([source, value]) => {
      id += 1;
      return { id, source, value: value as number, ratingType: null, observedOn: "2026-05-01" };
    }),
  }));
}

/** Slot -> the player ids placed there, for compact assertions. */
function placement(result: ReturnType<typeof predictedLineup>): Record<string, number[]> {
  return Object.fromEntries(result.slots.map((s) => [s.slot, [...s.playerIds].sort((a, b) => a - b)]));
}

const FOUR_COURT_ROSTER = [1, 2, 3, 4, 5, 6, 7];

describe("predictedLineup — the happy path", () => {
  it("places S1 by singles history and each pair at the slot it most often shared", () => {
    const rows = [
      ...singles("S1", 1, 6),
      ...doubles("D1", [2, 3], 8),
      ...doubles("D2", [4, 5], 6),
      ...doubles("D3", [6, 7], 5),
    ];

    const result = predictedLineup({ rows, rosterPlayerIds: FOUR_COURT_ROSTER, ratings: ratingsFor({}) });

    expect(placement(result)).toEqual({ S1: [1], D1: [2, 3], D2: [4, 5], D3: [6, 7] });
    expect(result.slots.map((s) => s.basis)).toEqual(["history", "history", "history", "history"]);
    expect(result.slots.map((s) => s.confidence)).toEqual(["high", "high", "high", "high"]);
    expect(result.unplaced).toEqual([]);
    expect(result.observedCourtMatches).toBe(25);
  });

  it("reports each slot's discipline from the observed rows rather than from the slot's spelling", () => {
    const rows = [...singles("S1", 1, 3), ...doubles("D1", [2, 3], 3)];
    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3], ratings: ratingsFor({}) });

    expect(result.slots.map((s) => [s.slot, s.discipline])).toEqual([
      ["S1", "singles"],
      ["D1", "doubles"],
    ]);
  });
});

describe("predictedLineup — pair-first is the rule that shipped", () => {
  // This is the load-bearing test of the whole feature. It is built so that a per-player
  // tendency rule (the option the HC rejected) SPLITS the pair, and only the pair-first rule keeps
  // it together — so it fails if the heuristic is ever quietly swapped.
  //
  // Player 2 and player 3 have played 8 times together: 3 at D1, 5 at D2 -> their modal SHARED slot
  // is D2. But player 2 has also played D1 four more times with player 6, so player 2's OWN modal
  // slot is D1 (3 + 4 = 7) while player 3's is D2 (5). A per-player rule therefore sends 2 to D1 and
  // 3 to D2, splitting a partnership with eight matches behind it.
  it("keeps a frequent partnership together even when each player's own modal slot would split it", () => {
    const rows = [
      ...singles("S1", 1, 5),
      ...doubles("D1", [2, 3], 3),
      ...doubles("D2", [2, 3], 5),
      ...doubles("D1", [2, 6], 4),
      ...doubles("D3", [4, 5], 4),
    ];

    const result = predictedLineup({
      rows,
      rosterPlayerIds: FOUR_COURT_ROSTER,
      ratings: ratingsFor({ 6: { ntrp: 4.0 }, 7: { ntrp: 3.5 } }),
    });

    expect(placement(result).D2, "the 8-match partnership survives").toEqual([2, 3]);
    const d2 = result.slots.find((s) => s.slot === "D2")!;
    expect(d2.support).toBe(8);
    expect(d2.confidence).toBe("high");
  });

  it("does not treat a one-off partnership as a pair (count of 1 is below the bar, 2 is at it)", () => {
    const onceTogether = [
      ...singles("S1", 1, 4),
      ...doubles("D1", [2, 3], 1), // one-off: not a candidate pair
      ...doubles("D2", [4, 5], 2), // exactly at the bar: is a candidate pair
    ];

    const result = predictedLineup({
      rows: onceTogether,
      rosterPlayerIds: [1, 2, 3, 4, 5],
      ratings: ratingsFor({ 2: { ntrp: 4.0 }, 3: { ntrp: 3.0 } }),
    });

    const d2 = result.slots.find((s) => s.slot === "D2")!;
    expect(d2.playerIds.slice().sort((a, b) => a - b)).toEqual([4, 5]);
    expect(d2.basis).toBe("history");

    const d1 = result.slots.find((s) => s.slot === "D1")!;
    expect(d1.basis, "a single shared match is not a partnership").toBe("rating");
    expect(d1.support).toBe(0);
  });
});

describe("predictedLineup — collisions and cascades", () => {
  it("gives a contested slot to the higher combined rating rank and cascades the loser to its own next-most-shared slot", () => {
    const rows = [
      ...singles("S1", 1, 4),
      ...doubles("D1", [2, 3], 6), // modal D1
      ...doubles("D1", [4, 5], 5), // also modal D1 — the collision
      ...doubles("D2", [4, 5], 3), // ...with D2 as their next-most-shared
      ...doubles("D3", [6, 7], 2),
    ];

    // 4 and 5 are the two strongest players, so THEY take the contested D1 even though 2/3 played
    // it more often. That is the rule the HC picked, stated in the plan as "collision -> higher
    // combined rating takes the better slot".
    const result = predictedLineup({
      rows,
      rosterPlayerIds: FOUR_COURT_ROSTER,
      ratings: ratingsFor({
        1: { ntrp: 3.9 },
        2: { ntrp: 3.4 },
        3: { ntrp: 3.3 },
        4: { ntrp: 4.2 },
        5: { ntrp: 4.1 },
        6: { ntrp: 3.1 },
        7: { ntrp: 3.0 },
      }),
    });

    expect(placement(result).D1).toEqual([4, 5]);
    expect(placement(result).D2, "the loser cascades to its own next-most-shared slot").toEqual([2, 3]);
    expect(placement(result).D3).toEqual([6, 7]);

    // The cascaded pair keeps its full partnership evidence — the cascade changed where they play,
    // not how well we know they play together.
    const d2 = result.slots.find((s) => s.slot === "D2")!;
    expect(d2.support).toBe(6);
    expect(d2.basis).toBe("history");
  });

  // Found by the independent Codex adversarial review of PR #47 (rated high). The first
  // implementation resolved contention in TWO phases: every pair contended only for its MODAL slot,
  // and only once all of those were settled did the losers cascade — into whatever was left, by
  // slot order, contesting nobody. So a pair that lost D1 could never contend for D2 against D2's
  // own claimant, however much better its combined rating. That contradicts the stated rule
  // ("a contested slot goes to the better combined rating rank"), because a cascader and a primary
  // claimant genuinely DO contest the same slot.
  //
  // Here 2/3 lose D1 to the stronger 4/5, then contest D2 — where they have five shared matches and
  // a better combined rank than 6/7, who have four. Under the two-phase algorithm 6/7 took D2
  // unopposed and 2/3 went unplaced entirely, which is the inversion this test pins down.
  it("lets a pair that lost its modal slot contest its next-most-shared slot, and win it on rating", () => {
    const rows = [
      ...singles("S1", 1, 3),
      ...doubles("D1", [2, 3], 6),
      ...doubles("D2", [2, 3], 5),
      ...doubles("D1", [4, 5], 7), // strongest pair, modal D1 — takes it from 2/3
      ...doubles("D2", [6, 7], 4), // D2's primary claimant, but the weakest pair on the roster
    ];

    const result = predictedLineup({
      rows,
      rosterPlayerIds: FOUR_COURT_ROSTER,
      ratings: ratingsFor({
        1: { ntrp: 3.0 },
        2: { ntrp: 4.3 },
        3: { ntrp: 4.2 },
        4: { ntrp: 4.5 },
        5: { ntrp: 4.4 },
        6: { ntrp: 3.5 },
        7: { ntrp: 3.4 },
      }),
    });

    expect(placement(result).D1, "the strongest pair takes its modal slot").toEqual([4, 5]);
    expect(placement(result).D2, "the cascader contests D2 and wins it on combined rating").toEqual([2, 3]);
    // 2/3 keep their FULL partnership evidence, not just the five matches at this slot.
    expect(result.slots.find((s) => s.slot === "D2")!.support).toBe(11);
    expect(result.slots.find((s) => s.slot === "D2")!.basis).toBe("history");
    // Only three courts were ever fielded, so the pair that lost the contest is listed, not dropped.
    expect(result.unplaced).toEqual([
      { playerId: 6, courtMatches: 4 },
      { playerId: 7, courtMatches: 4 },
    ]);
  });

  it("cascades a pair with nowhere historical left to any open slot, still as a history-based pairing", () => {
    const rows = [
      ...singles("S1", 1, 4),
      ...doubles("D1", [2, 3], 6),
      ...doubles("D1", [4, 5], 4), // only ever played D1
      ...doubles("D2", [6, 7], 3),
      ...doubles("D3", [6, 7], 1), // establishes D3 as a court this team fields
    ];

    const result = predictedLineup({
      rows,
      rosterPlayerIds: FOUR_COURT_ROSTER,
      ratings: ratingsFor({ 2: { ntrp: 4.2 }, 3: { ntrp: 4.1 }, 4: { ntrp: 3.2 }, 5: { ntrp: 3.1 } }),
    });

    expect(placement(result).D1).toEqual([2, 3]);
    // 4/5 have no other shared slot, so they land in the remaining open one — but they are still a
    // real partnership, so the basis stays "history".
    expect(placement(result).D3).toEqual([4, 5]);
    expect(result.slots.find((s) => s.slot === "D3")!.basis).toBe("history");
    expect(result.slots.find((s) => s.slot === "D3")!.support).toBe(4);
  });
});

describe("predictedLineup — ratings fill every gap", () => {
  it("pairs players with no shared history by rating, best two together, and marks the slot rating-based", () => {
    const rows = [
      ...singles("S1", 1, 5),
      ...doubles("D1", [2, 3], 4),
      // D2 and D3 have to have been PLAYED for them to be in the slot set at all — the set is
      // derived from observed history, so a court this team has never fielded is not predicted.
      // One appearance each by the already-placed pair establishes the courts without making
      // either of them that pair's modal slot.
      ...doubles("D2", [2, 3], 1),
      ...doubles("D3", [2, 3], 1),
    ];

    const result = predictedLineup({
      rows,
      rosterPlayerIds: FOUR_COURT_ROSTER,
      ratings: ratingsFor({
        4: { ntrp: 4.5 },
        5: { ntrp: 3.0 },
        6: { ntrp: 4.4 },
        7: { ntrp: 3.1 },
      }),
    });

    // Best two remaining (4 and 6) are paired together and take the earlier open slot.
    expect(placement(result).D2).toEqual([4, 6]);
    expect(placement(result).D3).toEqual([5, 7]);
    for (const slot of ["D2", "D3"]) {
      const s = result.slots.find((x) => x.slot === slot)!;
      expect(s.basis).toBe("rating");
      expect(s.support).toBe(0);
      expect(s.confidence).toBe("low");
    }
  });

  it("ranks within the rating source that covers the most of the roster, and names it", () => {
    const rows = [...singles("S1", 1, 3), ...doubles("D1", [2, 3], 3)];
    const result = predictedLineup({
      rows,
      rosterPlayerIds: FOUR_COURT_ROSTER,
      ratings: ratingsFor({
        1: { ntrp: 4.0 },
        2: { ntrp: 3.9 },
        3: { ntrp: 3.8 },
        4: { ntrp: 3.7 },
        5: { ntrp: 3.6 },
        6: { ntrp: 3.5, tr_dynamic: 3.9 },
        7: { tr_dynamic: 4.1 },
      }),
    });

    expect(result.ratingSource, "ntrp covers 6 of 7; tr_dynamic covers 2").toBe("ntrp");
    expect(result.unrankedPlayerIds, "player 7 has no ntrp observation").toEqual([7]);
  });

  it("breaks a coverage tie by the declared source precedence, tr_dynamic first", () => {
    const rows = [...doubles("D1", [1, 2], 3)];
    const result = predictedLineup({
      rows,
      rosterPlayerIds: [1, 2],
      ratings: ratingsFor({ 1: { ntrp: 4.0, tr_dynamic: 3.9 }, 2: { ntrp: 3.5, tr_dynamic: 3.4 } }),
    });

    expect(result.ratingSource).toBe("tr_dynamic");
  });

  it("sorts WTN inverted — a lower World Tennis Number is the stronger player", () => {
    const rows = [...singles("S1", 1, 2)];
    const result = predictedLineup({
      rows,
      rosterPlayerIds: [1, 2, 3],
      // 3 is the strongest on the WTN scale (12.0 beats 19.0), so 3 must be ranked ahead of 2 and
      // therefore paired first. With a naive descending sort this assertion inverts.
      ratings: ratingsFor({ 1: { wtn_doubles: 15.0 }, 2: { wtn_doubles: 19.0 }, 3: { wtn_doubles: 12.0 } }),
    });

    expect(result.ratingSource).toBe("wtn_doubles");
    expect(result.rankedPlayerIds, "best first").toEqual([3, 1, 2]);
  });

  it("reports no rating source at all when nobody is rated, and still produces a lineup", () => {
    const rows = [...singles("S1", 1, 3), ...doubles("D1", [2, 3], 3)];
    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3, 4, 5], ratings: ratingsFor({}) });

    expect(result.ratingSource).toBeNull();
    expect(result.unrankedPlayerIds.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(placement(result).S1).toEqual([1]);
    expect(placement(result).D1).toEqual([2, 3]);
  });
});

describe("predictedLineup — nothing is silently dropped", () => {
  it("lists the players it could not place, with their evidence counts", () => {
    const rows = [
      ...singles("S1", 1, 4),
      ...doubles("D1", [2, 3], 4),
      ...doubles("D2", [4, 5], 4),
      ...doubles("D3", [6, 7], 4),
      ...doubles("D1", [8, 9], 2),
    ];

    const result = predictedLineup({
      rows,
      rosterPlayerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      ratings: ratingsFor({}),
    });

    expect(result.slots).toHaveLength(4);
    expect(result.unplaced).toEqual([
      { playerId: 8, courtMatches: 2 },
      { playerId: 9, courtMatches: 2 },
    ]);
  });

  it("reports an unfilled slot rather than omitting it when the roster runs out", () => {
    const rows = [...singles("S1", 1, 3), ...doubles("D1", [2, 3], 3), ...doubles("D2", [2, 3], 1), ...doubles("D3", [2, 3], 1)];

    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3], ratings: ratingsFor({}) });

    expect(result.slots.map((s) => s.slot)).toEqual(["S1", "D1", "D2", "D3"]);
    expect(placement(result).D2, "nobody left").toEqual([]);
    expect(placement(result).D3).toEqual([]);
    expect(result.slots.find((s) => s.slot === "D2")!.confidence).toBe("low");
  });

  it("fills a doubles slot with a single leftover player rather than dropping them", () => {
    const rows = [...singles("S1", 1, 3), ...doubles("D1", [2, 3], 3), ...doubles("D2", [2, 3], 1)];

    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3, 4], ratings: ratingsFor({}) });

    expect(placement(result).D2).toEqual([4]);
    expect(result.unplaced).toEqual([]);
  });
});

describe("predictedLineup — the slot set comes from observed history", () => {
  it("orders singles slots before doubles, then by numeric suffix", () => {
    const rows = [
      ...doubles("D2", [4, 5], 2),
      ...singles("S1", 1, 2),
      ...doubles("D1", [2, 3], 2),
      ...doubles("D4", [6, 7], 2),
      ...doubles("D3", [8, 9], 2),
    ];

    const result = predictedLineup({
      rows,
      rosterPlayerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      ratings: ratingsFor({}),
    });

    expect(result.slots.map((s) => s.slot)).toEqual(["S1", "D1", "D2", "D3", "D4"]);
    expect(result.slotSource).toBe("observed");
  });

  it("carries an unenumerated slot through rather than dropping it", () => {
    // derive.ts's standing rule (see `slotTendencies`): the schema comment only names S1/D1-D4, and
    // an unrecognized value is data we do not understand, not data to discard.
    const rows = [...singles("S1", 1, 2), ...doubles("D1", [2, 3], 2), ...doubles("X9", [4, 5], 2)];

    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3, 4, 5], ratings: ratingsFor({}) });

    expect(result.slots.map((s) => s.slot)).toContain("X9");
    expect(placement(result).X9).toEqual([4, 5]);
  });

  it("derives five courts from a five-court history — the slot set is never hardcoded to Springfield's four", () => {
    const rows = [
      ...singles("S1", 1, 2),
      ...doubles("D1", [2, 3], 2),
      ...doubles("D2", [4, 5], 2),
      ...doubles("D3", [6, 7], 2),
      ...doubles("D4", [8, 9], 2),
    ];

    const result = predictedLineup({
      rows,
      rosterPlayerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      ratings: ratingsFor({}),
    });

    expect(result.slots).toHaveLength(5);
  });

  it("ignores rows no roster player took part in", () => {
    const rows = [
      ...singles("S1", 1, 2),
      ...doubles("D1", [2, 3], 2),
      // A court match between two OTHER teams that happens to be in the same row set.
      row("D4", "doubles", [], opponents(4)),
    ];

    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3], ratings: ratingsFor({}) });

    expect(result.slots.map((s) => s.slot), "D4 belongs to nobody on this roster").toEqual(["S1", "D1"]);
    expect(result.observedCourtMatches).toBe(4);
  });
});

describe("predictedLineup — confidence thresholds", () => {
  // Both sides of both boundaries, so an off-by-one in either comparison fails. The `1` case is a
  // boundary of a different kind: a single shared match is below the partnership bar entirely, so
  // the pair is not a candidate and the slot is filled by the rating fallback with no support at
  // all — support 0, not support 1.
  it.each([
    [1, 0, "low"],
    [2, 2, "medium"],
    [4, 4, "medium"],
    [5, 5, "high"],
  ])("a partnership seen %i time(s) carries support %i and reads %s", (times, support, expected) => {
    const rows = [...singles("S1", 1, 1), ...doubles("D1", [2, 3], times)];
    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3], ratings: ratingsFor({}) });

    const d1 = result.slots.find((s) => s.slot === "D1")!;
    expect(d1.support).toBe(support);
    expect(d1.confidence).toBe(expected);
  });

  it.each([
    [1, "low"],
    [2, "medium"],
    [4, "medium"],
    [5, "high"],
  ])("a singles player seen %i time(s) reads %s", (times, expected) => {
    const rows = [...singles("S1", 1, times), ...doubles("D1", [2, 3], 2)];
    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3], ratings: ratingsFor({}) });

    const s1 = result.slots.find((s) => s.slot === "S1")!;
    expect(s1.support).toBe(times);
    expect(s1.confidence).toBe(expected);
  });
});

describe("predictedLineup — sad paths and awkward data", () => {
  it("refuses a team with no court-match history rather than inventing an empty guess", () => {
    expect(() => predictedLineup({ rows: [], rosterPlayerIds: [1, 2, 3], ratings: ratingsFor({}) })).toThrow(
      NoCourtMatchHistoryError,
    );
  });

  it("refuses a team whose only rows involve nobody on the roster", () => {
    const rows = [row("D1", "doubles", [], opponents(4))];
    expect(() => predictedLineup({ rows, rosterPlayerIds: [1, 2], ratings: ratingsFor({}) })).toThrow(
      NoCourtMatchHistoryError,
    );
  });

  it("refuses an empty roster", () => {
    const rows = [...singles("S1", 1, 2)];
    expect(() => predictedLineup({ rows, rosterPlayerIds: [], ratings: ratingsFor({}) })).toThrow(
      NoCourtMatchHistoryError,
    );
  });

  it("handles a roster of one", () => {
    const rows = [...singles("S1", 1, 3)];
    const result = predictedLineup({ rows, rosterPlayerIds: [1], ratings: ratingsFor({}) });

    expect(placement(result)).toEqual({ S1: [1] });
    expect(result.unplaced).toEqual([]);
  });

  it("does not crash on a side carrying more than two participants", () => {
    // `upsertCourtMatchPlayers` never deletes (docs/findings.md, #15), so a corrected source page
    // can genuinely leave three players attached to one side of a doubles court.
    const rows = [
      ...singles("S1", 1, 2),
      row("D1", "doubles", [2, 3, 4], opponents(2)),
      row("D1", "doubles", [2, 3, 4], opponents(2)),
      ...doubles("D2", [5, 6], 2),
    ];

    const result = predictedLineup({
      rows,
      rosterPlayerIds: [1, 2, 3, 4, 5, 6],
      ratings: ratingsFor({}),
    });

    // Every pairwise combination on that side counts as a partnership, so one of them takes D1 and
    // the odd player out is placed or listed — never dropped, and never a three-player court.
    const d1 = result.slots.find((s) => s.slot === "D1")!;
    expect(d1.playerIds).toHaveLength(2);
    const placed = result.slots.flatMap((s) => s.playerIds);
    expect(new Set(placed).size, "no player appears on two courts").toBe(placed.length);
    expect([...placed, ...result.unplaced.map((u) => u.playerId)].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  // A slot carrying BOTH singles and doubles rows is not something a clean source produces, but the
  // slot vocabulary is open and this codebase's standing rule is to carry unknown data through
  // rather than drop it. The hazard is placing two players on a slot the data calls singles.
  it("never puts a pair on a slot whose observed discipline is singles", () => {
    const rows = [
      ...singles("S1", 1, 4),
      // S1 also carries two doubles rows — a minority, so the slot still reads "singles".
      row("S1", "doubles", [2, 3], opponents(2)),
      row("S1", "doubles", [2, 3], opponents(2)),
      ...doubles("D1", [4, 5], 3),
    ];

    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3, 4, 5], ratings: ratingsFor({}) });

    const s1 = result.slots.find((s) => s.slot === "S1")!;
    expect(s1.discipline).toBe("singles");
    expect(s1.playerIds, "a singles court holds exactly one player").toHaveLength(1);
    // 2 and 3 are a real pair with nowhere singles to go, so they cascade or fall to leftovers —
    // either way nobody is duplicated and nobody vanishes.
    const placed = result.slots.flatMap((s) => s.playerIds);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed, ...result.unplaced.map((u) => u.playerId)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts a doubles court once per pair, not once per participant row", () => {
    const rows = [...singles("S1", 1, 2), ...doubles("D1", [2, 3], 3)];
    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3], ratings: ratingsFor({}) });

    expect(result.slots.find((s) => s.slot === "D1")!.support).toBe(3);
  });

  it("counts an undated row: a lineup guess is about who plays together, not when", () => {
    // Deliberately different from `windowedRecord`, which EXCLUDES undated rows because a date
    // window is meaningless without a date. Court-assignment tendency has no window, so dropping
    // undated rows would silently discard evidence. Stated here so the divergence is a decision.
    const rows = [
      ...singles("S1", 1, 2),
      row("D1", "doubles", [2, 3], opponents(2), { playedOn: null }),
      row("D1", "doubles", [2, 3], opponents(2), { playedOn: null }),
    ];

    const result = predictedLineup({ rows, rosterPlayerIds: [1, 2, 3], ratings: ratingsFor({}) });
    expect(result.slots.find((s) => s.slot === "D1")!.support).toBe(2);
  });
});

describe("predictedLineup — determinism", () => {
  // The property every other function in derive.ts carries, and the only thing that catches a tie
  // resolving to input order rather than to a named tie-breaker.
  it("produces an identical result however the rows and roster are ordered", () => {
    const rows = [
      ...singles("S1", 1, 3),
      ...singles("S1", 2, 3), // a genuine tie on singles count between 1 and 2
      ...doubles("D1", [3, 4], 4),
      ...doubles("D1", [5, 6], 4), // a genuine tie on pair count, same modal slot
      ...doubles("D2", [5, 6], 2),
      ...doubles("D3", [7, 8], 2),
    ];
    const roster = [1, 2, 3, 4, 5, 6, 7, 8];
    // Every player identically rated, so the rating tie-breaker cannot resolve anything either and
    // only the final playerId tie-breaker is left.
    const flat = ratingsFor(Object.fromEntries(roster.map((id) => [id, { ntrp: 3.5 }])));

    const forward = predictedLineup({ rows, rosterPlayerIds: roster, ratings: flat });
    const reversed = predictedLineup({
      rows: [...rows].reverse(),
      rosterPlayerIds: [...roster].reverse(),
      ratings: [...flat].reverse(),
    });

    expect(reversed).toEqual(forward);
  });
});
