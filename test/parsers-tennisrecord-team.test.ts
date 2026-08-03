import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { removeAllRosterRows } from "./helpers/roster-html.js";
import { parseTennisRecordTeam } from "../src/parsers/tennisrecord/team.js";
import { ParseError } from "../src/parsers/types.js";

const fixture = loadFixture("tennisrecord/team");
const team = parseTennisRecordTeam(fixture.html, fixture.source);

// The 11-column shape a team returns once its postseason is on record (issue #92). Derived from
// the committed 8-column fixture by inserting the three `Postseason*` columns in the position and
// with the header text MEASURED off the live OK/Dickason page, so no new identity enters the repo.
// Faithfulness check: before the fix, this fixture reproduced the live page's ParseError verbatim,
// including its full column list.
const postseasonFixture = loadFixture("tennisrecord/team-postseason");

describe("parseTennisRecordTeam", () => {
  it("parses the team header", () => {
    expect(team).toMatchObject({
      teamName: "Norbury, Nova",
      leagueType: "Adult 18+",
      section: "Missouri Valley",
      gender: "M",
      ratingLevel: "4.0",
      seasonName: "2026 HOA Adult 18 & Over Summer 2.5W - 5.0 (4.0 Men)",
    });
  });

  it("parses a roster entry in full", () => {
    expect(team.roster[0]).toEqual({
      name: "Ellis Eastwick",
      location: "Fairbrook, KS",
      ntrp: 4.0,
      seasonRecord: { wins: 10, losses: 5 },
      localSingles: { wins: 0, losses: 0 },
      localDoubles: { wins: 0, losses: 3 },
      localRecord: { wins: 0, losses: 3 },
      dynamicRating: 4.06,
      profilePath: "/adult/profile.aspx?playername=Ellis Eastwick",
    });
  });

  it("carries the roster row's per-player profile link unmodified", () => {
    expect(team.roster[1]?.profilePath).toBe("/adult/profile.aspx?playername=EMORY ELLERBY&s=5");
  });

  it("leaves an ALL-CAPS name exactly as the page spelled it", () => {
    // Spec § Ingestion puts identity resolution at ingest — source ids, then aliases, then a
    // fuzzy match WITH HC CONFIRMATION. A parser that title-cased this name would be making the
    // first half of that decision silently, in the one place nobody reviews.
    expect(team.roster[1]?.name).toBe("EMORY ELLERBY");
  });

  it("reads a 0-0 record as zeros rather than as an absence", () => {
    // 0-0 means "played none", which is a fact worth having about a rostered player. Reading it
    // as null makes an unplayed player indistinguishable from an unparsed cell.
    expect(team.roster[0]?.localSingles).toEqual({ wins: 0, losses: 0 });
  });

  it("returns each player once, not once per responsive rendering", () => {
    expect(team.roster).toHaveLength(18);
    expect(new Set(team.roster.map((p) => p.name)).size).toBe(18);
  });

  it("throws when the roster table is absent", () => {
    const mutated = fixture.html.replace(/<div class="large">/, '<div class="gone">');

    expect(() => parseTennisRecordTeam(mutated, fixture.source)).toThrow(ParseError);
  });

  it("falls back to the section when the header has no recognisable league type", () => {
    // Header shape is one unpunctuated string ("Adult 18+ Missouri Valley M 4.0"), so the split
    // is pattern-based. When the pattern does not hold, the parser says so — leagueType null,
    // the unsplit remainder in section — rather than inventing a division of the text.
    const mutated = fixture.html.replace(
      ">Adult 18+ Missouri Valley M 4.0<",
      ">Tri-Level Missouri Valley M 4.0<",
    );
    const parsed = parseTennisRecordTeam(mutated, fixture.source);

    expect(parsed.leagueType).toBeNull();
    expect(parsed.section).toBe("Tri-Level Missouri Valley");
    expect(parsed.gender).toBe("M");
    expect(parsed.ratingLevel).toBe("4.0");
  });
});

describe("parseTennisRecordTeam — column contract", () => {
  it("throws when a roster column is removed, rather than shifting every field", () => {
    // Anchoring on a single NTRP header proves the right table was found and nothing about where
    // anything sits inside it. Drop Location and every later field shifts by one: locations
    // become ratings, ratings become win/loss records, and the nullable parsers absorb the
    // mismatch into plausible nulls. A materially wrong roster, with no error.
    // (Provenance: Codex adversarial review round 3 on PR #26.)
    const noLocation = fixture.html
      .replace('<th style="text-align:left;" class="hide">Location</th>', "")
      .replace(/<td style="text-align:left;" class="hide">[^<]*<\/td>/g, "");

    expect(() => parseTennisRecordTeam(noLocation, fixture.source)).toThrow(ParseError);
  });

  it("maps each value correctly when the roster columns are REORDERED (inverted by #92)", () => {
    // This test previously asserted a THROW: position was the contract, so any reorder was a page
    // change we refused. Issue #92 replaced that with a name -> index map, and the inversion is the
    // point rather than a relaxation — a reordered header now decodes correctly instead of being
    // rejected, and the shift hazard the throw was protecting against no longer exists.
    //
    // Asserting the VALUES, not merely that it parses: "it did not throw" would also pass if the
    // reorder had silently swapped a location into a rating, which is precisely the outcome the
    // original guard was built for (PR #26 round 3).
    const location = '<th style="text-align:left;" class="hide">Location</th>';
    const ntrp = '<th style="text-align:center; border-right:1px solid #ddd;">NTRP</th>';
    const swapped = fixture.html.replace(location, "@@LOC@@").replace(ntrp, location).replace("@@LOC@@", ntrp);
    expect(swapped).not.toBe(fixture.html);

    const reordered = parseTennisRecordTeam(swapped, fixture.source);

    // Header order changed; the BODY cells did not. So a by-name reader must FOLLOW THE HEADERS:
    // the cell holding "4" now sits under the `Location` header and the cell holding
    // "Fairbrook, KS" under `NTRP`. That is the observable difference between reading by name and
    // reading by position, and asserting it is what makes this test discriminate — an
    // implementation that quietly went back to fixed indices would return the ORIGINAL values here
    // and pass a weaker "it still parses" check.
    expect(reordered.roster[0]?.name).toBe(team.roster[0]?.name);
    // The page writes "4.0"; parseNumber turns it into 4, so compare against the RAW cell text.
    expect(reordered.roster[0]?.location).toBe("4.0");
    expect(reordered.roster[0]?.ntrp).toBeNull();
    expect(reordered.roster).toHaveLength(team.roster.length);
  });

});

describe("parseTennisRecordTeam — body-row width", () => {
  it("throws when a body cell is inserted while the headers are left alone", () => {
    // The header-mutation tests above never reach this guard: assertColumns throws first, so they
    // pass for a reason other than the one their titles claim about row decoding. This mutation
    // leaves the headers untouched and shifts only the body, which is the case that silently
    // changed a player's stored rating.
    // (Provenance: Codex adversarial review round 6 on PR #26.)
    const extraCell = fixture.html.replace(
      '<td style="text-align:left;" class="padding10"><a class="link" href="/adult/profile.aspx?playername=Ellis Eastwick">Ellis Eastwick</a></td>',
      '<td>x</td><td style="text-align:left;" class="padding10"><a class="link" href="/adult/profile.aspx?playername=Ellis Eastwick">Ellis Eastwick</a></td>',
    );

    expect(extraCell).not.toBe(fixture.html);
    expect(() => parseTennisRecordTeam(extraCell, fixture.source)).toThrow(ParseError);
  });
});

describe("parseTennisRecordTeam — local schedule", () => {
  it("parses every schedule row, hand-verified against the fixture", () => {
    expect(team.schedule).toHaveLength(10);
  });

  it("parses a schedule row in full, with its source match id from mid=", () => {
    expect(team.schedule[0]).toEqual({
      playedOn: "2026-04-09",
      // The Time column was read by the column contract but dropped from the emitted row, which
      // left an id-less fixture with no discriminator finer than its date.
      scheduledTime: "8:00 PM",
      opponentTeamName: "Granborough, Galen",
      site: "Clayview Country Club",
      result: "3-2",
      sourceMatchId: "181505",
    });
  });

  it("throws when the schedule table is absent", () => {
    const mutated = fixture.html.replace(">Local Schedule<", ">Gone<");
    expect(() => parseTennisRecordTeam(mutated, fixture.source)).toThrow(ParseError);
  });
});

describe("parseTennisRecordTeam — blank roster name", () => {
  it("throws rather than quietly returning a roster with a player missing", () => {
    // A structurally valid row whose name cell is empty was converted to `{ name: "" }` and then
    // filtered away, yielding a 17-player roster instead of a failure — a plausible roster with a
    // player silently absent, which is exactly the shape a scout would never notice.
    // (Provenance: Codex adversarial review round 7 on PR #26.)
    const blankName = fixture.html.replace(
      '<a class="link" href="/adult/profile.aspx?playername=Ellis Eastwick">Ellis Eastwick</a>',
      "",
    );

    expect(blankName).not.toBe(fixture.html);
    expect(() => parseTennisRecordTeam(blankName, fixture.source)).toThrow(ParseError);
  });
});

describe("parseTennisRecordTeam — the postseason column block (#92)", () => {
  const postseason = parseTennisRecordTeam(postseasonFixture.html, postseasonFixture.source);

  it("parses a team whose page carries the postseason columns", () => {
    // The reported bug: every team that qualifies for Sectionals has played postseason, so
    // refusing this shape refuses the whole field.
    expect(postseason.roster).toHaveLength(team.roster.length);
    expect(postseason.roster.map((r) => r.name)).toEqual(team.roster.map((r) => r.name));
  });

  it("reads the SAME values as the 8-column shape — nothing shifted", () => {
    // The assertion that matters. Parsing successfully is not the claim; parsing to the same
    // ratings and records is. A positional reader that had merely been made tolerant would pass
    // the test above and fail this one, having quietly read a postseason cell as a rating.
    expect(postseason.roster).toEqual(team.roster);
  });

  it("still refuses a column it does not recognize", () => {
    // The guard PR #26 built must survive being made tolerant: an OPEN vocabulary would accept a
    // page that renamed or dropped a column we rely on, failing in the invisible direction.
    const unknown = postseasonFixture.html.replace(
      "<th style=\"text-align:center;\">Postseason<br>Singles</th>",
      "<th style=\"text-align:center;\">Playoff<br>Singles</th>",
    );
    expect(unknown).not.toBe(postseasonFixture.html);

    expect(() => parseTennisRecordTeam(unknown, postseasonFixture.source)).toThrow(/unrecognized column/i);
  });

  it("still refuses when a REQUIRED column is missing", () => {
    // Tolerating an optional block must not loosen the required set.
    const dropped = postseasonFixture.html.replace(
      "<th style=\"text-align:center;\">Local<br>Doubles</th>",
      "",
    );
    expect(dropped).not.toBe(postseasonFixture.html);

    expect(() => parseTennisRecordTeam(dropped, postseasonFixture.source)).toThrow(/missing required column/i);
  });

  it("refuses a duplicated column rather than picking one", () => {
    // Two headers claiming the same field is a page change, and choosing either would be a guess.
    const duplicated = postseasonFixture.html.replace(
      "<th style=\"text-align:center;\">Local<br>Singles</th>",
      "<th style=\"text-align:center;\">Local<br>Singles</th><th style=\"text-align:center;\">Local<br>Singles</th>",
    );
    expect(duplicated).not.toBe(postseasonFixture.html);

    expect(() => parseTennisRecordTeam(duplicated, postseasonFixture.source)).toThrow(/two "localsingles" columns/i);
  });

  it("derives the body-row width from the header colspans, not a constant", () => {
    // 8 headers describe 9 cells and 11 describe 12, because `Rating` carries colspan="2". The old
    // constant (9) was right for one shape and wrong for the other; a body cell inserted into the
    // 11-column shape must still be caught.
    const extraCell = postseasonFixture.html.replace(
      '<td style="text-align:left;" class="padding10"><a class="link" href="/adult/profile.aspx?playername=Ellis Eastwick">Ellis Eastwick</a></td>',
      '<td>x</td><td style="text-align:left;" class="padding10"><a class="link" href="/adult/profile.aspx?playername=Ellis Eastwick">Ellis Eastwick</a></td>',
    );
    expect(extraCell).not.toBe(postseasonFixture.html);

    expect(() => parseTennisRecordTeam(extraCell, postseasonFixture.source)).toThrow(/roster row has 13 cells, expected exactly 12/);
  });
});

describe("parseTennisRecordTeam — findings from the PR #93 review", () => {
  it("keeps every profile link when the Name column is NOT first", () => {
    // Finding 1 [high]. Every other field moved to by-name lookup; `profilePath` stayed positional
    // on `.first()`. A page that reordered `Name` away from the front then parsed cleanly, produced
    // correct scalar fields, and returned profilePath: null for EVERY player — so `--players`
    // enriched nobody and still exited 0. The by-name contract is what makes that reorder
    // reachable, so this PR introduced the hazard it now closes.
    //
    // Swap Name and Location in both the header and every body row.
    const nameTh = '<th style="text-align:left;" class="padding10">Name</th>';
    const locTh = '<th style="text-align:left;" class="hide">Location</th>';
    let swapped = fixture.html.replace(nameTh, "@@N@@").replace(locTh, nameTh).replace("@@N@@", locTh);
    swapped = swapped.replace(
      /<td style="text-align:left;" class="padding10">(<a class="link" href="[^"]*">[^<]*<\/a>)<\/td>\s*<td style="text-align:left;" class="hide">([^<]*)<\/td>/g,
      '<td style="text-align:left;" class="hide">$2</td><td style="text-align:left;" class="padding10">$1</td>',
    );
    expect(swapped).not.toBe(fixture.html);

    const reordered = parseTennisRecordTeam(swapped, fixture.source);

    // The link must survive, and must belong to the player it is printed next to.
    expect(reordered.roster[0]?.name).toBe(team.roster[0]?.name);
    expect(reordered.roster[0]?.profilePath).toBe(team.roster[0]?.profilePath);
    expect(reordered.roster.every((r) => r.profilePath !== null)).toBe(true);
  });

  it("refuses a body cell that SPANS columns, which keeps the row length identical", () => {
    // Finding 2 [high]. The width guard counted <td> ELEMENTS, so `<td colspan="2">` kept the count
    // at 12 while moving every later value one column right in the rendered grid: the check passed
    // and the values were silently wrong. Indexing is only meaningful when one cell is one column.
    const spanned = postseasonFixture.html.replace(
      '<td style="text-align:left;" class="hide">Fairbrook, KS</td>',
      '<td colspan="2" style="text-align:left;" class="hide">Fairbrook, KS</td>',
    );
    expect(spanned).not.toBe(postseasonFixture.html);

    expect(() => parseTennisRecordTeam(spanned, postseasonFixture.source)).toThrow(/spanning cell/i);
  });

  it("refuses a roster table with a valid header and no player rows", () => {
    // Finding 3 [medium], pre-existing and folded in. An empty roster parsed to `roster: []`, so
    // the CLI reported `status=ok ... roster=0` — a scouting pull that found nobody, reading as
    // success, with the snapshot watermark advancing behind it.
    // Reuses the same helper test/ingest-team-pull.test.ts drives this case with, rather than a
    // second hand-rolled regex that could silently match nothing.
    const headerOnly = removeAllRosterRows(fixture.html, team.roster.map((r) => r.name));
    expect(headerOnly).not.toBe(fixture.html);

    expect(() => parseTennisRecordTeam(headerOnly, fixture.source)).toThrow(/no player rows/i);
  });
});
