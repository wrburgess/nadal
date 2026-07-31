import { describe, expect, it } from "vitest";
import {
  dataGaps,
  headToHead,
  partnerFrequency,
  ratingTrajectory,
  slotTendencies,
  teamMatchRecord,
  windowedRecord,
} from "../src/query/derive.js";
import type {
  CourtMatchParticipant,
  CourtMatchRow,
  RatingObservationRow,
  TeamMatchRow,
} from "../src/query/types.js";

// Hand-built inputs throughout, deliberately carrying shapes no captured fixture contains — the
// awkward inputs are the whole point (docs/findings.md: PR #31 took five review rounds because
// "the rule was right and the input set it was applied to was wrong").

let nextCourtMatchId = 1;
function courtMatch(overrides: Partial<CourtMatchRow> & { participants: CourtMatchParticipant[] }): CourtMatchRow {
  return {
    id: nextCourtMatchId++,
    slot: "S1",
    discipline: "singles",
    winnerSide: "home",
    playedOn: "2026-06-01",
    ...overrides,
  };
}

const PLAYER = 1;

describe("windowedRecord", () => {
  it("counts a win: winnerSide equals the player's own side", () => {
    const rows = [courtMatch({ winnerSide: "home", participants: [{ playerId: PLAYER, side: "home" }] })];
    expect(windowedRecord(rows, PLAYER)).toEqual({ wins: 1, losses: 0, undecided: 0, excludedUndated: 0 });
  });

  it("counts a loss: winnerSide is the OTHER side from the player's own", () => {
    const rows = [courtMatch({ winnerSide: "visiting", participants: [{ playerId: PLAYER, side: "home" }] })];
    expect(windowedRecord(rows, PLAYER)).toEqual({ wins: 0, losses: 1, undecided: 0, excludedUndated: 0 });
  });

  it("correctness rule 3: winnerSide === null is undecided, never a loss", () => {
    const rows = [courtMatch({ winnerSide: null, participants: [{ playerId: PLAYER, side: "home" }] })];
    expect(windowedRecord(rows, PLAYER)).toEqual({ wins: 0, losses: 0, undecided: 1, excludedUndated: 0 });
  });

  it("correctness rule 5: playedOn === null is excluded from the window AND counted in excludedUndated, never silently dropped", () => {
    const rows = [
      courtMatch({ playedOn: null, winnerSide: "home", participants: [{ playerId: PLAYER, side: "home" }] }),
    ];
    expect(windowedRecord(rows, PLAYER, { since: "2026-01-01" })).toEqual({
      wins: 0,
      losses: 0,
      undecided: 0,
      excludedUndated: 1,
    });
  });

  describe("correctness rule 5: the window boundary is inclusive, tested exactly at it", () => {
    it("a match played exactly ON `since` counts", () => {
      const rows = [
        courtMatch({ playedOn: "2026-06-15", winnerSide: "home", participants: [{ playerId: PLAYER, side: "home" }] }),
      ];
      expect(windowedRecord(rows, PLAYER, { since: "2026-06-15" }).wins).toBe(1);
    });

    it("a match played one day BEFORE `since` is excluded entirely — not undecided, not excludedUndated", () => {
      const rows = [
        courtMatch({ playedOn: "2026-06-14", winnerSide: "home", participants: [{ playerId: PLAYER, side: "home" }] }),
      ];
      expect(windowedRecord(rows, PLAYER, { since: "2026-06-15" })).toEqual({
        wins: 0,
        losses: 0,
        undecided: 0,
        excludedUndated: 0,
      });
    });

    it("a match played one day AFTER `since` counts", () => {
      const rows = [
        courtMatch({ playedOn: "2026-06-16", winnerSide: "home", participants: [{ playerId: PLAYER, side: "home" }] }),
      ];
      expect(windowedRecord(rows, PLAYER, { since: "2026-06-15" }).wins).toBe(1);
    });
  });

  it("discipline filter isolates singles from doubles", () => {
    const rows = [
      courtMatch({ discipline: "singles", winnerSide: "home", participants: [{ playerId: PLAYER, side: "home" }] }),
      courtMatch({ discipline: "doubles", winnerSide: "visiting", participants: [{ playerId: PLAYER, side: "home" }] }),
    ];
    expect(windowedRecord(rows, PLAYER, { discipline: "singles" })).toEqual({
      wins: 1,
      losses: 0,
      undecided: 0,
      excludedUndated: 0,
    });
    expect(windowedRecord(rows, PLAYER, { discipline: "doubles" })).toEqual({
      wins: 0,
      losses: 1,
      undecided: 0,
      excludedUndated: 0,
    });
  });

  it("correctness rule 4: a doubles match counts ONCE for the player, not once per participant", () => {
    const rows = [
      courtMatch({
        discipline: "doubles",
        winnerSide: "home",
        participants: [
          { playerId: PLAYER, side: "home" },
          { playerId: 2, side: "home" },
          { playerId: 3, side: "visiting" },
          { playerId: 4, side: "visiting" },
        ],
      }),
    ];
    expect(windowedRecord(rows, PLAYER)).toEqual({ wins: 1, losses: 0, undecided: 0, excludedUndated: 0 });
  });

  it("a player appearing on BOTH sides across two pulls of the same real match is counted consistently per row", () => {
    // Perspective A: pulled from the player's own team's page. Perspective B: the same real match,
    // pulled from the opponent's page — every column flips together (docs/findings.md, #15), which
    // can leave the player recorded on "visiting" in one row and "home" in the other. Both rows
    // must still report the SAME real-world outcome for the player.
    const perspectiveA = courtMatch({
      winnerSide: "home",
      participants: [{ playerId: PLAYER, side: "home" }, { playerId: 2, side: "visiting" }],
    });
    const perspectiveB = courtMatch({
      winnerSide: "visiting",
      participants: [{ playerId: PLAYER, side: "visiting" }, { playerId: 2, side: "home" }],
    });
    expect(windowedRecord([perspectiveA], PLAYER)).toEqual(windowedRecord([perspectiveB], PLAYER));
    expect(windowedRecord([perspectiveA], PLAYER).wins).toBe(1);
  });

  it("an empty input returns all zeros", () => {
    expect(windowedRecord([], PLAYER)).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 0 });
  });

  it("a row the player did not participate in is ignored entirely", () => {
    const rows = [courtMatch({ winnerSide: "home", participants: [{ playerId: 99, side: "home" }] })];
    expect(windowedRecord(rows, PLAYER)).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 0 });
  });
});

describe("windowedRecord — perspective invariance (correctness rule 1)", () => {
  it("the same court match, described from EITHER team's pull perspective, yields an identical record for the same player", () => {
    // docs/findings.md, #15: "home"/"visiting" are the perspective of whichever team's page was
    // pulled, not real home/away. A dossier built after pulling BOTH teams must not read them as
    // venue — the derived record has to come out identical either way.
    const pulledFromOwnTeam = courtMatch({
      slot: "D1",
      discipline: "doubles",
      winnerSide: "visiting",
      participants: [
        { playerId: PLAYER, side: "home" },
        { playerId: 2, side: "home" },
        { playerId: 3, side: "visiting" },
        { playerId: 4, side: "visiting" },
      ],
    });
    const pulledFromOpponentTeam = courtMatch({
      slot: "D1",
      discipline: "doubles",
      winnerSide: "home", // flipped, along with every side below, but self-consistent
      participants: [
        { playerId: PLAYER, side: "visiting" },
        { playerId: 2, side: "visiting" },
        { playerId: 3, side: "home" },
        { playerId: 4, side: "home" },
      ],
    });

    const recordA = windowedRecord([pulledFromOwnTeam], PLAYER);
    const recordB = windowedRecord([pulledFromOpponentTeam], PLAYER);
    expect(recordA).toEqual(recordB);
    expect(recordA).toEqual({ wins: 0, losses: 1, undecided: 0, excludedUndated: 0 });
  });
});

describe("slotTendencies", () => {
  it("counts per slot, descending", () => {
    const rows = [
      courtMatch({ slot: "S1", participants: [{ playerId: PLAYER, side: "home" }] }),
      courtMatch({ slot: "D1", participants: [{ playerId: PLAYER, side: "home" }] }),
      courtMatch({ slot: "S1", participants: [{ playerId: PLAYER, side: "home" }] }),
    ];
    expect(slotTendencies(rows, PLAYER)).toEqual([
      { slot: "S1", count: 2 },
      { slot: "D1", count: 1 },
    ]);
  });

  it("breaks ties deterministically by slot name (ascending)", () => {
    const rows = [
      courtMatch({ slot: "D2", participants: [{ playerId: PLAYER, side: "home" }] }),
      courtMatch({ slot: "D1", participants: [{ playerId: PLAYER, side: "home" }] }),
    ];
    expect(slotTendencies(rows, PLAYER)).toEqual([
      { slot: "D1", count: 1 },
      { slot: "D2", count: 1 },
    ]);
  });

  it("an unenumerated slot value is carried through rather than dropped", () => {
    const rows = [courtMatch({ slot: "D4", participants: [{ playerId: PLAYER, side: "home" }] })];
    expect(slotTendencies(rows, PLAYER)).toEqual([{ slot: "D4", count: 1 }]);
  });

  it("an empty input returns an empty array", () => {
    expect(slotTendencies([], PLAYER)).toEqual([]);
  });
});

describe("partnerFrequency", () => {
  it("counts a normal two-a-side doubles partner", () => {
    const rows = [
      courtMatch({
        discipline: "doubles",
        participants: [{ playerId: PLAYER, side: "home" }, { playerId: 2, side: "home" }, { playerId: 3, side: "visiting" }, { playerId: 4, side: "visiting" }],
      }),
    ];
    expect(partnerFrequency(rows, PLAYER)).toEqual([{ partnerId: 2, count: 1 }]);
  });

  it("correctness rule 2: THREE on a side (a superseded participant never deleted) counts every other participant as a partner, no [0]/[1] indexing", () => {
    const rows = [
      courtMatch({
        discipline: "doubles",
        participants: [
          { playerId: PLAYER, side: "home" },
          { playerId: 2, side: "home" },
          { playerId: 5, side: "home" }, // the superseded participant re-pull left attached
          { playerId: 3, side: "visiting" },
        ],
      }),
    ];
    expect(partnerFrequency(rows, PLAYER).sort((a, b) => a.partnerId - b.partnerId)).toEqual([
      { partnerId: 2, count: 1 },
      { partnerId: 5, count: 1 },
    ]);
  });

  it("correctness rule 2: ONE on a side (incomplete partner data) yields no partner and does not crash", () => {
    const rows = [
      courtMatch({ discipline: "doubles", participants: [{ playerId: PLAYER, side: "home" }, { playerId: 3, side: "visiting" }] }),
    ];
    expect(partnerFrequency(rows, PLAYER)).toEqual([]);
  });

  it("a singles match contributes nothing", () => {
    const rows = [
      courtMatch({ discipline: "singles", participants: [{ playerId: PLAYER, side: "home" }, { playerId: 3, side: "visiting" }] }),
    ];
    expect(partnerFrequency(rows, PLAYER)).toEqual([]);
  });

  it("the player is never their own partner", () => {
    const rows = [
      courtMatch({
        discipline: "doubles",
        participants: [{ playerId: PLAYER, side: "home" }, { playerId: 3, side: "visiting" }, { playerId: 4, side: "visiting" }],
      }),
    ];
    expect(partnerFrequency(rows, PLAYER)).toEqual([]);
  });
});

describe("headToHead", () => {
  const OPPONENT = 3;

  it("a prior meeting won", () => {
    const rows = [courtMatch({ winnerSide: "home", participants: [{ playerId: PLAYER, side: "home" }, { playerId: OPPONENT, side: "visiting" }] })];
    expect(headToHead(rows, PLAYER, [OPPONENT])).toEqual([{ opponentId: OPPONENT, wins: 1, losses: 0, undecided: 0, matches: 1 }]);
  });

  it("a prior meeting lost", () => {
    const rows = [courtMatch({ winnerSide: "visiting", participants: [{ playerId: PLAYER, side: "home" }, { playerId: OPPONENT, side: "visiting" }] })];
    expect(headToHead(rows, PLAYER, [OPPONENT])).toEqual([{ opponentId: OPPONENT, wins: 0, losses: 1, undecided: 0, matches: 1 }]);
  });

  it("a prior meeting undecided", () => {
    const rows = [courtMatch({ winnerSide: null, participants: [{ playerId: PLAYER, side: "home" }, { playerId: OPPONENT, side: "visiting" }] })];
    expect(headToHead(rows, PLAYER, [OPPONENT])).toEqual([{ opponentId: OPPONENT, wins: 0, losses: 0, undecided: 1, matches: 1 }]);
  });

  it("an opponent never met returns an explicit zero row rather than being absent", () => {
    expect(headToHead([], PLAYER, [OPPONENT])).toEqual([{ opponentId: OPPONENT, wins: 0, losses: 0, undecided: 0, matches: 0 }]);
  });

  it("the same opponent met twice aggregates", () => {
    const rows = [
      courtMatch({ winnerSide: "home", participants: [{ playerId: PLAYER, side: "home" }, { playerId: OPPONENT, side: "visiting" }] }),
      courtMatch({ winnerSide: "visiting", participants: [{ playerId: PLAYER, side: "home" }, { playerId: OPPONENT, side: "visiting" }] }),
    ];
    expect(headToHead(rows, PLAYER, [OPPONENT])).toEqual([{ opponentId: OPPONENT, wins: 1, losses: 1, undecided: 0, matches: 2 }]);
  });

  it("a doubles match where the requested opponent is actually the player's PARTNER (same side) is not counted as a meeting", () => {
    const rows = [
      courtMatch({
        discipline: "doubles",
        winnerSide: "home",
        participants: [{ playerId: PLAYER, side: "home" }, { playerId: OPPONENT, side: "home" }, { playerId: 9, side: "visiting" }],
      }),
    ];
    expect(headToHead(rows, PLAYER, [OPPONENT])).toEqual([{ opponentId: OPPONENT, wins: 0, losses: 0, undecided: 0, matches: 0 }]);
  });
});

describe("ratingTrajectory", () => {
  function obs(overrides: Partial<RatingObservationRow>): RatingObservationRow {
    return { id: 1, source: "ntrp", value: 4, ratingType: null, observedOn: "2026-01-01", ...overrides };
  }

  it("orders multiple observations per source by observedOn, surfacing the latest", () => {
    const observations = [
      obs({ id: 1, value: 3.5, observedOn: "2026-01-01" }),
      obs({ id: 2, value: 4.0, observedOn: "2026-06-01" }),
      obs({ id: 3, value: 3.8, observedOn: "2026-03-01" }),
    ];
    const result = ratingTrajectory(observations);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("ntrp");
    expect(result[0]!.latest).toEqual({ id: 2, value: 4.0, ratingType: null, observedOn: "2026-06-01" });
    expect(result[0]!.series.map((p) => p.observedOn)).toEqual(["2026-01-01", "2026-03-01", "2026-06-01"]);
  });

  it("two observations sharing a date are broken deterministically (by id, independent of input array order)", () => {
    const highIdFirst = [obs({ id: 9, value: 4.5, observedOn: "2026-05-01" }), obs({ id: 2, value: 4.0, observedOn: "2026-05-01" })];
    const lowIdFirst = [obs({ id: 2, value: 4.0, observedOn: "2026-05-01" }), obs({ id: 9, value: 4.5, observedOn: "2026-05-01" })];
    expect(ratingTrajectory(highIdFirst)[0]!.latest).toEqual(ratingTrajectory(lowIdFirst)[0]!.latest);
    expect(ratingTrajectory(highIdFirst)[0]!.latest.id).toBe(9);
  });

  it("a source with no observations is absent from the result without throwing", () => {
    const result = ratingTrajectory([obs({ source: "ntrp" })]);
    expect(result.find((r) => r.source === "wtn_singles")).toBeUndefined();
    expect(() => ratingTrajectory([])).not.toThrow();
    expect(ratingTrajectory([])).toEqual([]);
  });

  it("all four sources are exercised independently, with ratingType preserved for NTRP", () => {
    const observations = [
      obs({ id: 1, source: "ntrp", value: 4.0, ratingType: "C", observedOn: "2026-01-01" }),
      obs({ id: 2, source: "wtn_singles", value: 21.5, ratingType: null, observedOn: "2026-01-01" }),
      obs({ id: 3, source: "wtn_doubles", value: 19.2, ratingType: null, observedOn: "2026-01-01" }),
      obs({ id: 4, source: "tr_dynamic", value: 4.1, ratingType: null, observedOn: "2026-01-01" }),
    ];
    const result = ratingTrajectory(observations);
    const bySource = new Map(result.map((r) => [r.source, r]));
    expect(bySource.get("ntrp")!.latest.ratingType).toBe("C");
    expect(bySource.get("wtn_singles")!.latest.value).toBe(21.5);
    expect(bySource.get("wtn_doubles")!.latest.value).toBe(19.2);
    expect(bySource.get("tr_dynamic")!.latest.value).toBe(4.1);
    expect(result).toHaveLength(4);
  });
});

describe("dataGaps", () => {
  it("distinguishes 'no writer' from a populated-but-empty query — the whole point", () => {
    const result = dataGaps({
      events: { count: 0, hasWriter: false },
      tournamentResults: { count: 0, hasWriter: true },
    });
    expect(result.events).toBe("not-collected");
    expect(result.tournamentResults).toBe("empty");
    expect(result.events).not.toBe(result.tournamentResults);
  });

  it("reports has-data when a writer exists and the query returned rows", () => {
    expect(dataGaps({ courtMatches: { count: 5, hasWriter: true } })).toEqual({ courtMatches: "has-data" });
  });

  it("events, availability and captain_notes report not-collected (no writer anywhere in the codebase)", () => {
    const result = dataGaps({
      events: { count: 0, hasWriter: false },
      availability: { count: 0, hasWriter: false },
      captainNotes: { count: 0, hasWriter: false },
    });
    expect(result).toEqual({ events: "not-collected", availability: "not-collected", captainNotes: "not-collected" });
  });
});

describe("teamMatchRecord", () => {
  let nextTeamMatchId = 1;
  function teamMatchRow(overrides: Partial<TeamMatchRow>): TeamMatchRow {
    return {
      id: nextTeamMatchId++,
      homeTeamId: 10,
      visitingTeamId: 20,
      homeCourtsWon: 3,
      visitingCourtsWon: 2,
      playedOn: "2026-06-01",
      ...overrides,
    };
  }

  it("a win from the home-labeled side", () => {
    const rows = [teamMatchRow({ homeTeamId: 10, visitingTeamId: 20, homeCourtsWon: 3, visitingCourtsWon: 2 })];
    expect(teamMatchRecord(rows, 10)).toEqual({ wins: 1, losses: 0, undecided: 0, excludedUndated: 0 });
  });

  it("a loss from the visiting-labeled side", () => {
    const rows = [teamMatchRow({ homeTeamId: 20, visitingTeamId: 10, homeCourtsWon: 3, visitingCourtsWon: 2 })];
    expect(teamMatchRecord(rows, 10)).toEqual({ wins: 0, losses: 1, undecided: 0, excludedUndated: 0 });
  });

  it("perspective invariance: the identical real result, pulled from the OTHER team's page (labels flipped), yields the same record for team 10", () => {
    const fromTeam10sPage = teamMatchRow({ homeTeamId: 10, visitingTeamId: 20, homeCourtsWon: 3, visitingCourtsWon: 2 });
    const fromTeam20sPage = teamMatchRow({ homeTeamId: 20, visitingTeamId: 10, homeCourtsWon: 2, visitingCourtsWon: 3 });
    expect(teamMatchRecord([fromTeam10sPage], 10)).toEqual(teamMatchRecord([fromTeam20sPage], 10));
    expect(teamMatchRecord([fromTeam10sPage], 10).wins).toBe(1);
  });

  it("a tied court count is undecided, not a loss", () => {
    const rows = [teamMatchRow({ homeCourtsWon: 2, visitingCourtsWon: 2 })];
    expect(teamMatchRecord(rows, 10)).toEqual({ wins: 0, losses: 0, undecided: 1, excludedUndated: 0 });
  });

  it("a null court count (unplayed fixture) is undecided, not a loss", () => {
    const rows = [teamMatchRow({ homeCourtsWon: null, visitingCourtsWon: null })];
    expect(teamMatchRecord(rows, 10)).toEqual({ wins: 0, losses: 0, undecided: 1, excludedUndated: 0 });
  });

  it("playedOn === null is excluded and counted in excludedUndated", () => {
    const rows = [teamMatchRow({ playedOn: null })];
    expect(teamMatchRecord(rows, 10, { since: "2026-01-01" })).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 1 });
  });

  it("the window boundary is inclusive at exactly `since`", () => {
    const rows = [teamMatchRow({ playedOn: "2026-06-15" })];
    expect(teamMatchRecord(rows, 10, { since: "2026-06-15" }).wins).toBe(1);
  });

  it("a row where the team is neither home nor visiting is ignored", () => {
    const rows = [teamMatchRow({ homeTeamId: 30, visitingTeamId: 40 })];
    expect(teamMatchRecord(rows, 10)).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 0 });
  });
});
