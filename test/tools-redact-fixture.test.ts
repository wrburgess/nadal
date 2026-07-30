import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  RedactionError,
  assertRedacted,
  decodeEntities,
  redactHtml,
} from "../tools/redact-fixture.js";

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

function describeStructure(html: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    if (el.tagName === "script" || el.tagName === "style") return;
    out.push(`${el.tagName}.${el.attribs["class"] ?? ""}`);
  });
  return out;
}
