import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { parseWtnProfile } from "../src/parsers/wtn/profile.js";
import { ParseError } from "../src/parsers/types.js";

const fixture = loadFixture("wtn/profile-full");

// The exact identity block the fixture prints today — `[class*="playerDetailsHeader"]` containing
// one `<h2>` (name) and one `<p>` (`Male|41-50|USA`, pipe-separated). Verified against the fixture
// once here so every `.replace()`-derived variant below is provably editing the real block, not a
// decoy string that happens to also appear in the document (rules/testing.md).
const IDENTITY_BLOCK =
  '<div class="profile-header-module__playerDetailsHeader___p1yB3"><h2 class="profile-header-module__textWhite___QQsdG">micah merrivale</h2><p class="profile-header-module__textWhite___QQsdG">Male<span class="profile-header-module__playerStatsPadding___X3N39">|</span>41-50<span class="profile-header-module__playerStatsPadding___X3N39">|</span><img src="https://prd-itf-web.clubspark.pro//Content/Public/Clubspark/itf/global/img/flags/US.png" alt="USA" title="USA" class="generic-components-module__flag___e-xb1"> USA</p></div>';

describe("parseWtnProfile", () => {
  it("is present in the fixture exactly where this test assumes it is", () => {
    expect(fixture.html).toContain(IDENTITY_BLOCK);
  });

  it("parses gender and age range off a real captured WTN profile", () => {
    expect(parseWtnProfile(fixture.html, fixture.source)).toEqual({
      name: "micah merrivale",
      tennisId: "MER9000003",
      gender: "Male",
      ageRange: "41-50",
    });
  });

  it("takes the tennis id from the source URL's own tennis-id query parameter", () => {
    expect(parseWtnProfile(fixture.html, fixture.source).tennisId).toBe("MER9000003");
  });

  it("emits NO ratings — WTN ratings stay sourced from the USTA-embedded ITF widget (#132)", () => {
    const parsed = parseWtnProfile(fixture.html, fixture.source) as Record<string, unknown>;
    expect(parsed.singles).toBeUndefined();
    expect(parsed.doubles).toBeUndefined();
  });

  it.each([
    ["18-30"],
    ["81-90"],
    ["0-10"],
  ])("parses the boundary age range %j unchanged", (ageRange) => {
    const mutated = fixture.html.replace(IDENTITY_BLOCK, IDENTITY_BLOCK.replace("41-50", ageRange));
    expect(mutated).not.toBe(fixture.html);

    expect(parseWtnProfile(mutated, fixture.source).ageRange).toBe(ageRange);
  });

  it("throws when the identity paragraph is absent", () => {
    const noParagraph = fixture.html.replace(
      /<p class="profile-header-module__textWhite___QQsdG">Male.*?<\/p>/,
      "",
    );
    expect(noParagraph).not.toBe(fixture.html);

    expect(() => parseWtnProfile(noParagraph, fixture.source)).toThrow(ParseError);
  });

  it("throws when the identity line is reordered (age range before gender)", () => {
    const mutated = fixture.html.replace(
      IDENTITY_BLOCK,
      IDENTITY_BLOCK.replace(
        'Male<span class="profile-header-module__playerStatsPadding___X3N39">|</span>41-50',
        '41-50<span class="profile-header-module__playerStatsPadding___X3N39">|</span>Male',
      ),
    );
    expect(mutated).not.toBe(fixture.html);

    expect(() => parseWtnProfile(mutated, fixture.source)).toThrow(ParseError);
  });

  it("throws when the gender label is renamed to something unrecognised", () => {
    const mutated = fixture.html.replace(
      IDENTITY_BLOCK,
      IDENTITY_BLOCK.replace(">Male<", ">M<"),
    );
    expect(mutated).not.toBe(fixture.html);

    expect(() => parseWtnProfile(mutated, fixture.source)).toThrow(ParseError);
  });

  it("throws on a second identity block rather than silently picking one (duplicate placed AFTER the real one)", () => {
    // Placed AFTER the complete, valid block — so an implementation that returns as soon as it
    // finds ONE matching block (an early exit) would wrongly pass this test if the duplicate came
    // first and the scan never reached it. Appending it after is what actually exercises the
    // "more than one on the page" guard rather than merely re-testing the first block.
    const duplicated = fixture.html.replace(IDENTITY_BLOCK, IDENTITY_BLOCK + IDENTITY_BLOCK);
    expect(duplicated).not.toBe(fixture.html);

    expect(() => parseWtnProfile(duplicated, fixture.source)).toThrow(ParseError);
  });

  it("throws when the source URL carries no tennis-id", () => {
    const noId = { ...fixture.source, url: "https://worldtennisnumber.com/eng/player-profile" };

    expect(() => parseWtnProfile(fixture.html, noId)).toThrow(ParseError);
  });
});
