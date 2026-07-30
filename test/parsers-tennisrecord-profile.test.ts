import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { parseTennisRecordProfile } from "../src/parsers/tennisrecord/profile.js";
import { ParseError } from "../src/parsers/types.js";

const fixture = loadFixture("tennisrecord/profile");
const parsed = parseTennisRecordProfile(fixture.html, fixture.source);

describe("parseTennisRecordProfile", () => {
  it("carries the shared header", () => {
    expect(parsed.header.name).toBe("Avery Ashby");
  });

  it("parses the current playing areas", () => {
    expect(parsed.playingAreas).toEqual(["Missouri Valley / Kansas / Area"]);
  });

  it("parses every recent team with its start date", () => {
    expect(parsed.recentTeams).toHaveLength(5);
    expect(parsed.recentTeams[0]).toEqual({
      teamName: "Norbury, Nova",
      leagueType: "Adult 18+",
      section: "Missouri Valley",
      gender: "M",
      ratingLevel: "4.0",
      matchStartOn: "2026-04-09",
    });
    // The same team recurs across seasons under different league types — the 40+ appearance is
    // what makes this player visible in a 40+ scouting context at all.
    expect(parsed.recentTeams[1]?.leagueType).toBe("Adult 40+");
  });

  it("parses each season's aggregate row", () => {
    expect(parsed.seasonRecords).toHaveLength(4);
    expect(parsed.seasonRecords[0]).toEqual({
      year: "2026",
      matches: { total: 5, wins: 0, losses: 5 },
      sets: { total: 11, wins: 1, losses: 10 },
      games: { total: 86, wins: 26, losses: 60 },
      defaults: 0,
    });
  });

  it("keeps the totals row as its own record rather than reconciling it", () => {
    // The site's totals row is its own claim. Recomputing it from the year rows — or dropping it
    // because it duplicates them — would hide a disagreement that is itself a signal the page
    // has changed shape.
    const totals = parsed.seasonRecords.at(-1);

    expect(totals?.year).toBe("Total");
    expect(totals?.matches).toEqual({ total: 24, wins: 7, losses: 17 });
    expect(totals?.defaults).toBe(2);
  });

  it("throws when the season table is absent", () => {
    const mutated = fixture.html.replace(/All Matches/g, "Nothing Here");

    expect(() => parseTennisRecordProfile(mutated, fixture.source)).toThrow(ParseError);
  });
});

describe("parseTennisRecordProfile — aggregate integrity", () => {
  it("throws when an aggregate cell stops being a number, rather than recording a zero", () => {
    // Coercing a missing cell to 0 turns column drift into statistics: a season row claiming zero
    // wins, zero losses and zero games reads as a player who did not play, and is
    // indistinguishable from one who did.
    // (Provenance: Codex adversarial review round 3 on PR #26.)
    const blanked = fixture.html.replace(">13<", "><");

    expect(blanked).not.toBe(fixture.html);
    expect(() => parseTennisRecordProfile(blanked, fixture.source)).toThrow(ParseError);
  });
});

describe("parseTennisRecordProfile — aggregate column contract", () => {
  it("throws when a numeric column is inserted mid-table", () => {
    // A minimum cell count is not enough: insert one numeric column and the row still clears any
    // minimum while every offset after it shifts, so totals are read from the wrong columns and
    // parsing "succeeds". Only an exact ordered contract catches it.
    // (Provenance: Codex adversarial review round 4 on PR #26.)
    const inserted = fixture.html
      .replace("<th>Defaults</th>", "<th>Extra</th><th>Defaults</th>")
      .replace(/(<td[^>]*>0<\/td>\s*)(<\/tr>)/, "$1<td>0</td>$2");

    expect(inserted).not.toBe(fixture.html);
    expect(() => parseTennisRecordProfile(inserted, fixture.source)).toThrow(ParseError);
  });
});

describe("parseTennisRecordProfile — recent-team column contract", () => {
  it("throws when a recent-team column is removed, rather than shifting every field", () => {
    // The same defect as the roster and the aggregate table, in the third positionally-decoded
    // table on the page. Remove Section and league/gender/rating/date all shift one place left,
    // and the nullable string fields accept every one of them.
    // (Provenance: Codex adversarial review round 5 on PR #26.)
    const noSection = fixture.html.replace(/<th[^>]*>Section<\/th>/, "");

    expect(noSection).not.toBe(fixture.html);
    expect(() => parseTennisRecordProfile(noSection, fixture.source)).toThrow(ParseError);
  });
});
