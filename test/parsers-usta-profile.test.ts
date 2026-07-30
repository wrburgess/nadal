import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/fixtures.js";
import { parseUstaProfile } from "../src/parsers/usta/profile.js";
import { ParseError } from "../src/parsers/types.js";

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
