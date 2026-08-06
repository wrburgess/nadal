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

describe("parseMatchHistory — blank source match id", () => {
  it("throws on an empty mid, not only a missing one", () => {
    // `hrefParam` returns "" for `mid=`, and a null-only check let an EMPTY idempotency key
    // through — as unusable for reconciliation as a missing one, and contradicting the comment
    // sitting directly above the guard. The earlier test removed the parameter entirely, so it
    // passed without ever exercising this case.
    // (Provenance: Codex adversarial review round 7 on PR #26.)
    const blankId = fixture.html.replace(/&mid=\d+/g, "&mid=");

    expect(blankId).not.toBe(fixture.html);
    expect(() => parseMatchHistory(blankId, fixture.source)).toThrow(ParseError);
  });
});

/**
 * A tournament match, in both renderings, transcribed VERBATIM from an archived 2025 page
 * (`raw/tennisrecord/…playername=…&year=2025…`, a page that also carries 26 league matches).
 * Every element, class, attribute and `<br>` is byte-identical to what the server sent; the only
 * edit is the opponent's display name and `playername=` value, replaced with a stand-in that
 * already appears in this fixture. No real identity enters the repository, and no NEW stand-in is
 * invented — that would break the "same person maps to the same stand-in across every fixture"
 * invariant in `test/fixtures/README.md`, whose substitution map lives outside this repo.
 *
 * Why transcribed rather than captured: committing an archived page as a fixture requires that
 * out-of-repo map. Two verifications stand in for the one it would have bought — this real markup,
 * and a sweep of the guard over all 281 archived pages recorded in the PR.
 *
 * Four things about this row matter, and each is separately fatal to the parser as it stood:
 * it links NO teams, its court slot is `16` (not `S1`/`D2`), its result cell has no `mid=` anchor
 * at all, and its mobile block has no `<th>` — the element the date correlation reads.
 */
const TOURNAMENT_DESKTOP_ROW = `
                        <tr style='border-bottom:1px solid #ddd;'>
                            <td style="text-align:left; vertical-align: top;">05/24/2025</td>

                                <td style="text-align:left; vertical-align: top;">Tournament<br>S40NM3.5s</td>
                                <td style="text-align:left; vertical-align: top; border-right:1px solid #ddd; max-width: 180px;">USTA MV 40+ NTRP & OPEN Section Tournament</td>


                            <td style="text-align:center; vertical-align: top;">16</td>

                            <td style="text-align:left; vertical-align: top;">

                            </td>


                                <td style="text-align:left; vertical-align: top; border-right:1px solid #ddd;">
                                    <a class='link' href='/adult/matchhistory.aspx?playername=Kendry Kimberley&year=2025'>Kendry Kimberley</a><br>(<span style="color:#00DD00">3.43</span>)

                                </td>

                                <td style="text-align:center; vertical-align: top;">L</td>

                                    <td style="text-align:center; vertical-align: top;">6-4<br>6-1</td>

                                <td style="text-align:right; vertical-align: top;"><span style="color:#00DD00">S</span></td>
                                <td style="text-align:right; vertical-align: top;"><span style="color:#00DD00">-----</span></td>

                        </tr>

`;

const TOURNAMENT_MOBILE_BLOCK = `
                <div class="container496">
                    <table style="margin:auto; width:100%; font-size:12px;">

                            <tr style="color:#7a7a7a; background-color:#f9f9f9;">
                                <td colspan="3" style="text-align:center;">
                                    USTA MV 40+ NTRP & OPEN Section Tournament
                                </td>
                            </tr>
                            <tr style="color:#7a7a7a; background-color:#f9f9f9; border-bottom:1px solid #ddd;">
                                <td style="text-align:left;" class="padding10">05/24/2025</td>
                                <td style="text-align:center;">16</td>
                                <td style="text-align:right;">Tournament<br>S40NM3.5s</td>
                            </tr>

                            <tr>
                                <td></td>

                                    <td style="text-align:center;">L</td>

                                <td></td>
                            </tr>


                        <tr style="border-bottom:1px solid #ddd;">
                            <td style="text-align:left;" class="padding10">

                            </td>


                                    <td style="text-align:center; vertical-align: top;">6-4<br>6-1</td>

                                <td style="text-align:right;" class="padding10">
                                    <a class='link' href='/adult/matchhistory.aspx?playername=Kendry Kimberley&year=2025'>Kendry Kimberley</a> (<span style="color:#00DD00">3.43</span>)

                                </td>

                        </tr>

                        <tr>

                                <td style="text-align:left;" class="padding10">Match: <span style="color:#00DD00">S</span></td>
                                <td></td>
                                <td style="text-align:right;" class="padding10">Rating: <span style="color:#00DD00">-----</span></td>

                        </tr>
                    </table>
                </div>

`;

/** The literal that opens every desktop data row in this fixture (the header row differs). */
const DESKTOP_ROW_OPEN = "<tr style='border-bottom:1px solid #ddd;'>";
const MOBILE_BLOCK_OPEN = '<div class="container496">';

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/**
 * Splice a tournament match into BOTH renderings at the same position, so the page stays the shape
 * a real one has. Inserting into only one rendering would trip the existing desktop/mobile count
 * check and the test would pass for the wrong reason.
 *
 * The helper VERIFIES its own splice — every anchor found, and exactly one match added to each
 * rendering. Without that, a fixture edit that moved an anchor would silently leave the page
 * unspliced, and every assertion below would pass against a page with no tournament in it.
 */
function withTournament(
  html: string,
  at: number | "end",
  parts: { row?: string; block?: string } = {},
): string {
  const row = parts.row ?? TOURNAMENT_DESKTOP_ROW;
  const block = parts.block ?? TOURNAMENT_MOBILE_BLOCK;
  const beforeRows = countOf(html, DESKTOP_ROW_OPEN);
  const beforeBlocks = countOf(html, MOBILE_BLOCK_OPEN);

  const insertAt = (source: string, offset: number, insertion: string): string =>
    source.slice(0, offset) + insertion + source.slice(offset);

  const nth = (source: string, needle: string, index: number): number => {
    let offset = -1;
    for (let seen = 0; seen <= index; seen += 1) {
      offset = source.indexOf(needle, offset + 1);
      if (offset === -1) throw new Error(`fixture has no occurrence ${index} of ${needle}`);
    }
    return offset;
  };

  let spliced: string;
  if (at === "end") {
    // Past the last desktop row means before the table that closes it; past the last mobile block
    // means after that block's own closing </div>.
    const lastRow = html.lastIndexOf(DESKTOP_ROW_OPEN);
    if (lastRow === -1) throw new Error("fixture has no desktop match rows to append after");
    const tableEnd = html.indexOf("</table>", lastRow);
    if (tableEnd === -1) throw new Error("fixture's desktop table is unterminated");
    spliced = insertAt(html, tableEnd, row);

    const lastBlock = spliced.lastIndexOf(MOBILE_BLOCK_OPEN);
    if (lastBlock === -1) throw new Error("fixture has no mobile match blocks to append after");
    const blockTable = spliced.indexOf("</table>", lastBlock);
    const blockEnd = spliced.indexOf("</div>", blockTable);
    if (blockTable === -1 || blockEnd === -1) throw new Error("fixture's last mobile block is unterminated");
    spliced = insertAt(spliced, blockEnd + "</div>".length, block);
  } else {
    spliced = insertAt(html, nth(html, DESKTOP_ROW_OPEN, at), row);
    spliced = insertAt(spliced, nth(spliced, MOBILE_BLOCK_OPEN, at), block);
  }

  if (
    countOf(spliced, DESKTOP_ROW_OPEN) !== beforeRows + 1 ||
    countOf(spliced, MOBILE_BLOCK_OPEN) !== beforeBlocks + 1
  ) {
    throw new Error("splice did not add exactly one match to each rendering");
  }
  return spliced;
}

describe("parseMatchHistory — a tournament match links no teams", () => {
  it("ingests the league matches on a page that also carries a tournament block", () => {
    // The regression this issue is about: ONE tournament entry aborted the parse of the whole page
    // and discarded every league match on it — 356 of them across 14 archived pages, costing ten
    // registered players their entire 2025 season. The assertion is equality with the unspliced
    // page, not a count: a fix that dropped or reshuffled a league match would still pass a count.
    const spliced = withTournament(fixture.html, 0);

    expect(parseMatchHistory(spliced, fixture.source)).toEqual(matches);
  });

  it("omits the tournament court rather than recording it with a null opponent", () => {
    // A tournament block links no opponent TEAM because there is none to link — so storing the
    // court would mean a record that silently belongs to no opponent, and (see the next test) one
    // with no idempotency key to reconcile it on the next pull.
    const parsed = parseMatchHistory(withTournament(fixture.html, 0), fixture.source);

    expect(parsed.some((m) => m.playedOn === "2025-05-24")).toBe(false);
    expect(parsed.every((m) => m.opponentTeamName !== "")).toBe(true);
    expect(parsed.every((m) => m.leagueContext !== "Tournament S40NM3.5s")).toBe(true);
  });

  it.each(["16", "R2", "C-F", "P1-F"])(
    "skips a tournament court on slot %s, which is not a court slot at all",
    (slot) => {
      // Every one of these is a real slot value from the archive, and none matches `S\\d*`/`D\\d*`.
      // The row also carries NO `mid=` anchor. Both are fatal in `parseRow`, so a page that parses
      // proves the row is skipped BEFORE that function — not that a guard was loosened to admit it.
      const row = TOURNAMENT_DESKTOP_ROW.replace(
        '<td style="text-align:center; vertical-align: top;">16</td>',
        `<td style="text-align:center; vertical-align: top;">${slot}</td>`,
      );
      const block = TOURNAMENT_MOBILE_BLOCK.replace(
        '<td style="text-align:center;">16</td>',
        `<td style="text-align:center;">${slot}</td>`,
      );

      expect(parseMatchHistory(withTournament(fixture.html, 0, { row, block }), fixture.source))
        .toEqual(matches);
    },
  );

  it.each([0, 7, "end" as const])("correlates correctly with the tournament at position %s", (at) => {
    // Position is what the two renderings are correlated by, so a guard that reads the wrong index
    // would corrupt every opponent team after the tournament rather than fail. First, middle and
    // last each exercise a different slice of that correlation.
    expect(parseMatchHistory(withTournament(fixture.html, at), fixture.source)).toEqual(matches);
  });

  it("throws when a block links no teams and the row is NOT marked a tournament", () => {
    // The whole point of the fix. `parseOpponentTeams`'s doc comment refuses to return a null
    // opponent because a mobile-markup change would then become scouting history that is silently
    // missing who each match was against. That refusal must survive: only a POSITIVE tournament
    // signal admits a teamless block, never the absence of team links.
    const row = TOURNAMENT_DESKTOP_ROW.replace(
      '<td style="text-align:left; vertical-align: top;">Tournament<br>S40NM3.5s</td>',
      `<td style="text-align:left; vertical-align: top;"><a class='link' href='/adult/league.aspx?flightname=4.0 Men&year=2026&s=6'>Adult 18+<br>4.0</a></td>`,
    );

    // Asserting the MESSAGE, not just the type: every mutation below throws a ParseError before
    // the fix exists too, so a bare `toThrow(ParseError)` would pass whether or not the guard is
    // there. The reason is the assertion.
    expect(() => parseMatchHistory(withTournament(fixture.html, 0, { row }), fixture.source))
      .toThrow(/links 0 teams, expected 2/);
  });

  it("throws when the row says tournament but the block still links two teams", () => {
    // The renderings disagree about what kind of match this is. Trusting the desktop column alone
    // would silently discard a real league match whose league cell had been renamed.
    const block = TOURNAMENT_MOBILE_BLOCK.replace(
      '<td colspan="3" style="text-align:center;">',
      `<td colspan="3" style="text-align:center;"><a Class='link' href='/adult/teamprofile.aspx?teamname=Norbury%2c Nova&year=2026'>Norbury, Nova<br>Missouri Valley</a><a Class='link' href='/adult/teamprofile.aspx?teamname=Sable%2c Sawyer&year=2026'>Sable, Sawyer<br>Missouri Valley</a>`,
    );

    expect(() => parseMatchHistory(withTournament(fixture.html, 0, { block }), fixture.source))
      .toThrow(/tournament but its mobile block links 2 teams/);
  });

  it("throws when the row says tournament but the block carries a league header row", () => {
    // A league block renders its header in `<th>`; a tournament block has none anywhere. If a page
    // ever produced both signals at once, the parser cannot tell which rendering to believe, and
    // guessing is what would put a real match's opponents on the wrong row.
    const block = TOURNAMENT_MOBILE_BLOCK.replace(
      '<td style="text-align:left;" class="padding10">05/24/2025</td>',
      '<th style="text-align:left;" class="padding10">05/24/2025</th>',
    );

    // The message matters here more than anywhere: without the `<th>` guard this same mutation
    // still throws — the header lookup would take the date off the wrong cell and fail on THAT.
    // Only asserting the reason makes the guard killable, and an unkillable guard is not a guard.
    expect(() => parseMatchHistory(withTournament(fixture.html, 0, { block }), fixture.source))
      .toThrow(/renders a league header row/);
  });

  it("throws when a tournament block's date disagrees with its desktop row", () => {
    // Tournament rows are correlated by date exactly like league rows — skipping the row must not
    // mean skipping the check that proves the two renderings are still in step. Without it, a
    // reordering would shift which rows are treated as tournaments and silently drop a league match.
    const block = TOURNAMENT_MOBILE_BLOCK.replace(
      '<td style="text-align:left;" class="padding10">05/24/2025</td>',
      '<td style="text-align:left;" class="padding10">06/24/2025</td>',
    );

    expect(() => parseMatchHistory(withTournament(fixture.html, 0, { block }), fixture.source))
      .toThrow(/renderings disagree at tournament row 0: desktop has 2025-05-24/);
  });

  it("throws when a tournament row's own date is unreadable", () => {
    // The other half of the same correlation. A desktop date that cannot be read is not "a row we
    // were dropping anyway" — it is the signal that the rendering changed, and the rows this
    // parser believes are tournaments are derived from that same table.
    const row = TOURNAMENT_DESKTOP_ROW.replace(
      '<td style="text-align:left; vertical-align: top;">05/24/2025</td>',
      '<td style="text-align:left; vertical-align: top;">not a date</td>',
    );

    expect(() => parseMatchHistory(withTournament(fixture.html, 0, { row }), fixture.source))
      .toThrow(/desktop has no readable date/);
  });

  it("returns an empty list for a season that was nothing but tournaments", () => {
    // The boundary where every row is skipped. "No league matches played" and "the results table
    // is gone" must stay different outcomes, exactly as they already do for a truly empty season.
    const empty = loadFixture("tennisrecord/match-history-empty");
    const withRow = empty.html.replace(
      /(<th style="text-align:right;">Rating<\/th>\s*<\/tr>)/,
      `$1${TOURNAMENT_DESKTOP_ROW}`,
    );
    const spliced = withRow.replace(
      /(<div class="small">)\s*(<\/div>)/,
      `$1${TOURNAMENT_MOBILE_BLOCK}$2`,
    );

    expect(spliced).not.toBe(empty.html);
    expect(countOf(spliced, MOBILE_BLOCK_OPEN)).toBe(1);
    expect(parseMatchHistory(spliced, empty.source)).toEqual([]);
  });
});

describe("parseMatchHistory — the two renderings are correlated by match id, not by date", () => {
  // Reviewer finding A (Codex, class A/high, at b45f860). Date equality cannot prove the two
  // renderings are in step: measured across the archive, 102 of 281 pages carry two league rows
  // sharing one date (218 such groups). On those, a reordered mobile rendering would attach each
  // match's opponent TEAM to the other match — the record still validates, cardinality still
  // passes, and the dossier is simply wrong about who was played.
  //
  // No combination of header fields is unique (date alone: 218 ambiguous groups; +slot: 67;
  // +league: 37), so "fail closed when ambiguous" would abort 50 real pages. The `mid=` match id
  // is the actual key: present on 3996 of 3996 league blocks, equal to its desktop row's on every
  // one, and unique per page when paired with the slot.

  /** Byte spans of each mobile block, so two can be exchanged whole. */
  const blockSpans = (html: string): Array<[number, number]> => {
    const spans: Array<[number, number]> = [];
    let from = 0;
    for (;;) {
      const start = html.indexOf(MOBILE_BLOCK_OPEN, from);
      if (start === -1) return spans;
      const table = html.indexOf("</table>", start);
      const end = html.indexOf("</div>", table) + "</div>".length;
      if (table === -1 || end < table) throw new Error("unterminated mobile block in fixture");
      spans.push([start, end]);
      from = end;
    }
  };

  const swapBlocks = (html: string, i: number, j: number): string => {
    const spans = blockSpans(html);
    const a = spans[i];
    const b = spans[j];
    if (a === undefined || b === undefined || a[0] >= b[0]) throw new Error("bad swap indices");
    return (
      html.slice(0, a[0]) +
      html.slice(b[0], b[1]) +
      html.slice(a[1], b[0]) +
      html.slice(a[0], a[1]) +
      html.slice(b[1])
    );
  };

  it("throws when two same-date league blocks are swapped, which date equality cannot see", () => {
    // Codex's exact trace, built rather than argued. Matches 0 and 1 are BOTH `D2`, so once their
    // dates agree neither the date check nor a slot check can tell the blocks apart — only the
    // match id can. Without it this page parses and silently reports the wrong opponent team for
    // two matches.
    const sameDate = fixture.html.replaceAll("11/08/2025", "11/15/2025");
    expect(sameDate).not.toBe(fixture.html);

    const swapped = swapBlocks(sameDate, 0, 1);
    expect(swapped).not.toBe(sameDate);
    expect(swapped.length).toBe(sameDate.length); // an exchange, not an edit

    expect(() => parseMatchHistory(swapped, fixture.source)).toThrow(/match id/);
  });

  it("throws when a block's match id does not belong to its row", () => {
    const wrongId = fixture.html.replace(
      '<td style="text-align:center;"><a class="link" href="/adult/matchresults.aspx?year=2026&mid=20336">',
      '<td style="text-align:center;"><a class="link" href="/adult/matchresults.aspx?year=2026&mid=99999">',
    );
    expect(wrongId).not.toBe(fixture.html);

    expect(() => parseMatchHistory(wrongId, fixture.source)).toThrow(/match id/);
  });

  it("throws when a block's court slot does not belong to its row", () => {
    // The slot is carried in both renderings and agrees on all 3996 archived league blocks. It is
    // a second, independent correlate — a page could in principle reuse a match id across courts
    // of one team match, and the slot is what separates them.
    const wrongSlot = fixture.html.replace(
      '<th style="text-align:center;">D2</th>',
      '<th style="text-align:center;">D4</th>',
    );
    expect(wrongSlot).not.toBe(fixture.html);

    expect(() => parseMatchHistory(wrongSlot, fixture.source)).toThrow(/court slot/);
  });

  it("throws when a mobile block links more than one match result", () => {
    // Reviewer finding (Codex round 2, class B). A key selected out of a set that may hold more
    // than one element is not a key: `.first()` would let a second link ahead of the genuine one
    // decide the comparison. All 3996 archived league blocks link exactly one.
    const twoLinks = fixture.html.replace(
      '<td style="text-align:center;"><a class="link" href="/adult/matchresults.aspx?year=2026&mid=20336">',
      '<td style="text-align:center;"><a class="link" href="/adult/matchresults.aspx?year=2026&mid=99999">x</a><a class="link" href="/adult/matchresults.aspx?year=2026&mid=20336">',
    );
    expect(twoLinks).not.toBe(fixture.html);

    expect(() => parseMatchHistory(twoLinks, fixture.source)).toThrow(/expected exactly 1/);
  });

  it("throws when a desktop result cell links more than one match result", () => {
    // The same rule on the other rendering. The Reviewer named the mobile instance; both sides feed
    // the same comparison, and fixing only the reported one is how this class survives a fix.
    const twoLinks = fixture.html.replace(
      '<td style="text-align:center; vertical-align: top;"><a class="link" href="/adult/matchresults.aspx?year=2026&mid=20336">',
      '<td style="text-align:center; vertical-align: top;"><a class="link" href="/adult/matchresults.aspx?year=2026&mid=99999">x</a><a class="link" href="/adult/matchresults.aspx?year=2026&mid=20336">',
    );
    expect(twoLinks).not.toBe(fixture.html);

    expect(() => parseMatchHistory(twoLinks, fixture.source)).toThrow(/expected exactly 1/);
  });

  it("throws on a swapped block even when a matching match id is injected ahead of its own", () => {
    // The Reviewer's full bypass: swap two same-date blocks, then prepend the id the correlation
    // is about to look for, so date, slot and id all agree while the opponent TEAM still comes from
    // the wrong block. The cardinality rule is what closes it — the injected link makes two.
    const sameDate = fixture.html.replaceAll("11/08/2025", "11/15/2025");
    const swapped = swapBlocks(sameDate, 0, 1);
    const spoofed = swapped.replace(
      '<td style="text-align:center;"><a class="link" href="/adult/matchresults.aspx?year=2026&mid=',
      '<td style="text-align:center;"><a class="link" href="/adult/matchresults.aspx?year=2026&mid=20336">x</a><a class="link" href="/adult/matchresults.aspx?year=2026&mid=',
    );
    expect(spoofed).not.toBe(swapped);

    expect(() => parseMatchHistory(spoofed, fixture.source)).toThrow(/expected exactly 1/);
  });

  it("throws when a tournament block's court slot does not belong to its row", () => {
    // Dropped rows get the same treatment. If the correlation slipped, WHICH rows are believed to
    // be tournaments slips with it — and those are discarded silently, so this is the one path
    // where a weak check loses a league match with no error at all.
    const block = TOURNAMENT_MOBILE_BLOCK.replace(
      '<td style="text-align:center;">16</td>',
      '<td style="text-align:center;">R4</td>',
    );

    expect(() => parseMatchHistory(withTournament(fixture.html, 0, { block }), fixture.source))
      .toThrow(/court slot/);
  });
});

describe("parseMatchHistory — mixed-format court slots", () => {
  // Found by sweeping the fix above over all 281 archived pages: with tournaments handled, ONE
  // page still aborted — on `D3X`, a real league court in a "Flex Format 9.0" mixed league. It is
  // the only league slot in the whole archive that `disciplineFor` rejects (4 rows), and the page
  // it kills belongs to a player this issue names as registered to compete. Folded in here rather
  // than filed, because without it this PR's own recovery claim would be false for that player.
  // BOTH renderings carry the slot, and they are now correlated on it — so a test that rewrote only
  // the desktop cell would trip the correlation guard and pass for the wrong reason. (It did: this
  // helper originally edited the desktop cell alone, and the guard added for the Reviewer's class-A
  // finding is what surfaced it.)
  const asSlot = (slot: string, from = "D2"): string => {
    const desktop = `<td style="text-align:center; vertical-align: top;">${from}</td>`;
    const mobile = `<th style="text-align:center;">${from}</th>`;
    const edited = fixture.html
      .replace(desktop, desktop.replace(`>${from}<`, `>${slot}<`))
      .replace(mobile, mobile.replace(`>${from}<`, `>${slot}<`));
    expect(edited).not.toBe(fixture.html);
    return edited;
  };

  it("reads a mixed doubles court (D3X) as doubles rather than aborting the page", () => {
    // The suffix qualifies who may fill the court, not how many. What the archive shows is the
    // cardinality: all four `D3X` rows carry a partner, and the three that were played carry two
    // opponents (the fourth is a default). That is an ordinary doubles court.
    const mixed = asSlot("D3X");
    expect(mixed).not.toBe(fixture.html);

    const parsed = parseMatchHistory(mixed, fixture.source);

    expect(parsed[0]?.slot).toBe("D3X");
    expect(parsed[0]?.discipline).toBe("doubles");
    expect(parsed[0]?.partner).not.toBeNull();
    expect(parsed[0]?.opponents).toHaveLength(2);
  });

  it("accepts a DEFAULTED mixed court, the shape one of the four archived rows actually has", () => {
    // Three of the four `D3X` rows were played; the fourth is a default, where nobody played and
    // `assertCardinality` exempts the court. Asserting only the played shape would leave the
    // archived row this fix exists to recover untested — and a default is where a discipline rule
    // and a cardinality rule are most likely to disagree.
    const cell = '<td style="text-align:center; vertical-align: top;">D3</td>';
    expect(fixture.html.split(cell)).toHaveLength(2); // exactly one D3 court, so the swap is unambiguous

    const parsed = parseMatchHistory(asSlot("D3X", "D3"), fixture.source);

    expect(parsed[2]?.slot).toBe("D3X");
    expect(parsed[2]?.discipline).toBe("doubles");
    expect(parsed[2]?.defaulted).toBe(true);
    expect(parsed[2]?.opponents).toEqual([]);
  });

  it.each(["Default", "R2", "C-F", "16", "D3XY", "Doubles", "DX", "SX", "D", "S"])(
    "still refuses %s, which is not a court slot",
    (slot) => {
      // The mixed suffix widens the grammar by exactly one optional character. A cell that merely
      // STARTS with D or S is not a slot, and admitting one would put a whole page of courts under
      // a discipline nobody read off the page — silently wrong rather than loudly refused.
      expect(() => parseMatchHistory(asSlot(slot), fixture.source)).toThrow(/court slot/);
    },
  );
});

describe("parseMatchHistory — mobile date correlation", () => {
  it.each([
    ["blank", ""],
    ["malformed", "not a date"],
  ])("throws when a mobile block's date is %s, rather than falling back to count-only", (_l, replacement) => {
    // The mobile date is the ONLY thing verifying that the two renderings line up. Treating it as
    // best-effort and skipping the comparison left count-only correlation, under which a reorder
    // silently attributes every opponent team after the divergence to the wrong match — while the
    // parser's own comment claimed position was verified by matching dates.
    // (Provenance: Codex adversarial review round 10 on PR #26.)
    const broken = fixture.html.replace(
      '<th style="text-align:left;" class="padding10">11/15/2025</th>',
      `<th style="text-align:left;" class="padding10">${replacement}</th>`,
    );

    expect(broken).not.toBe(fixture.html);
    expect(() => parseMatchHistory(broken, fixture.source)).toThrow(ParseError);
  });
});
