import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { parseUstaProfile } from "../src/parsers/usta/profile.js";
import { ParseError } from "../src/parsers/types.js";
import { normalizeGender } from "../src/ingest/normalize-gender.js";

const fixture = loadFixture("usta/profile-wtn-both");

describe("parseUstaProfile", () => {
  it("parses identity, league context and the dated NTRP rating", () => {
    expect(parseUstaProfile(fixture.html, fixture.source)).toEqual({
      name: "Umber Ulverton",
      uaid: "900000002",
      gender: "MALE",
      location: "Rivermont, MO",
      section: "Missouri Valley",
      district: "Heart of America",
      wtnTennisId: "BRA9000002",
      ntrp: { source: "ntrp", value: 3.5, ratingType: "C", observedOn: "2025-12-31" },
    });
  });

  it("expands the two-digit year the NTRP block prints", () => {
    // The page renders "Updated Date 12/31/24". Read literally that is the year 24; read as a
    // rating effective date it is 2024-12-31, and NTRP effective dates are the axis the whole
    // rating trajectory is plotted on.
    const older = loadFixture("usta/profile-wtn-doubles-only");

    expect(parseUstaProfile(older.html, older.source).ntrp?.observedOn).toBe("2024-12-31");
  });

  it("takes the uaid from the URL, where it is the only place it exists", () => {
    // The profile is a client-rendered page addressed by fragment; the uaid appears nowhere in
    // the document body. This is why SourceRef is a parser input rather than decoration.
    expect(parseUstaProfile(fixture.html, fixture.source).uaid).toBe("900000002");
  });

  it("throws when the source URL carries no uaid", () => {
    // A profile record with no source id cannot be resolved to a player at ingest, and spec
    // § Ingestion forbids a silent merge. Refusing to build the record is the only safe outcome.
    const noId = { ...fixture.source, url: "https://www.usta.com/en/home/play/player-search.html" };

    expect(() => parseUstaProfile(fixture.html, noId)).toThrow(ParseError);
  });

  it("reports an absent NTRP block as null without throwing", () => {
    // A player with no NTRP rating is an ordinary player, not a broken page.
    const mutated = fixture.html.replace(/ntrpSummary/g, "somethingElse");

    expect(parseUstaProfile(mutated, fixture.source).ntrp).toBeNull();
  });

  it("keeps an NTRP value that carries no rating type", () => {
    const mutated = fixture.html.replace("<p>3.5 C</p>", "<p>3.5</p>");
    const parsed = parseUstaProfile(mutated, fixture.source);

    expect(parsed.ntrp).toMatchObject({ value: 3.5, ratingType: null });
  });

  it("throws when the name element is missing", () => {
    const mutated = fixture.html.replace(/fullName/g, "notTheName");

    expect(() => parseUstaProfile(mutated, fixture.source)).toThrow(ParseError);
  });

  it("emits the name exactly as the page spelled it", () => {
    // Deliberately NOT canonicalised. Spec § Ingestion resolves identity at ingest — ids, then
    // aliases, then a fuzzy match with HC confirmation — so reordering or re-casing a name in a
    // parser would make the first half of that decision invisibly, and no captured page has ever
    // used a form that needed it.
    const mutated = fixture.html.replace(">Umber Ulverton<", ">Ulverton, Umber<");

    expect(parseUstaProfile(mutated, fixture.source).name).toBe("Ulverton, Umber");
  });
});

describe("parseUstaProfile — context block", () => {
  it("throws when the context block is gone, rather than emitting a context-free player", () => {
    // Previously produced a record with a real name and uaid, an empty gender and null
    // location/section/district: a profile that looks usable and carries no context at all.
    // (Provenance: Codex adversarial review round 3 on PR #26.)
    const noContext = fixture.html.replace(/nameGenderAddress/g, "somethingElse");

    expect(() => parseUstaProfile(noContext, fixture.source)).toThrow(ParseError);
  });
});

/**
 * Issue #130. `players.gender` holds `Competition Category: MALE` — the source LABEL, not the
 * value — on all 77 rows that have a gender at all. Root cause: FIXTURE DRIFT. Live USTA markup
 * prefixes the identity paragraph's gender segment with a `Competition Category:` label; the
 * committed fixture predates that change and has never exercised the label-stripping path.
 *
 * Both live shapes below are derived from the committed fixture's own identity paragraph via
 * `.replace()`, never hand-authored, per this project's fixture convention — and per
 * rules/testing.md, the `&nbsp;` a live shape needs is written as the JS escape for U+00A0
 * (the six source characters backslash, u, 0, 0, A, 0), never a literal non-breaking-space
 * character, so an editor cannot silently collapse it to a plain space and make this test share
 * the bug's own failure mode.
 */
describe("parseUstaProfile — gender label (#130)", () => {
  // The exact identity paragraph the fixture prints today, appearing twice in the captured
  // document (desktop + mobile variants — see the WTN widget's duplicate-block comment). Cheerio
  // reads only `.first()`, and a bare `.replace()` touches only the first occurrence, so rewriting
  // this string edits exactly the paragraph the parser consumes.
  const OLD_IDENTITY_P =
    '<p><span class="aem-form-text--text-transform--capitalize">MALE</span> | Rivermont, MO<br aria-hidden="true" role="presentation"></p>';

  it("is present in the fixture exactly where this test assumes it is", () => {
    // Guards the two tests below against silently matching zero occurrences (and therefore
    // testing the OLD shape twice) if the fixture is ever re-captured.
    expect(fixture.html).toContain(OLD_IDENTITY_P);
  });

  it("strips the label from the live single-paragraph shape (Competition Category:\\u00A0MALE | location)", () => {
    const live = fixture.html.replace(
      OLD_IDENTITY_P,
      '<p>Competition Category:\u00A0<span class="aem-form-text--text-transform--capitalize">MALE</span> | ' +
        '<span class="aem-form-text--text-transform--capitalize">Rivermont</span>, MO' +
        '<br aria-hidden="true" role="presentation"></p>',
    );

    const parsed = parseUstaProfile(live, fixture.source);
    expect(parsed.gender).toBe("MALE");
    expect(parsed.location).toBe("Rivermont, MO");
  });

  it("strips the label from the live split-paragraph shape (label and location on separate <p>s, no pipe)", () => {
    const live = fixture.html.replace(
      OLD_IDENTITY_P,
      "<p>Competition Category: MALE</p><p></p><p>Rivermont, MO</p>",
    );

    const parsed = parseUstaProfile(live, fixture.source);
    expect(parsed.gender).toBe("MALE");
    expect(parsed.location).toBe("Rivermont, MO");
  });

  it("throws when the Competition Category label is present but carries no value", () => {
    const live = fixture.html.replace(OLD_IDENTITY_P, "<p>Competition Category: </p><p>Rivermont, MO</p>");

    expect(() => parseUstaProfile(live, fixture.source)).toThrow(ParseError);
  });

  it("still parses the OLD unlabelled shape to MALE (must not regress the fixture as captured)", () => {
    expect(parseUstaProfile(fixture.html, fixture.source).gender).toBe("MALE");
  });

  it("refuses rather than returning a labelled field AS the gender when the identity paragraph is gone", () => {
    // Both fallbacks in `contextLines` are positional. `location` guards against landing on a
    // `Section:`/`District:`/`Nationality:` segment; the unlabelled gender fallback needs the same
    // guard, or a page missing its identity paragraph entirely returns `Section: Missouri Valley`
    // as the gender — a real-looking wrong value, which the block's own comment says is worse than
    // failing. Verified against the un-guarded code: it returned exactly that string.
    const gone = fixture.html.replace(OLD_IDENTITY_P, "");
    expect(gone).not.toBe(fixture.html);

    expect(() => parseUstaProfile(gone, fixture.source)).toThrow(ParseError);
  });

  it("contains the residual positional ambiguity at the ingest boundary, where it fails closed", () => {
    // The one case no guard can catch: with the identity paragraph present but its gender segment
    // absent AND no `Competition Category:` label, the location sits in the gender position and is
    // indistinguishable from a gender by position alone. Every live capture carries the label
    // (109 of 109), so this is the stale shape only. It is contained rather than fixed: the value
    // never reaches `players.gender`, because the ingest normalizer refuses anything that is not a
    // spelled-out gender. Asserting the containment, not endorsing the parse.
    const noGender = fixture.html.replace(
      OLD_IDENTITY_P,
      '<p>Rivermont, MO<br aria-hidden="true" role="presentation"></p>',
    );
    expect(noGender).not.toBe(fixture.html);

    expect(normalizeGender(parseUstaProfile(noGender, fixture.source).gender)).toBeNull();
  });
});
