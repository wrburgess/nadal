import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { parseMatchHistory } from "../src/parsers/tennisrecord/match-history.js";
import { ParseError } from "../src/parsers/types.js";

const fixture = loadFixture("tennisrecord/match-history");
const matches = parseMatchHistory(fixture.html, fixture.source);

describe("parseMatchHistory", () => {
  it("parses a doubles court in full", () => {
    expect(matches[0]).toEqual({
      playedOn: "2025-11-15",
      leagueContext: "Adult 18+ 4.0",
      teamName: "Norbury, Nova",
      teamSection: "Missouri Valley",
      opponentTeamName: "Sable, Sawyer",
      opponentTeamSection: "Missouri Valley",
      slot: "D2",
      discipline: "doubles",
      partner: { name: "Nova Norbury", dynamicRating: 3.55 },
      opponents: [
        { name: "Sawyer Sable", dynamicRating: 3.69 },
        { name: "Quinn Quillon", dynamicRating: 3.41 },
      ],
      result: "W",
      sets: [
        { games: [7, 6], matchTiebreak: false },
        { games: [6, 3], matchTiebreak: false },
      ],
      defaulted: false,
      matchRating: 3.73,
      selfRated: false,
      resultingRating: 3.72,
      sourceMatchId: "20336",
    });
  });

  it("parses a singles court with no partner", () => {
    const singles = matches[10];

    expect(singles?.slot).toBe("S1");
    expect(singles?.discipline).toBe("singles");
    expect(singles?.partner).toBeNull();
    expect(singles?.opponents).toEqual([{ name: "Kendry Kimberley", dynamicRating: 3.96 }]);
  });

  it("marks a third-set match tiebreak rather than reading it as a 1-game set", () => {
    // § Domain model names match-tiebreak notation explicitly under CourtMatch. `1-0` is not a
    // set anyone can win, so reading it as one would put a 1-game "set" into every windowed
    // record and games-won calculation downstream.
    const tiebreak = matches[4];

    expect(tiebreak?.sets).toEqual([
      { games: [4, 6], matchTiebreak: false },
      { games: [7, 5], matchTiebreak: false },
      { games: [1, 0], matchTiebreak: true },
    ]);
  });

  it("reports an unrated player as null, never as zero", () => {
    // TennisRecord prints `(-----)` for a player with no dynamic rating yet. A 0 here would drag
    // every average-opponent-rating in a dossier downward while looking like real data.
    const unrated = matches[2];

    expect(unrated?.partner).toEqual({ name: "Orin Oakhurst", dynamicRating: null });
  });

  it("reports a self-rated match as selfRated with no numeric match rating", () => {
    const selfRated = matches[1];

    expect(selfRated?.selfRated).toBe(true);
    expect(selfRated?.matchRating).toBeNull();
    expect(selfRated?.resultingRating).toBe(3.74);
  });

  it("parses a defaulted court as won with no opponents", () => {
    const defaulted = matches[2];

    expect(defaulted?.defaulted).toBe(true);
    expect(defaulted?.opponents).toEqual([]);
    expect(defaulted?.result).toBe("W");
    expect(defaulted?.matchRating).toBeNull();
    expect(defaulted?.resultingRating).toBeNull();
  });

  it("recovers the opponent team, which only the mobile rendering carries", () => {
    // The desktop table has no opponent-team column at all; the mobile block does. Without it a
    // dossier can say who a player faced but not which team they were facing.
    expect(matches[2]?.opponentTeamName).toBe("Tavistock Teale");
    expect(matches[13]?.opponentTeamName).toBe("Jarrow, Juniper");
  });

  it("returns each match once, not once per responsive rendering", () => {
    // The page renders every match twice — `div.large` for desktop, `div.small` for mobile. A
    // parser that selects on row shape returns 28 matches for 14 played, and every field
    // assertion above still passes. Only the count and the absence of duplicates catch it.
    expect(matches).toHaveLength(14);

    const keys = matches.map(
      (m) => `${m.playedOn}|${m.slot}|${m.opponents.map((o) => o.name).join(",")}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns an empty list for a season with no matches, without throwing", () => {
    // The empty page still ships the table and its header row, so "no matches played" and "the
    // results table is gone" are genuinely different pages — and must stay different outcomes.
    const empty = loadFixture("tennisrecord/match-history-empty");

    expect(parseMatchHistory(empty.html, empty.source)).toEqual([]);
  });

  it("throws when the results table is missing, rather than reporting no matches", () => {
    const withoutTable = fixture.html.replace(/<div class="large">/, '<div class="gone">');

    expect(() => parseMatchHistory(withoutTable, fixture.source)).toThrow(ParseError);
  });

  it("throws when the two renderings disagree about how many matches there were", () => {
    // Opponent teams are correlated by position across the two renderings. If they ever fall out
    // of step, every opponent team after the divergence is attributed to the wrong match — a
    // silently wrong dossier, which is worse than a loud failure.
    const truncated = fixture.html.replace(/<div class="container496">/, '<div class="dropped">');

    expect(() => parseMatchHistory(truncated, fixture.source)).toThrow(ParseError);
  });
});
