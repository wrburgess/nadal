import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { parseTennisRecordHeader } from "../src/parsers/tennisrecord/header.js";
import { ParseError } from "../src/parsers/types.js";

const profile = loadFixture("tennisrecord/profile");

describe("parseTennisRecordHeader", () => {
  it("parses identity and both dated ratings", () => {
    expect(parseTennisRecordHeader(profile.html, profile.source)).toEqual({
      name: "Avery Ashby",
      location: "Rivermont, MO",
      gender: "Male",
      ntrp: { source: "ntrp", value: 4.0, ratingType: "C", observedOn: "2025-12-31" },
      dynamicRating: {
        source: "tr_dynamic",
        value: 3.6663,
        ratingType: null,
        observedOn: "2026-07-27",
      },
      projectedYearEndRating: null,
    });
  });

  it.each(["tennisrecord/profile", "tennisrecord/match-history", "tennisrecord/player-stats"])(
    "parses the same header from %s",
    (name) => {
      // "TennisRecord repeats one header block across its player pages" is an assumption the
      // other parsers are built on, so it is asserted rather than believed.
      const fixture = loadFixture(name);
      const header = parseTennisRecordHeader(fixture.html, fixture.source);

      expect(header.name).toBe("Avery Ashby");
      expect(header.ntrp?.value).toBe(4.0);
      expect(header.dynamicRating?.value).toBe(3.6663);
    },
  );

  it("reports an unavailable projected year-end rating as null", () => {
    // The page prints `------` for a projection it has not computed. Coercing that to 0 would
    // put a fictional 0.0 projection on every player early in a season.
    expect(parseTennisRecordHeader(profile.html, profile.source).projectedYearEndRating).toBeNull();
  });

  it("splits the NTRP rating type from its value", () => {
    expect(parseTennisRecordHeader(profile.html, profile.source).ntrp).toMatchObject({
      value: 4.0,
      ratingType: "C",
    });
  });

  it("throws on an NTRP rating type it does not recognise", () => {
    // Rating TYPE is load-bearing for scouting — a self-rated 4.0 and a computer-rated 4.0 are
    // different players. Dropping an unrecognised letter would hide exactly that distinction, so
    // an unknown one is a loud failure rather than a silent null.
    const mutated = profile.html.replace(">4.0 C<", ">4.0 Q<");

    expect(() => parseTennisRecordHeader(mutated, profile.source)).toThrow(ParseError);
  });

  it("throws when the header block is absent", () => {
    const mutated = profile.html.replace(/Estimated Dynamic Rating/g, "Something Else");

    expect(() => parseTennisRecordHeader(mutated, profile.source)).toThrow(ParseError);
  });
});
