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
        { matchWinnerGames: 7, matchLoserGames: 6, matchTiebreak: false },
        { matchWinnerGames: 6, matchLoserGames: 3, matchTiebreak: false },
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
      { matchWinnerGames: 4, matchLoserGames: 6, matchTiebreak: false },
      { matchWinnerGames: 7, matchLoserGames: 5, matchTiebreak: false },
      { matchWinnerGames: 1, matchLoserGames: 0, matchTiebreak: true },
    ]);
  });

  it("does not mistake a lone short set for a match tiebreak", () => {
    // `1-0` identifies a match tiebreak only because a tiebreak replaces the DECIDING set. In
    // first position it is something else — a retirement, an incomplete set — and flagging it
    // would silently remove a real (if short) set from every games-won ratio downstream.
    const shortened = fixture.html.replace(">4-6<br>7-5<br>1-0<", ">1-0<");
    const parsed = parseMatchHistory(shortened, fixture.source);

    expect(parsed[4]?.sets).toEqual([{ matchWinnerGames: 1, matchLoserGames: 0, matchTiebreak: false }]);
  });

  it("classifies the second real 1-0 row in the fixture, not just the mutated one", () => {
    // Codex flagged that the tiebreak rule was only exercised through a mutation. The fixture
    // carries a second, differently-shaped `1-0` row (`6-7 3-1 1-0`, an unusual middle set), so
    // the rule is asserted against real markup here rather than only against a constructed case.
    expect(matches[11]?.sets).toEqual([
      { matchWinnerGames: 6, matchLoserGames: 7, matchTiebreak: false },
      { matchWinnerGames: 3, matchLoserGames: 1, matchTiebreak: false },
      { matchWinnerGames: 1, matchLoserGames: 0, matchTiebreak: true },
    ]);
  });

  it("orients set scores to the MATCH winner, including the set that winner lost", () => {
    // Two claims, and the second is where a plausible-looking shortcut goes wrong.
    //
    // A straight-sets loss prints the opponent winning both: this match was lost 3-6, 3-6 and
    // reads `6-3 6-3`, so the leading number is the match winner's, not the profiled player's.
    const straightSetsLoss = matches[5];
    expect(straightSetsLoss?.result).toBe("L");
    expect(
      straightSetsLoss?.sets.every((s) => s.matchWinnerGames > s.matchLoserGames),
    ).toBe(true);

    // But "match winner" is NOT "set winner": in a three-setter the match winner drops one. This
    // loss reads `4-6 7-5 1-0` — the opponent lost the first set on the way to winning. Asserting
    // matchWinnerGames > matchLoserGames for every set would be false here, which is exactly what
    // makes the shorter field names `winnerGames`/`loserGames` wrong.
    // (Provenance: Codex adversarial review round 2 on PR #26.)
    const threeSetLoss = matches[4];
    expect(threeSetLoss?.result).toBe("L");
    expect(threeSetLoss?.sets[0]).toEqual({
      matchWinnerGames: 4,
      matchLoserGames: 6,
      matchTiebreak: false,
    });
  });

  it("throws when a played court has no score at all", () => {
    // An emptied Result cell previously yielded a W/L record with `sets: []` — a match that reads
    // as played and scoreless, indistinguishable downstream from one that genuinely has no score.
    const scoreless = fixture.html.replace(
      '<a class="link" href="/adult/matchresults.aspx?year=2026&mid=20336">7-6<br>6-3</a>',
      '<a class="link" href="/adult/matchresults.aspx?year=2026&mid=20336"></a>',
    );

    expect(() => parseMatchHistory(scoreless, fixture.source)).toThrow(ParseError);
  });

  it("throws when the result link no longer carries a match id", () => {
    // `mid` is the court-level idempotency key (spec § Ingestion: re-run anytime, nothing
    // duplicates). A record without it looks usable and cannot be reconciled on the next pull.
    const noId = fixture.html.replace(/&mid=\d+/g, "");

    expect(() => parseMatchHistory(noId, fixture.source)).toThrow(ParseError);
  });

  it("throws on an unrecognised score component instead of dropping it", () => {
    // A changed score format would otherwise yield an empty or half-length set list on a record
    // that still reports its W/L: a plausible-looking match with the scores quietly removed.
    const mangled = fixture.html.replace(">7-6<br>6-3<", ">7-6<br>ret.<");

    expect(() => parseMatchHistory(mangled, fixture.source)).toThrow(ParseError);
  });

  it("throws when a doubles court is missing a participant", () => {
    // An under-populated court silently removes people from partner-frequency and prior-meeting
    // counts — the two derived fields a dossier leans on hardest.
    const missing = fixture.html.replace(
      "<a class='link' href='/adult/matchhistory.aspx?playername=Quinn Quillon&year=2025'>Quinn Quillon</a><br>(3.41)",
      "",
    );

    expect(() => parseMatchHistory(missing, fixture.source)).toThrow(ParseError);
  });

  it("throws on a rating with no player before it", () => {
    // The name/rating pairing depends on the cell's alternating shape. If a name goes missing,
    // continuing would attach that rating to the previous player — wrong data that looks right.
    const orphaned = fixture.html.replace(
      "<a class='link' href='/adult/matchhistory.aspx?playername=Sawyer Sable&year=2025'>Sawyer Sable</a><br>",
      "",
    );

    expect(() => parseMatchHistory(orphaned, fixture.source)).toThrow(ParseError);
  });

  it("throws when a mobile block stops naming the opponent team", () => {
    // Count and date correlation both still pass here — only the opponent link is gone. Without
    // this check the record is accepted with no opponent team while every other field looks
    // correct, which is scouting history that silently forgets who each match was against.
    const unlinked = fixture.html.replace(
      "<a Class='link' href='/adult/teamprofile.aspx?teamname=Sable%2c Sawyer&year=2026'>",
      "<span>",
    );

    expect(() => parseMatchHistory(unlinked, fixture.source)).toThrow(ParseError);
  });

  it("throws on an unreadable W/L cell rather than recording a loss", () => {
    // "Anything that isn't a W is an L" is the tempting one-liner, and it converts a renamed or
    // emptied cell into a silent defeat that still balances and still renders.
    const blanked = fixture.html.replace(
      '<td style="text-align:center; vertical-align: top;">W</td>',
      '<td style="text-align:center; vertical-align: top;"></td>',
    );

    expect(() => parseMatchHistory(blanked, fixture.source)).toThrow(ParseError);
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
