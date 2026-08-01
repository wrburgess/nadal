import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  RedactionError,
  assertNoCredentialFields,
  assertRedacted,
  decodeEntities,
  redact,
  redactHtml,
  views,
} from "../tools/redact-fixture.js";
import { PolicyError } from "../tools/fixture-policy.js";

const SUBS = [
  { from: "Cory Hogan", to: "Dana Sample" },
  { from: "Overland Park, KS", to: "Riverton, KS" },
  { from: "2018259527", to: "9000000001" },
];

const PAGE = `<html><head>
<style>.leak { content: "Cory Hogan"; }</style>
<script>var uaid = "2018259527"; var who = "Cory Hogan";</script>
</head><body>
<div class="profile" data-owner="Cory Hogan">
  <h3 class="name">Cory Hogan</h3>
  <p class="loc">Overland Park, KS</p>
  <a class="link" href="/player.aspx?playername=Cory%20Hogan&amp;uaid=2018259527">history</a>
  <a class="link" href="/other.aspx?playername=Cory+Hogan">alt encoding</a>
  <span class="shout">CORY HOGAN</span>
  <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA" alt="logo">
</div>
</body></html>`;

const PLAYERNAME_DETECTOR = {
  name: "playername",
  pattern: /playername=([^"&']+)/g,
};

describe("redactHtml", () => {
  it("substitutes in text nodes and in attribute values", () => {
    const out = redactHtml(PAGE, SUBS);

    expect(out).toContain(">Dana Sample<");
    expect(out).toContain('data-owner="Dana Sample"');
    expect(out).toContain(">Riverton, KS<");
    expect(out).not.toMatch(/Cory/i);
  });

  it("preserves an ALL-CAPS occurrence as ALL-CAPS", () => {
    // The TennisRecord team roster renders some names uppercase while the link to the same
    // person is title-cased. A fixture that silently title-cased them would erase the exact
    // casing edge case the team parser is required to leave alone.
    const out = redactHtml(PAGE, SUBS);

    expect(out).toContain(">DANA SAMPLE<");
  });

  it("substitutes percent-encoded and plus-encoded spellings of the same value", () => {
    const out = redactHtml(PAGE, SUBS);

    expect(out).toContain("playername=Dana%20Sample");
    expect(out).toContain("playername=Dana+Sample");
  });

  it("substitutes a mixed encoding, where only some characters are percent-encoded", () => {
    // TennisRecord writes `teamname=Gerleman%2c Garrett`: comma encoded, space left literal.
    // That spelling is neither the literal string, nor encodeURIComponent's, nor the plus form,
    // so a spelling-list matcher walks straight past it — and the surname ships to a public
    // repository while the redaction reports success. Caught by the detector sweep on the first
    // real capture; this is the regression test for it.
    const page = "<a href='/t.aspx?teamname=Hogan%2c Cory&year=2026'>team</a>";
    const out = redactHtml(page, [{ from: "Hogan, Cory", to: "Sample, Dana" }]);

    expect(out).toContain("teamname=Sample%2c Dana");
    expect(out).not.toMatch(/Hogan/i);
  });

  it("writes the replacement back in the encoding style of the match it replaced", () => {
    const page = [
      "<a href='/a?playername=Cory Hogan'>literal</a>",
      "<a href='/b?playername=Cory%20Hogan'>percent</a>",
      "<a href='/c?playername=Cory+Hogan'>plus</a>",
    ].join("");
    const out = redactHtml(page, [{ from: "Cory Hogan", to: "Dana Sample" }]);

    expect(out).toContain("playername=Dana Sample'");
    expect(out).toContain("playername=Dana%20Sample");
    expect(out).toContain("playername=Dana+Sample");
  });

  it("substitutes a name written with HTML character references", () => {
    // A server may emit ANY character as a numeric reference — `&#67;ory` renders as `Cory`, and
    // an apostrophe in a name is routinely written `O&#39;Brien`. A matcher that knows only
    // literal, percent and plus encodings walks straight past all of it, and the identity ships
    // to a public repository while redaction reports success.
    // (Provenance: Codex adversarial review on PR #26, rated critical.)
    const page = [
      "<p>&#67;ory Hogan</p>",
      "<p>Cory&#32;Hogan</p>",
      "<p>Cory&#x20;Hogan</p>",
    ].join("");
    const out = redactHtml(page, [{ from: "Cory Hogan", to: "Dana Sample" }]);

    expect(out).not.toMatch(/ory/i);
    expect(out.match(/Dana/g)).toHaveLength(3);
  });

  it("stays aligned when a character's encoding starts with the character itself", () => {
    // `&` is a prefix of `&#38;`, and `%` is a prefix of `%25`. A shortest-first alignment walk
    // consumes one character of a five-character sequence and every subsequent offset is wrong —
    // which corrupts the replacement rather than merely missing it. Team names really do contain
    // `&` (`HOA/Thyagarajan/18&over4.0M`), so this is reachable on real markup.
    // (Provenance: Codex adversarial review round 2 on PR #26.)
    const ampersand = redactHtml("<a href='/t?teamname=A&#38;B Club'>x</a>", [
      { from: "A&B Club", to: "C&D Club" },
    ]);
    expect(ampersand).toBe("<a href='/t?teamname=C&#38;D Club'>x</a>");

    const percent = redactHtml("<a href='/t?teamname=A%25B Club'>x</a>", [
      { from: "A%B Club", to: "C%D Club" },
    ]);
    expect(percent).toBe("<a href='/t?teamname=C%25D Club'>x</a>");
  });

  it("substitutes a named character reference", () => {
    const out = redactHtml("<p>A&amp;B Club</p>", [{ from: "A&B Club", to: "C&D Club" }]);

    expect(out).toBe("<p>C&amp;D Club</p>");
  });

  it("catches an entity-encoded survivor in the forbidden sweep", () => {
    // The belt to the substitution's braces: verification also sweeps an entity-decoded copy, so
    // an encoding this module cannot yet SUBSTITUTE still cannot ship silently — the capture
    // fails instead of writing the fixture.
    const leaked = "<p>&#67;&#111;&#114;&#121; Hogan</p>";

    expect(() => assertRedacted(leaked, { forbidden: ["Cory Hogan"] })).toThrow(RedactionError);
  });

  it("decodes decimal, hex and named character references", () => {
    expect(decodeEntities("&#67;ory&#x20;Hogan &amp; O&#39;Brien")).toBe(
      "Cory Hogan & O'Brien",
    );
  });

  it("removes script and style content", () => {
    const out = redactHtml(PAGE, SUBS);

    expect(out).not.toContain("var uaid");
    expect(out).not.toContain(".leak");
  });

  it("replaces base64 data URIs with a placeholder", () => {
    const out = redactHtml(PAGE, SUBS);

    expect(out).not.toContain("iVBORw0KGgo");
    expect(out).toContain("data:image/png;base64,REDACTED");
  });

  it("leaves the markup the parsers read structurally identical", () => {
    // The whole premise of a redacted fixture is that it still exercises real markup, so the
    // element tree and its class attributes must survive byte-for-byte. Only script/style are
    // expected to disappear.
    const before = describeStructure(PAGE);
    const after = describeStructure(redactHtml(PAGE, SUBS));

    expect(after).toEqual(before);
  });
});

describe("assertRedacted", () => {
  it("throws when a forbidden value survives anywhere in the output", () => {
    // Red-tested on purpose: a privacy control that has never been observed failing is not a
    // control. Only the name is substituted here, so the location must be caught.
    const partial = redactHtml(PAGE, [{ from: "Cory Hogan", to: "Dana Sample" }]);

    expect(() => assertRedacted(partial, { forbidden: ["Overland Park, KS"] })).toThrow(
      RedactionError,
    );
  });

  it("catches a forbidden value in any of its encoded spellings", () => {
    const untouched = "<a href='/p.aspx?playername=Cory%20Hogan'>x</a>";

    expect(() => assertRedacted(untouched, { forbidden: ["Cory Hogan"] })).toThrow(/Cory/);
  });

  it("throws when a detector finds an identity outside the allow-list", () => {
    // The forbidden list can only catch names someone remembered to list. The detector closes
    // that gap structurally: every playername= value in the output must be a synthetic one.
    const leaked = `${redactHtml(PAGE, SUBS)}<a href="/p.aspx?playername=Real%20Person">x</a>`;

    expect(() =>
      assertRedacted(leaked, {
        forbidden: [],
        detectors: [PLAYERNAME_DETECTOR],
        allowed: ["Dana Sample"],
      }),
    ).toThrow(/Real Person/);
  });

  it("passes for fully redacted output", () => {
    const out = redactHtml(PAGE, SUBS);

    expect(() =>
      assertRedacted(out, {
        forbidden: ["Cory Hogan", "Overland Park, KS", "2018259527"],
        detectors: [PLAYERNAME_DETECTOR],
        allowed: ["Dana Sample"],
      }),
    ).not.toThrow();
  });

  it("reports every survivor, not just the first", () => {
    expect(() => assertRedacted(PAGE, { forbidden: ["Cory Hogan", "2018259527"] })).toThrow(
      /Cory Hogan[\s\S]*2018259527/,
    );
  });
});

/**
 * Every tag with EVERY attribute, not just its class.
 *
 * Comparing tag/class pairs alone let a redaction that silently deleted an unrelated attribute
 * pass a test named "structurally identical" — the base64 pattern consumed the separator before
 * the next attribute in an unquoted value, and `alt` simply vanished.
 * (Provenance: Codex adversarial review round 10 on PR #26.)
 */
function describeStructure(html: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    if (el.tagName === "script" || el.tagName === "style") return;
    // Attribute NAMES plus the class VALUE. Names catch an attribute silently deleted; class
    // values are compared because selectors are written against them. Other attribute values are
    // expected to change — substituting them is the entire point of redaction.
    const names = Object.keys(el.attribs).sort().join(" ");
    out.push(`${el.tagName}[${names}].${el.attribs["class"] ?? ""}`);
  });
  return out;
}

describe("replacement safety", () => {
  it("refuses a replacement that would break the markup it lands in", () => {
    // Substitution runs over raw markup, so a stand-in carrying an apostrophe terminates the
    // single-quoted href it lands in — corrupting the very markup the fixture exists to preserve.
    // Refusing the input is stricter than escaping and, unlike parsing and re-serialising the
    // document, does not alter markup by itself.
    // (Provenance: Codex adversarial review round 3 on PR #26.)
    expect(() =>
      redactHtml("<a href='/p?playername=Cory Hogan'>x</a>", [
        { from: "Cory Hogan", to: "Dana O'Brien" },
      ]),
    ).toThrow(RedactionError);
  });

  it("still allows an ampersand, which real team names contain", () => {
    const out = redactHtml("<p>A&amp;B Club</p>", [{ from: "A&B Club", to: "C&D Club" }]);

    expect(out).toBe("<p>C&amp;D Club</p>");
  });
});

describe("semicolon-less character references", () => {
  it("substitutes a numeric reference with no terminating semicolon", () => {
    // `&#67ory Hogan` is a parse error that browsers recover from and render as `Cory Hogan`, so
    // a matcher that requires the semicolon can be walked past by markup that displays perfectly.
    // (Provenance: Codex adversarial review round 4 on PR #26.)
    const out = redactHtml("<p>&#67ory Hogan</p>", [{ from: "Cory Hogan", to: "Dana Sample" }]);

    expect(out).not.toMatch(/ory/i);
    expect(out).toContain("Dana");
  });

  it("catches a semicolon-less reference in the forbidden sweep", () => {
    expect(() => assertRedacted("<p>&#67ory Hogan</p>", { forbidden: ["Cory Hogan"] })).toThrow(
      RedactionError,
    );
  });

  it("does not treat a longer reference as a shorter one", () => {
    // `&#671;` is ʟ, not `C` followed by `1;`. The negative lookahead is what keeps the
    // semicolon-less alternative from reaching inside a longer, valid reference.
    expect(decodeEntities("&#671;")).toBe("ʟ");
  });
});

describe("replacement-introduced URL structure", () => {
  it("refuses a replacement that introduces an ampersand the original lacked", () => {
    // applyStyle can only reproduce encodings for characters present in the ORIGINAL, so a `&`
    // that exists only in the replacement is emitted literally — inside `playername=Cory%20Hogan`
    // that splits the query parameter. The earlier ampersand test passes only because `&` appears
    // on both sides, letting the recorded `&amp;` style be reused.
    // (Provenance: Codex adversarial review round 6 on PR #26.)
    expect(() =>
      redactHtml("<a href='/p?playername=Cory%20Hogan&year=2026'>x</a>", [
        { from: "Cory Hogan", to: "A&B Club" },
      ]),
    ).toThrow(RedactionError);
  });

  it("still allows an ampersand present on both sides", () => {
    const out = redactHtml("<p>A&amp;B Club</p>", [{ from: "A&B Club", to: "C&D Club" }]);

    expect(out).toBe("<p>C&amp;D Club</p>");
  });
});

describe("named entity bypass", () => {
  it.each([
    ["&NewLine;", "Cory&NewLine;Hogan"],
    ["&Tab;", "Cory&Tab;Hogan"],
    ["&emsp;", "Cory&emsp;Hogan"],
    ["&nbsp;", "Cory&nbsp;Hogan"],
  ])("catches an identity separated by %s", (_label, encoded) => {
    // HTML5 defines over two thousand named references, so a hand-written table is the wrong
    // shape for a privacy control: `Cory&NewLine;Hogan` renders as the name while evading any
    // list that does not happen to include it. Verification now reads the page back through a
    // real parser, whose decoder is complete by construction.
    // (Provenance: Codex adversarial review round 8 on PR #26, rated critical.)
    expect(() => assertRedacted(`<p>${encoded}</p>`, { forbidden: ["Cory Hogan"] })).toThrow(
      RedactionError,
    );
  });

  it("catches an entity-separated identity inside an attribute value", () => {
    // An identity can sit in an attribute as easily as in a text node, and `.text()` alone would
    // not see it.
    expect(() =>
      assertRedacted(`<a title="Cory&NewLine;Hogan">x</a>`, { forbidden: ["Cory Hogan"] }),
    ).toThrow(RedactionError);
  });

  it("does not fire on a page where the identity is genuinely absent", () => {
    // The other half of the guard: collapsing whitespace across text and attributes must not
    // manufacture a match out of unrelated neighbouring content.
    expect(() =>
      assertRedacted("<p>Dana Sample</p><p>Cory</p><p>Hogan is a place</p>", {
        forbidden: ["Cory Hogan"],
      }),
    ).not.toThrow();
  });
});

describe("comment-node identities", () => {
  it.each([
    ["plain", "<!-- Cory Hogan -->"],
    ["&NewLine;", "<!-- Cory&NewLine;Hogan -->"],
    ["&Tab;", "<!-- Cory&Tab;Hogan -->"],
    ["numeric", "<!-- Cory&#32;Hogan -->"],
  ])("catches an identity inside an HTML comment (%s)", (_label, comment) => {
    // `.text()` does not return comment bodies, so a view built from rendered text and attributes
    // alone was blind to them — and the tolerant matcher does not know `&NewLine;`, so the raw
    // sweep missed it too. A comment's content is raw text, so it is parsed in turn and read back.
    // (Provenance: Codex adversarial review round 9 on PR #26, rated critical.)
    expect(() =>
      assertRedacted(`<div>${comment}<p>nothing here</p></div>`, { forbidden: ["Cory Hogan"] }),
    ).toThrow(RedactionError);
  });

  it("catches an identity in a comment nested deep in the tree", () => {
    expect(() =>
      assertRedacted("<div><section><ul><li><!-- Cory&Tab;Hogan --></li></ul></section></div>", {
        forbidden: ["Cory Hogan"],
      }),
    ).toThrow(RedactionError);
  });

  it("does not fire on a comment that holds no forbidden identity", () => {
    expect(() =>
      assertRedacted("<div><!-- Dana Sample, synthetic --><p>Dana Sample</p></div>", {
        forbidden: ["Cory Hogan"],
      }),
    ).not.toThrow();
  });
});

describe("zero-width separators", () => {
  it.each([
    ["text", "<p>Cory&ZeroWidthSpace;Hogan</p>"],
    ["attribute", '<a title="Cory&ZeroWidthSpace;Hogan">x</a>'],
    ["comment", "<div><!-- Cory&ZeroWidthSpace;Hogan --></div>"],
  ])("catches an identity split by a zero-width space in %s", (_label, markup) => {
    // U+200B is not JavaScript whitespace, so collapsing `\s+` leaves it in place: the decoded
    // text matches neither the raw pattern nor `Cory Hogan`, while rendering as the name. Format
    // characters are normalised to a space before the collapse. (The separator is written as an
    // entity in the fixtures above rather than as a literal, which lint rightly rejects.)
    // (Provenance: Codex adversarial review round 10 on PR #26, rated critical.)
    expect(() => assertRedacted(markup, { forbidden: ["Cory Hogan"] })).toThrow(RedactionError);
  });
});

describe("base64 stripping and attribute boundaries", () => {
  it("does not swallow the attribute that follows an unquoted data URI", () => {
    // The payload class previously included `\s`, so the match ran past the end of an unquoted
    // value and ate the separator: `alt` was silently deleted from the fixture.
    const out = redactHtml("<img src=data:image/png;base64,QUJD alt=logo>", []);

    expect(out).toContain("alt=logo");
    expect(out).toContain("data:image/png;base64,REDACTED");
  });

  it("keeps every attribute, not merely every tag and class", () => {
    const page = '<div id="a" data-x="1"><img src="data:image/png;base64,QUJD" alt="logo"></div>';

    expect(describeStructure(redactHtml(page, []))).toEqual(describeStructure(page));
  });
});


describe("Unicode normalisation forms", () => {
  // "José Example" written two ways: composed (U+00E9) and decomposed (e + U+0301). Identical to
  // every reader, different code-point sequences to a matcher — so a map entry written in one form
  // silently misses the other, and an accented real name is common in this domain.
  // (Provenance: Codex adversarial review round 11 on PR #26, rated critical.)
  const composed = "Jos\u00e9 Example";
  const decomposed = "Jose\u0301 Example";

  it.each([
    ["text", (name: string) => `<p>${name}</p>`],
    ["attribute", (name: string) => `<a title="${name}">x</a>`],
    ["comment", (name: string) => `<div><!-- ${name} --></div>`],
    ["percent-encoded URL value", (name: string) => `<a href='/p?playername=${encodeURIComponent(name)}'>x</a>`],
  ])("catches a decomposed identity in %s when the map lists the composed form", (_label, wrap) => {
    expect(() => assertRedacted(wrap(decomposed), { forbidden: [composed] })).toThrow(
      RedactionError,
    );
  });

  it("catches a composed identity when the map lists the decomposed form", () => {
    expect(() => assertRedacted(`<p>${composed}</p>`, { forbidden: [decomposed] })).toThrow(
      RedactionError,
    );
  });

  it("does not fire on a genuinely different name", () => {
    expect(() =>
      assertRedacted("<p>Dana Sample</p>", { forbidden: [composed] }),
    ).not.toThrow();
  });

  it("treats an allow-listed detector value as equal across normalisation forms", () => {
    const detector = { name: "playername", pattern: /playername=([^"&']+)/g };

    expect(() =>
      assertRedacted(`<a href='/p?playername=${decomposed}'>x</a>`, {
        forbidden: [],
        detectors: [detector],
        allowed: [composed],
      }),
    ).not.toThrow();
  });
});

describe("never-publish identity classes", () => {
  it.each([
    ["mailto link", '<a href="mailto:real.person@example.com">Contact</a>'],
    ["bare email", "<p>real.person@example.com</p>"],
    ["tel link", '<a href="tel:+18165551234">Call</a>'],
    ["phone number", "<p>(816) 555-1234</p>"],
    ["street address", "<p>1234 Maple Street</p>"],
  ])("refuses to write output containing a %s, even when the map omits it", (_label, markup) => {
    // The map-derived sweep only catches identities someone enumerated, and the source detectors
    // are narrow spot checks tied to one site's markup. Neither sees an email — so an unlisted
    // identity of a kind the map was never about reached a public fixture with the tool reporting
    // success. (Provenance: Codex adversarial review round 12 on PR #26.)
    expect(() => redact(markup, [{ from: "Cory Hogan", to: "Dana Sample" }])).toThrow(
      RedactionError,
    );
  });

  it("does not fire on ordinary fixture content", () => {
    // Negative control: match ids and SVG path coordinates are five-digit runs, and must not be
    // mistaken for postal codes or phone numbers.
    expect(() =>
      redact('<a href="/adult/matchresults.aspx?year=2026&mid=20336">7-6</a><path d="m4.8 7.8 0.57232-0.58292"/>', []),
    ).not.toThrow();
  });
});

describe("redact() wires in the allow-list policy", () => {
  // Task 9: when a vocabulary is supplied, redact() runs the policy BEFORE the forbidden-value
  // and detector sweeps, so a caller can never hold a redacted string that still carries an
  // unclassified atom. The other 55 cases in this file call redact()/redactHtml() without a
  // vocabulary at all, which is intentionally a no-op for the policy stage (backward compatible)
  // — this is the ONE test that opts in and proves the wiring actually runs and throws.
  it("throws before returning when an atom is neither synthetic, structural, nor vocabulary-listed", () => {
    const page = "<p>Cory Hogan</p><p>Patrick Turner</p>";

    expect(() =>
      redact(page, [{ from: "Cory Hogan", to: "Dana Sample" }], {
        vocabulary: new Set<string>(),
      }),
    ).toThrow(PolicyError);
  });

  it("does not throw when every atom is synthetic, structural, or vocabulary-listed", () => {
    const page = "<p>Cory Hogan</p>";

    expect(() =>
      redact(page, [{ from: "Cory Hogan", to: "Dana Sample" }], {
        vocabulary: new Set<string>(),
      }),
    ).not.toThrow();
  });

  // Round-3 finding R3-1: redact() writes `redactHtml`'s RAW string, but the policy previously
  // inspected only cheerio's RECOVERED DOM — two different documents whenever the parser recovers
  // from malformed markup. The malformed end tag here is discarded by the parser and its bytes
  // never reached an atom of any kind, so an empty vocabulary passed the identity through.
  it("REFUSES the reviewer's repro through redact() itself: a parser-discarded orphan end tag", () => {
    expect(() =>
      redact("<div></Patrick Turner>", [], { vocabulary: new Set<string>() }),
    ).toThrow(PolicyError);
  });
});

// A page captured from a logged-in session carries the SESSION's own secrets, not only the
// subject's identity. TennisLink's league pages are ASP.NET WebForms and embed a 172-character
// `hdnCSRFToken` plus `__VIEWSTATE` in the markup; none of the three redaction layers was built for
// that class (`NEVER_PUBLISH` covers email/phone/address), and the allow-list's documented refusal
// loop invites an operator to resolve the refusal by ADDING the token to the committed vocabulary.
// (Provenance: #27, observed on a live signed-in TennisLink capture session, 2026-08-01.)
describe("credential stripping", () => {
  const WEBFORMS = `<html><body><form>
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEPDwULLTE2MTY2ODcyMjlkZBYCZg9kFgICAw9kFgI">
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="/wEdAAaMOaLJRAP2">
<input type="hidden" id="hdnCSRFToken" value="a1BcDeF23GhIjK45LmNoPqRsTuVwXyZ0AbCdEfG9">
<input type="hidden" id="hdnCSRFSessionRefreshed" value="False">
<meta name="csrf-token" content="s3cr3tT0k3nV4lu3">
<input type="hidden" id="ctl00_mainContent_hdnCyear" value="2026">
<table><tr><td>Dana Sample</td></tr></table>
</form></body></html>`;

  const valueOf = (html: string, sel: string): string | undefined =>
    cheerio.load(html)(sel).attr("value");

  it("empties every credential-bearing field value", () => {
    const out = redactHtml(WEBFORMS, SUBS);
    expect(valueOf(out, "#__VIEWSTATE")).toBe("");
    expect(valueOf(out, "#__EVENTVALIDATION")).toBe("");
    expect(valueOf(out, "#hdnCSRFToken")).toBe("");
    expect(valueOf(out, "#hdnCSRFSessionRefreshed")).toBe("");
    expect(cheerio.load(out)('meta[name="csrf-token"]').attr("content")).toBe("");
  });

  it("leaves the token value nowhere in the output, in any view", () => {
    // The title said "in any view" while the assertions checked only the raw string. `views()` is
    // the same decoded/percent-decoded/rendered set `assertNoUnlistedPii` sweeps, so check that.
    // (Provenance: Stage-4 adversarial pass on this PR, claim-vs-code lens.)
    const secrets = [
      "a1BcDeF23GhIjK45LmNoPqRsTuVwXyZ0AbCdEfG9",
      "/wEPDwULLTE2MTY2ODcyMjlkZBYCZg9kFgICAw9kFgI",
      "s3cr3tT0k3nV4lu3",
    ];
    const allViews = views(redactHtml(WEBFORMS, SUBS));
    expect(allViews.length).toBeGreaterThan(1);
    for (const view of allViews) {
      for (const secret of secrets) expect(view).not.toContain(secret);
    }
  });

  it("keeps the element and its attributes, emptying only the value", () => {
    const $ = cheerio.load(redactHtml(WEBFORMS, SUBS));
    expect($("#__VIEWSTATE").attr("type")).toBe("hidden");
    expect($("#__VIEWSTATE").attr("name")).toBe("__VIEWSTATE");
    expect($("input").length).toBe(5);
  });

  it("does not touch a non-credential hidden field the page uses as data", () => {
    expect(valueOf(redactHtml(WEBFORMS, SUBS), "#ctl00_mainContent_hdnCyear")).toBe("2026");
  });

  it("leaves a button label alone even when its id matches the credential pattern", () => {
    // Found by running this sweep over a real signed-in TennisLink page: `btnCsrfRefreshPage`
    // matches on "csrf" but its value is the VISIBLE LABEL "Refresh Page". A submit/button/reset/
    // image `value` is a label by definition and can never be a credential, so emptying it would
    // silently alter user-visible markup for no privacy gain.
    const withButton = `<input type="submit" id="btnCsrfRefreshPage" value="Refresh Page">`;
    expect(valueOf(redactHtml(withButton, SUBS), "#btnCsrfRefreshPage")).toBe("Refresh Page");
  });

  // `\b` matches after a hyphen, so a `\btype=` / `\bname=` pattern also matches `data-type=` /
  // `data-name=`. Both directions are wrong and one of them fails OPEN.
  // (Provenance: Stage-4 adversarial pass on this PR, fail-open lens.)
  it("is not fooled into skipping by a data-type attribute", () => {
    const smuggled = `<input data-type="submit" type="hidden" id="hdnCSRFToken" value="SECRET">`;
    const out = redactHtml(smuggled, SUBS);
    expect(valueOf(out, "#hdnCSRFToken")).toBe("");
    expect(out).not.toContain("SECRET");
    expect(out).toContain('data-type="submit"');
  });

  it("does not read a data-name attribute as the field's name", () => {
    const benign = `<input type="hidden" data-name="__VIEWSTATE" id="benign" value="keep me">`;
    expect(valueOf(redactHtml(benign, SUBS), "#benign")).toBe("keep me");
  });

  // Every one of these is a CONFIRMED trace from the Codex adversarial review of PR #79, each
  // reproduced locally before being fixed. The hand-written tag matcher failed all of them; the
  // parser-located version is what closes the class rather than the individual delimiter.
  describe("Codex adversarial-review traces", () => {
    it("strips a credential whose value contains a quoted '>'", () => {
      // CRITICAL: `<(?:input|meta)\b[^>]*>` truncated the tag at the `>` INSIDE the quoted value, so
      // the tag never matched and the token survived untouched — and the backstop, reusing the same
      // matcher, passed on it too.
      const html = `<input type="hidden" id="hdnCSRFToken" value="abc>SECRET">`;
      const out = redactHtml(html, SUBS);
      expect(out).not.toContain("SECRET");
      expect(valueOf(out, "#hdnCSRFToken")).toBe("");
      expect(() => assertNoCredentialFields(html)).toThrow(RedactionError);
    });

    it("is not fooled by a colon-prefixed attribute name", () => {
      // `(?<![-\w])` rejected `-` and word chars but not `:`, and `data:type` is a legal attribute
      // name — so the tag read as a submit control and the token was skipped.
      const html = `<input data:type="submit" type="hidden" id="hdnCSRFToken" value="SECRET">`;
      const out = redactHtml(html, SUBS);
      expect(out).not.toContain("SECRET");
      expect(out).toContain('data:type="submit"');
      expect(() => assertNoCredentialFields(html)).toThrow(RedactionError);
    });

    it("strips Laravel's _token, which matches no exact name and contains no 'csrf'", () => {
      const html = `<input type="hidden" name="_token" value="SECRET">`;
      const out = redactHtml(html, SUBS);
      expect(out).not.toContain("SECRET");
      expect(() => assertNoCredentialFields(html)).toThrow(RedactionError);
    });

    it("strips every other framework's CSRF field convention", () => {
      for (const name of [
        "__RequestVerificationToken",
        "authenticity_token",
        "csrfmiddlewaretoken",
        "_csrf",
        "csrf_token",
      ]) {
        const html = `<input type="hidden" name="${name}" value="SECRET">`;
        expect(redactHtml(html, SUBS)).not.toContain("SECRET");
      }
    });

    it("handles single-quoted and unquoted values", () => {
      const sq = redactHtml(`<input id="csrf" value='sq>uote' />`, SUBS);
      expect(sq).not.toContain("sq>uote");
      const uq = redactHtml(`<div><input id="csrf" value=unquoted><span>x</span></div>`, SUBS);
      expect(uq).not.toContain("unquoted");
      expect(uq).toContain("<span>x</span>");
    });

    it("empties csrfEnabled too, and says why that is the right trade", () => {
      // Codex rated this an over-strip. It is deliberate: the blast radius is a HIDDEN field no
      // parser reads, in a test fixture. Erring toward stripping costs nothing here, while erring
      // the other way ships a token. Visible labels are the case that matters, and `type` covers it.
      expect(valueOf(redactHtml(`<input type="hidden" name="csrfEnabled" value="true">`, SUBS), 'input')).toBe("");
      expect(valueOf(redactHtml(`<input type="submit" name="csrfEnabled" value="Go">`, SUBS), 'input')).toBe("Go");
    });

    it("strips several credential fields in one document without corrupting offsets", () => {
      // The rewrite splices by parser-supplied span, so it must walk right-to-left.
      const html = `<form><input type="hidden" name="__VIEWSTATE" value="AAA"><p>keep</p><input type="hidden" id="hdnCSRFToken" value="BBB"><meta name="csrf-token" content="CCC"></form>`;
      const out = redactHtml(html, SUBS);
      expect(out).not.toMatch(/AAA|BBB|CCC/);
      expect(out).toContain("<p>keep</p>");
      expect(cheerio.load(out)("input").length).toBe(2);
    });
  });

  it("never lets a token reach the allow-list refusal report", () => {
    // The defect was not that a token leaked — the allow-list refuses it. It was that the token
    // arrived in the operator's refusal list looking like boilerplate, and the documented way to
    // clear a refusal is to commit the atom to the vocabulary. An emptied value reduces to an empty
    // SKELETON, so it is admitted silently and never reaches that list. (The surrounding `id`/`name`
    // attributes still get atomised like any other markup — that is unchanged and correct.)
    let refusals = "";
    try {
      redact(WEBFORMS, SUBS, { vocabulary: new Set<string>(), standIns: ["Dana Sample"] });
    } catch (error) {
      refusals = (error as Error).message;
    }
    expect(refusals).not.toBe("");
    expect(refusals).not.toContain("a1BcDeF23GhIjK45LmNoPqRsTuVwXyZ0AbCdEfG9");
    expect(refusals).not.toContain("s3cr3tT0k3nV4lu3");
    expect(refusals).not.toContain("wEPDwULLTE2MTY2ODcyMjlkZBYCZg9kFgICAw9kFgI");
  });

  it("fails closed if a credential field somehow still carries a value", () => {
    const smuggled = `<html><body><input type="hidden" id="hdnCSRFToken" value="stillhere"></body></html>`;
    expect(() => assertNoCredentialFields(smuggled)).toThrow(RedactionError);
  });
});
