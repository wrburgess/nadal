import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { parseWtnWidget } from "../src/parsers/wtn/widget.js";
import { ParseError } from "../src/parsers/types.js";

const both = loadFixture("usta/profile-wtn-both");
const doublesOnly = loadFixture("usta/profile-wtn-doubles-only");

describe("parseWtnWidget", () => {
  it("parses both ratings with their confidence bands, game zones and dates", () => {
    expect(parseWtnWidget(both.html, both.source)).toEqual({
      tennisId: "BRA9000002",
      singles: {
        value: 31.65,
        confidence: "Medium Confidence",
        zone: { from: 33.4, to: 29.9 },
        updatedOn: "2025-11-26",
        lastPlayedOn: "2025-06-10",
      },
      doubles: {
        value: 30.15,
        confidence: "High Confidence",
        zone: { from: 31.84, to: 28.47 },
        updatedOn: "2025-11-26",
        lastPlayedOn: "2025-11-15",
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
      updatedOn: "2025-11-05",
      lastPlayedOn: "2025-09-27",
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

describe("parseWtnWidget — partial section drift", () => {
  it("throws when one discipline's title changes while the other still parses", () => {
    // The dangerous shape, and the one a "both are null" guard cannot see: rename only SINGLES
    // and the result is a valid-looking doubles-only profile, indistinguishable from a player who
    // genuinely has no singles rating. The singles WTN is simply gone.
    // (Provenance: Codex adversarial review round 3 on PR #26.)
    const renamedSingles = both.html.replace("WTN SINGLES", "SINGLES WTN");

    expect(() => parseWtnWidget(renamedSingles, both.source)).toThrow(ParseError);
  });

  it("throws when a recognised section loses its numeric value", () => {
    const noValue = both.html.replace(
      '<p class="v-form-wtn-widget__section-value">31.65</p>',
      '<p class="v-form-wtn-widget__section-value"></p>',
    );

    expect(() => parseWtnWidget(noValue, both.source)).toThrow(ParseError);
  });

  it("still reads a genuine doubles-only profile without complaint", () => {
    // The other side of the same guard: failing closed must not reject the real page that has one
    // section because that player has one rating.
    expect(parseWtnWidget(doublesOnly.html, doublesOnly.source)?.singles).toBeNull();
  });
});

describe("parseWtnWidget — the publisher's own dates (#132)", () => {
  it("reads each discipline's date from its own section, not once for the whole widget", () => {
    // The load-bearing shape. The real captures happen to stamp both disciplines with the same
    // ITF publication date, so a parser that read ONE date for the widget would look correct
    // against every page on file and be wrong the first time the two diverge. `Last Played`
    // already differs per discipline in the unmodified fixture above, which is the same evidence
    // one step weaker.
    const skewed = both.html.replace(
      '<p class="v-form-wtn-widget__section-subtitle">Last Played 11/15/2025</p><p class="v-form-wtn-widget__section-subtitle">Updated 11/26/2025</p>',
      '<p class="v-form-wtn-widget__section-subtitle">Last Played 11/15/2025</p><p class="v-form-wtn-widget__section-subtitle">Updated 12/03/2025</p>',
    );
    expect(skewed).not.toBe(both.html);

    const parsed = parseWtnWidget(skewed, both.source);

    expect(parsed?.singles?.updatedOn).toBe("2025-11-26");
    expect(parsed?.doubles?.updatedOn).toBe("2025-12-03");
  });

  it("reads a two-digit year the same way the NTRP date does", () => {
    const shortYear = both.html.replace(/Updated 11\/26\/2025/g, "Updated 11/26/25");
    expect(shortYear).not.toBe(both.html);

    expect(parseWtnWidget(shortYear, both.source)?.singles?.updatedOn).toBe("2025-11-26");
  });

  it("throws when a recognised section carries no Updated date", () => {
    // Failing closed rather than degrading, the same bargain every other guard in this module
    // makes. A section that prints a rating but no date is page drift, and the alternative —
    // silently substituting the capture date — is exactly the defect #132 exists to close: it
    // produced 133 rows dated five days after the number they carry, and nothing could tell.
    const noDate = both.html.replace(
      '<p class="v-form-wtn-widget__section-subtitle">Updated 11/26/2025</p>',
      "",
    );
    expect(noDate).not.toBe(both.html);

    expect(() => parseWtnWidget(noDate, both.source)).toThrow(ParseError);
  });

  it("throws when a recognised section's Updated date is unreadable", () => {
    // Distinct from the case above: the subtitle is present, so a null-check on the node passes.
    // Only reading the value catches it.
    const unreadable = both.html.replace("Updated 11/26/2025", "Updated soon");
    expect(unreadable).not.toBe(both.html);

    expect(() => parseWtnWidget(unreadable, both.source)).toThrow(ParseError);
  });

  it("still throws for the doubles-only page, whose one section must also be dated", () => {
    // The guard has to cover the single-section page too — 24 of the 109 real captures have one
    // section, and a guard written only against the two-section shape would miss all of them.
    const noDate = doublesOnly.html.replace(
      '<p class="v-form-wtn-widget__section-subtitle">Updated 11/05/2025</p>',
      "",
    );
    expect(noDate).not.toBe(doublesOnly.html);

    expect(() => parseWtnWidget(noDate, doublesOnly.source)).toThrow(ParseError);
  });

  it("throws on a section carrying two Updated subtitles rather than silently picking one", () => {
    // The same reasoning as the duplicate-title and duplicate-widget guards below: `.first()`
    // would let a stale or responsive second subtitle decide, by DOM order, which date the binder
    // prints — and both candidates are valid dates, so nothing downstream could notice.
    const duplicated = both.html.replace(
      '<p class="v-form-wtn-widget__section-subtitle">Updated 11/26/2025</p>',
      '<p class="v-form-wtn-widget__section-subtitle">Updated 11/26/2025</p><p class="v-form-wtn-widget__section-subtitle">Updated 01/02/2026</p>',
    );
    expect(duplicated).not.toBe(both.html);

    expect(() => parseWtnWidget(duplicated, both.source)).toThrow(ParseError);
  });

  it("does not require a Last Played date, which is not persisted", () => {
    // Only `updatedOn` reaches the database, so only `updatedOn` fails closed. Refusing a page
    // over a field nothing reads would be a guard with no consequence to protect.
    const noLastPlayed = both.html.replace(
      /<p class="v-form-wtn-widget__section-subtitle">Last Played [0-9/]+<\/p>/g,
      "",
    );
    expect(noLastPlayed).not.toBe(both.html);

    const parsed = parseWtnWidget(noLastPlayed, both.source);

    expect(parsed?.singles?.lastPlayedOn).toBeNull();
    expect(parsed?.singles?.updatedOn).toBe("2025-11-26");
  });
});

describe("parseWtnWidget — duplicate sections", () => {
  it("throws on a duplicated recognised section rather than silently picking one", () => {
    // `find` takes the first and drops the rest, so a responsive or stale second widget would
    // quietly decide which rating a dossier shows. The USTA page renders other blocks twice — its
    // identity block has desktop and mobile variants — so this is not hypothetical markup.
    // (Provenance: Codex adversarial review round 4 on PR #26.)
    const section = /<div class="v-form-wtn-widget__section">[\s\S]*?<h5 class="v-form-wtn-widget__section-title">WTN DOUBLES<\/h5>/;
    const match = section.exec(doublesOnly.html);
    expect(match).not.toBeNull();
    const duplicated = doublesOnly.html.replace(match![0], `${match![0]}${match![0]}`);

    expect(() => parseWtnWidget(duplicated, doublesOnly.source)).toThrow(ParseError);
  });
});

describe("parseWtnWidget — duplicate widgets", () => {
  it("throws when the page carries more than one WTN widget", () => {
    // The section-level duplicate guard only sees inside the FIRST widget. A second one — stale,
    // or a responsive variant like the identity block this page already duplicates — would be
    // silently ignored, and which rating a dossier showed would depend on DOM order.
    // (Provenance: Codex adversarial review round 5 on PR #26.)
    const cloned = doublesOnly.html.replace(
      '<div id="wtnwidget-',
      '<div class="v-form-wtn-widget"></div><div id="wtnwidget-',
    );

    expect(cloned).not.toBe(doublesOnly.html);
    expect(() => parseWtnWidget(cloned, doublesOnly.source)).toThrow(ParseError);
  });
});
