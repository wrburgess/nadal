import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { parseTennisRecordTeam } from "../src/parsers/tennisrecord/team.js";
import { ParseError } from "../src/parsers/types.js";

const fixture = loadFixture("tennisrecord/team");
const team = parseTennisRecordTeam(fixture.html, fixture.source);

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

  it("throws when a roster column is reordered", () => {
    const location = '<th style="text-align:left;" class="hide">Location</th>';
    const ntrp = '<th style="text-align:center; border-right:1px solid #ddd;">NTRP</th>';
    const swapped = fixture.html.replace(location, "@@LOC@@").replace(ntrp, location).replace("@@LOC@@", ntrp);
    // Only assert if the mutation applied; otherwise the header layout changed and this test
    // would silently pass on an unmutated fixture.
    expect(swapped).not.toBe(fixture.html);
    expect(() => parseTennisRecordTeam(swapped, fixture.source)).toThrow(ParseError);
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
