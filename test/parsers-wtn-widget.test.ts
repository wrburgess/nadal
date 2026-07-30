import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { parseWtnWidget } from "../src/parsers/wtn/widget.js";
import { ParseError } from "../src/parsers/types.js";

const both = loadFixture("usta/profile-wtn-both");
const doublesOnly = loadFixture("usta/profile-wtn-doubles-only");

describe("parseWtnWidget", () => {
  it("parses both ratings with their confidence bands and game zones", () => {
    expect(parseWtnWidget(both.html, both.source)).toEqual({
      tennisId: "BRA9000002",
      singles: {
        value: 31.65,
        confidence: "Medium Confidence",
        zone: { from: 33.4, to: 29.9 },
      },
      doubles: {
        value: 30.15,
        confidence: "High Confidence",
        zone: { from: 31.84, to: 28.47 },
      },
    });
  });

  it("reports a missing singles rating as null on a real doubles-only profile", () => {
    // A genuine capture: this player has a doubles WTN and no singles one. The spreadsheet
    // workflow recorded a blank cell here, which reads identically to "not collected yet".
    const parsed = parseWtnWidget(doublesOnly.html, doublesOnly.source);

    expect(parsed?.singles).toBeNull();
    expect(parsed?.doubles).toEqual({
      value: 29.13,
      confidence: "Medium Confidence",
      zone: { from: 30.87, to: 27.4 },
    });
  });

  it("ignores the word Singles when it appears outside the widget", () => {
    // courtgrab2 read WTN with /Singles:?\s*([0-9.]+)/ over the whole page text, so any other
    // "Singles" on the page could supply the rating. The doubles-only capture happens not to
    // contain the word at all, so the distractor is injected here — into page chrome, outside
    // the widget — to make the difference between the two approaches observable.
    const distracted = doublesOnly.html.replace(
      "<body",
      '<div class="promo">Singles: 25.0 Doubles: 25.0</div><body',
    );

    expect(parseWtnWidget(distracted, doublesOnly.source)?.singles).toBeNull();
  });

  it("throws when the widget prints ratings but no section title matches", () => {
    // "This player has no WTN" and "the widget renamed its sections" produce the same result
    // object — `singles: null, doubles: null` — so the distinction has to be drawn here or it is
    // gone. The presence of rating values with no matching title is what separates them.
    const renamed = doublesOnly.html.replace(/WTN DOUBLES/g, "DOUBLES WTN");

    expect(() => parseWtnWidget(renamed, doublesOnly.source)).toThrow(ParseError);
  });

  it("returns null when the player has no WTN widget at all", () => {
    // Distinct from a structural failure: plenty of USTA players have no WTN record, and that is
    // a fact about the player rather than about the page.
    const mutated = doublesOnly.html.replace(/v-form-wtn-widget/g, "someOtherWidget");

    expect(parseWtnWidget(mutated, doublesOnly.source)).toBeNull();
  });
});
