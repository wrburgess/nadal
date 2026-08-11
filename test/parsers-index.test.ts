import { describe, expect, it } from "vitest";
import * as parsers from "../src/parsers/index.js";

describe("src/parsers public surface", () => {
  it("exports every parser Phase 3's pull pipelines will call", () => {
    // The barrel is the contract #15 builds against. Renaming a parser is a breaking change to
    // that contract, and without this the rename would only surface when the pull pipeline is
    // already half written.
    expect(Object.keys(parsers).sort()).toEqual([
      "ParseError",
      "courtMatchRecordSchema",
      "ntrpRatingTypeSchema",
      "parseMatchHistory",
      "parseTennisRecordHeader",
      "parseTennisRecordProfile",
      "parseTennisRecordTeam",
      "parseUstaProfile",
      "parseWtnProfile",
      "parseWtnWidget",
      "playerRefSchema",
      "ratingObservationSchema",
      "recentTeamSchema",
      "seasonRecordSchema",
      "setScoreSchema",
      "sourceRefSchema",
      "teamRosterEntrySchema",
      "teamScheduleRowSchema",
      "tennisRecordHeaderSchema",
      "tennisRecordProfileSchema",
      "tennisRecordTeamSchema",
      "ustaProfileSchema",
      "winLossSchema",
      "wtnPlayerProfileSchema",
      "wtnProfileSchema",
      "wtnRatingSchema",
    ]);
  });
});
