import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PolicyError,
  assertAllowListed,
  extractAtoms,
  loadVocabulary,
  requiresReview,
} from "../tools/fixture-policy.js";

/** A vocabulary is just a Set of skeletons for direct unit tests that don't need a file. */
function vocab(...skeletons: string[]): Set<string> {
  return new Set(skeletons);
}

const STAND_INS = ["Dana Sample", "Riverton, KS", "Stand-In Name"];

describe("extractAtoms", () => {
  it("finds text-node runs, attribute values and a comment nested deep in a table cell", () => {
    const html =
      "<table><tbody><tr><td>Dana Sample<!-- internal note --></td></tr></tbody></table>" +
      '<a href="/p?x=1">link</a>';
    const atoms = extractAtoms(html);

    expect(atoms.some((a) => a.kind === "text" && a.value.includes("Dana Sample"))).toBe(true);
    expect(atoms.some((a) => a.kind === "comment" && a.value.includes("internal note"))).toBe(
      true,
    );
    expect(atoms.some((a) => a.kind === "attribute" && a.attrName === "href")).toBe(true);
  });

  it("gives each atom a locating DOM path and its node kind", () => {
    const html = "<div><p>hello</p></div>";
    const atoms = extractAtoms(html);
    const textAtom = atoms.find((a) => a.kind === "text" && a.value.includes("hello"));

    expect(textAtom).toBeDefined();
    expect(textAtom?.path).toContain("p");
    expect(textAtom?.kind).toBe("text");
  });

  it("yields no atom for a NUMERIC/GEOMETRIC/ENUMERATED structural attribute name", () => {
    const html =
      '<svg viewBox="0 0 10 10" d="M0 0 L10 10" width="10" height="10" fill="#fff" ' +
      'stroke="#000" points="0,0 1,1" transform="translate(1,1)" preserveAspectRatio="none" ' +
      'focusable="false" xmlns="http://www.w3.org/2000/svg"></svg>' +
      '<table><td colspan="2" rowspan="1"></td></table><input type="text" role="button">';
    const atoms = extractAtoms(html);

    expect(atoms.filter((a) => a.kind === "attribute")).toHaveLength(0);
  });
});

describe("extractAtoms — free-form attribute values are NOT exempt (issue #28 finding 2 fix)", () => {
  // aria-*/id/class/style/data-v-* used to be exempt from atomisation by NAME alone, so a
  // free-form, author-chosen string in any of them survived redaction, produced no atom, and was
  // never checked against the vocabulary — an uninspected publication surface exposed to assistive
  // technology (aria-*) or simply human-authored (id/class/style/data-v-*).
  it("creates an atom for aria-label", () => {
    const atoms = extractAtoms('<button aria-label="Patrick Turner">x</button>');
    expect(
      atoms.some((a) => a.kind === "attribute" && a.attrName === "aria-label"),
    ).toBe(true);
  });

  it("creates an atom for id", () => {
    const atoms = extractAtoms('<div id="Patrick Turner"></div>');
    expect(atoms.some((a) => a.kind === "attribute" && a.attrName === "id")).toBe(true);
  });

  it("creates an atom for class", () => {
    const atoms = extractAtoms('<div class="Patrick Turner"></div>');
    expect(atoms.some((a) => a.kind === "attribute" && a.attrName === "class")).toBe(true);
  });

  it("creates an atom for style", () => {
    const atoms = extractAtoms('<div style="Patrick Turner"></div>');
    expect(atoms.some((a) => a.kind === "attribute" && a.attrName === "style")).toBe(true);
  });

  it("creates an atom for data-v-*", () => {
    const atoms = extractAtoms('<div data-v-abc123="Patrick Turner"></div>');
    expect(
      atoms.some((a) => a.kind === "attribute" && a.attrName === "data-v-abc123"),
    ).toBe(true);
  });

  it("REFUSES the capture when an unlisted name sits in aria-label", () => {
    expect(() =>
      assertAllowListed('<button aria-label="Patrick Turner">x</button>', {
        standIns: [],
        vocabulary: vocab(),
      }),
    ).toThrow(PolicyError);
  });

  it("REFUSES the capture when an unlisted name sits in id", () => {
    expect(() =>
      assertAllowListed('<div id="Patrick Turner"></div>', { standIns: [], vocabulary: vocab() }),
    ).toThrow(PolicyError);
  });

  it("REFUSES the capture when an unlisted name sits in class", () => {
    expect(() =>
      assertAllowListed('<div class="Patrick Turner"></div>', {
        standIns: [],
        vocabulary: vocab(),
      }),
    ).toThrow(PolicyError);
  });
});

describe("extractAtoms — script/style elements (issue #28 finding 2 fix)", () => {
  // domhandler types a <script>/<style> element's node.type as "script"/"style", NOT "tag" — the
  // exact input that proved the old `node.type === "tag"` tagName guard was dead code.
  const html =
    '<script src="/u/john.smith/tracker.js" data-user="Ellen Ripley"></script>' +
    '<style data-owner="Ellen Ripley">.x{}</style><p>ok</p>';

  it("creates an attribute atom for a <script src> and a <script data-user>", () => {
    const atoms = extractAtoms(html);
    const attrAtoms = atoms.filter((a) => a.kind === "attribute");

    expect(
      attrAtoms.some((a) => a.attrName === "src" && a.value === "/u/john.smith/tracker.js"),
    ).toBe(true);
    expect(
      attrAtoms.some((a) => a.attrName === "data-user" && a.value === "Ellen Ripley"),
    ).toBe(true);
  });

  it("creates an attribute atom for a <style data-owner>", () => {
    const atoms = extractAtoms(html);

    expect(
      atoms.some(
        (a) => a.kind === "attribute" && a.attrName === "data-owner" && a.value === "Ellen Ripley",
      ),
    ).toBe(true);
  });

  it("still walks past script/style to atomise a later sibling", () => {
    const atoms = extractAtoms(html);

    expect(atoms.some((a) => a.kind === "text" && a.value === "ok")).toBe(true);
  });

  it("REFUSES the capture when an unclassified identity sits in a script src", () => {
    expect(() =>
      assertAllowListed(html, { standIns: [], vocabulary: vocab() }),
    ).toThrow(PolicyError);
  });
});

describe("extractAtoms — script/style TEXT bodies (issue #28 finding 1 fix)", () => {
  // redactHtml's SCRIPT_OR_STYLE regex only strips PAIRED script/style tags
  // (`/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi`). A truncated/malformed capture like
  // `<script>Patrick Turner` (no closing tag) never matches that pattern, so its body survives
  // redaction untouched. The old `extractAtoms` unconditionally skipped script/style CHILDREN on
  // the theory that redaction had already emptied them — which made this exact input produce NO
  // atom at all, a silent bypass of the allow-list. Atomising the text body instead costs nothing
  // for well-formed input (a paired, already-stripped `<script></script>` has no children to
  // atomise) and closes the hole for malformed input.
  it("REFUSES an unclosed <script> body reaching the end of the document", () => {
    expect(() =>
      assertAllowListed("<script>Patrick Turner", { standIns: [], vocabulary: vocab() }),
    ).toThrow(PolicyError);
  });

  it("REFUSES an unclosed <style> body reaching the end of the document", () => {
    expect(() =>
      assertAllowListed("<style>Patrick Turner", { standIns: [], vocabulary: vocab() }),
    ).toThrow(PolicyError);
  });

  it("admits a PAIRED <script>...</script> whose body was already stripped empty, with no atom flood", () => {
    const strippedHtml = "<script></script><style></style><p></p>";
    const atoms = extractAtoms(strippedHtml);

    expect(atoms).toHaveLength(0);
    expect(() =>
      assertAllowListed(strippedHtml, { standIns: [], vocabulary: vocab() }),
    ).not.toThrow();
  });
});

describe("assertAllowListed - structural values admitted", () => {
  it.each([
    ["integer", "<p>42</p>"],
    ["decimal", "<p>4.02</p>"],
    ["US date", "<p>1/15/2026</p>"],
    ["set score with match tiebreak", "<p>6-4, 6-2 (10-8)</p>"],
    ["hex colour", "<p>#a1b2c3</p>"],
    ["SVG path data", '<p title="m4.8 7.8 0.57232-0.58292"></p>'],
  ])("admits a %s atom", (_label, html) => {
    expect(() =>
      assertAllowListed(html, { standIns: STAND_INS, vocabulary: vocab() }),
    ).not.toThrow();
  });

  it("admits an atom that is exactly a synthetic stand-in", () => {
    expect(() =>
      assertAllowListed("<p>Dana Sample</p>", { standIns: STAND_INS, vocabulary: vocab() }),
    ).not.toThrow();
  });

  it("admits a synthetic+structural composite with an EMPTY skeleton", () => {
    expect(() =>
      assertAllowListed("<p>Stand-In Name (4.02)</p>", {
        standIns: STAND_INS,
        vocabulary: vocab(),
      }),
    ).not.toThrow();
  });

  it("admits punctuation-only and whitespace-only atoms", () => {
    expect(() =>
      assertAllowListed("<p>--- , ; :</p><p>   </p>", {
        standIns: STAND_INS,
        vocabulary: vocab(),
      }),
    ).not.toThrow();
  });

  it("negative control: a page whose every atom classifies raises nothing", () => {
    const html =
      '<div class="profile" data-owner="Dana Sample">' +
      "<h3>Dana Sample</h3>" +
      '<p title="6-4, 6-2 (10-8)">42</p>' +
      '<a href="/p.aspx?playername=Dana%20Sample"></a>' +
      "</div>";
    expect(() =>
      assertAllowListed(html, {
        // "profile" is now a real atom (class is no longer exempt by name — issue #28 finding 2),
        // so it needs its own vocabulary entry alongside the pre-existing href skeleton. "owner" is
        // the data-* PREFIX REMAINDER of `data-owner` (round-2 finding R2-2: attribute names are
        // atomised too), a single token so it needs no "# reviewed:" justification of its own.
        standIns: STAND_INS,
        vocabulary: vocab("p aspx playername", "profile", "owner"),
      }),
    ).not.toThrow();
  });
});

describe("word-boundary elision", () => {
  it("elides a stand-in on word boundaries only, so a real 'Leeson' is REFUSED", () => {
    // If elision were substring-based rather than word-boundary-anchored, "Lee" would blank the
    // middle of "Leeson" and leave "son" — a different (and wrong) reason for this to pass.
    const html = "<p>Cross-examined by attorney Leeson at the hearing</p>";
    expect(() => assertAllowListed(html, { standIns: ["Lee"], vocabulary: vocab() })).toThrow(
      PolicyError,
    );
  });
});

describe("unlisted real identities are refused", () => {
  it("in a TEXT NODE", () => {
    expect(() =>
      assertAllowListed("<p>Patrick Turner</p>", { standIns: STAND_INS, vocabulary: vocab() }),
    ).toThrow(PolicyError);
  });

  it("in an ATTRIBUTE VALUE", () => {
    expect(() =>
      assertAllowListed('<a title="Patrick Turner">x</a>', {
        standIns: STAND_INS,
        vocabulary: vocab(),
      }),
    ).toThrow(PolicyError);
  });

  it("in a COMMENT BODY", () => {
    expect(() =>
      assertAllowListed("<div><!-- Patrick Turner --></div>", {
        standIns: STAND_INS,
        vocabulary: vocab(),
      }),
    ).toThrow(PolicyError);
  });

  it("spelled with a NUMERIC CHARACTER REFERENCE", () => {
    expect(() =>
      assertAllowListed("<p>Patrick&#32;Turner</p>", {
        standIns: STAND_INS,
        vocabulary: vocab(),
      }),
    ).toThrow(PolicyError);
  });

  it("spelled with a NAMED ENTITY separator (&NewLine;)", () => {
    expect(() =>
      assertAllowListed("<p>Patrick&NewLine;Turner</p>", {
        standIns: STAND_INS,
        vocabulary: vocab(),
      }),
    ).toThrow(PolicyError);
  });

  it("split by a ZERO-WIDTH character", () => {
    expect(() =>
      assertAllowListed("<p>Patrick&ZeroWidthSpace;Turner</p>", {
        standIns: STAND_INS,
        vocabulary: vocab(),
      }),
    ).toThrow(PolicyError);
  });

  it("in NFD against an NFC vocabulary, and the reverse direction", () => {
    // "José Ramirez" written two ways: composed (U+00E9) and decomposed (e + U+0301).
    // Identical to every reader, different code-point sequences to a naive matcher. Neither
    // spelling is in the (empty) vocabulary, so both must refuse.
    const composed = "Jos\u00e9 Ramirez";
    const decomposed = "Jose\u0301 Ramirez";

    expect(() =>
      assertAllowListed(`<p>${decomposed}</p>`, {
        standIns: STAND_INS,
        vocabulary: vocab(),
      }),
    ).toThrow(PolicyError);

    expect(() =>
      assertAllowListed(`<p>${composed}</p>`, { standIns: STAND_INS, vocabulary: vocab() }),
    ).toThrow(PolicyError);
  });

  it("PERCENT-ENCODED inside an href", () => {
    expect(() =>
      assertAllowListed('<a href="/p?playername=Patrick%20Turner">x</a>', {
        standIns: STAND_INS,
        vocabulary: vocab(),
      }),
    ).toThrow(PolicyError);
  });
});

describe("vocabulary entry normalisation matches on both sides", () => {
  it("a vocabulary entry written in NFD matches an NFC page atom", () => {
    const composed = "Jos\u00e9 Ramirez"; // NFC, as it appears on the page
    const decomposedEntry = "Jose\u0301 Ramirez"; // NFD, as committed to the vocabulary file

    expect(() =>
      assertAllowListed(`<p>${composed}</p>`, {
        standIns: STAND_INS,
        vocabulary: vocab(decomposedEntry),
      }),
    ).not.toThrow();
  });
});

describe("PolicyError reporting", () => {
  it("reports EVERY unclassified atom, not only the first", () => {
    const html = "<p>Patrick Turner</p><p>Casey Fields</p>";
    try {
      assertAllowListed(html, { standIns: STAND_INS, vocabulary: vocab() });
      throw new Error("expected assertAllowListed to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyError);
      const violations = (err as PolicyError).violations;
      expect(violations.length).toBeGreaterThanOrEqual(2);
      expect(violations.some((v) => v.skeleton.includes("Patrick"))).toBe(true);
      expect(violations.some((v) => v.skeleton.includes("Casey"))).toBe(true);
    }
  });
});

describe("loadVocabulary", () => {
  const dirs: string[] = [];
  function tempVocabFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "fixture-vocab-"));
    dirs.push(dir);
    const path = join(dir, "vocab.txt");
    writeFileSync(path, content);
    return path;
  }

  afterEach(() => {
    dirs.length = 0;
  });

  it("loads one skeleton per line, ignoring # comments", () => {
    // A single-token skeleton, deliberately: a multi-token one now requires a preceding
    // "# reviewed:" line (round-2 finding R2-3), which is a separate test below.
    const path = tempVocabFile(["# a comment", "playername", "", "42"].join("\n"));
    const loaded = loadVocabulary(path);

    expect(loaded.has("playername")).toBe(true);
    expect(loaded.has("42")).toBe(true);
    expect(loaded.size).toBe(2);
  });

  it("rejects a duplicate vocabulary entry", () => {
    const path = tempVocabFile(["playername", "playername"].join("\n"));

    expect(() => loadVocabulary(path)).toThrow(/duplicate/i);
  });

  it("fails to load a name-shaped entry without a preceding # reviewed: line", () => {
    const path = tempVocabFile(["Dana Sample"].join("\n"));

    expect(() => loadVocabulary(path)).toThrow(/reviewed/i);
  });

  it("loads a name-shaped entry WITH a preceding # reviewed: line", () => {
    const path = tempVocabFile(
      ["# reviewed: synthetic stand-in, safe to publish", "Dana Sample"].join("\n"),
    );

    expect(() => loadVocabulary(path)).not.toThrow();
    expect(loadVocabulary(path).has("Dana Sample")).toBe(true);
  });

  it("rejects a vocabulary entry containing an email address outright", () => {
    const path = tempVocabFile(["real.person@example.com"].join("\n"));

    expect(() => loadVocabulary(path)).toThrow();
  });

  it("rejects a vocabulary entry containing a phone number outright", () => {
    const path = tempVocabFile(["816 555 1234"].join("\n"));

    expect(() => loadVocabulary(path)).toThrow();
  });

  it("rejects a vocabulary entry containing a street address outright", () => {
    const path = tempVocabFile(["1234 Maple Street"].join("\n"));

    expect(() => loadVocabulary(path)).toThrow();
  });

  it("rejects a malformed vocabulary file (a # reviewed: line covers only the entry right after it)", () => {
    const path = tempVocabFile(
      ["# reviewed: covers only the next line", "Dana Sample", "Casey Fields"].join("\n"),
    );

    expect(() => loadVocabulary(path)).toThrow(/reviewed/i);
  });
});

describe("loadVocabulary — synthetic-class enforcement (issue #28 fix)", () => {
  const dirs: string[] = [];
  // Deliberately NOT named with "synthetic" anywhere in the prefix: loadVocabulary's error
  // messages interpolate the file path, so a tempdir prefix containing that word would let a
  // `/synthetic/i` assertion below pass by coincidentally matching the PATH rather than the
  // error's actual claim — the exact "unverifiable check" failure mode this fix exists to close.
  function tempVocabFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "fixture-vocab-marker-"));
    dirs.push(dir);
    const path = join(dir, "vocab.txt");
    writeFileSync(path, content);
    return path;
  }

  afterEach(() => {
    dirs.length = 0;
  });

  it("fails to load a synthetic-classed entry whose capitalised token is ABSENT from stand-ins.txt", () => {
    const path = tempVocabFile(
      ["# reviewed[synthetic]: invented stand-in club/location name", "Riverdale Sample"].join(
        "\n",
      ),
    );

    // "Riverdale" is not backed by any committed stand-in, so the claim "synthetic" is
    // unenforceable and loadVocabulary must refuse rather than trust the prose.
    expect(() => loadVocabulary(path, ["Dana Sample"])).toThrow(/not present in stand-ins/i);
  });

  it("loads the SAME entry once its capitalised token is PRESENT in stand-ins.txt", () => {
    const path = tempVocabFile(
      ["# reviewed[synthetic]: invented stand-in club/location name", "Riverdale Sample"].join(
        "\n",
      ),
    );

    expect(() => loadVocabulary(path, ["Riverdale Sample"])).not.toThrow();
    expect(loadVocabulary(path, ["Riverdale Sample"]).has("Riverdale Sample")).toBe(true);
  });

  it("fails when only SOME of a synthetic-classed entry's capitalised tokens are backed", () => {
    const path = tempVocabFile(
      ["# reviewed[synthetic]: invented stand-in club/location name", "Riverdale Country Club"].join(
        "\n",
      ),
    );

    // "Riverdale" is backed; "Country" and "Club" are not — one matching token must not launder
    // the whole entry into the enforced class.
    expect(() => loadVocabulary(path, ["Riverdale Sample"])).toThrow(/not present in stand-ins/i);
  });

  it("FAILS a token-spliced entry: 'Avery Ashcroft' backed only by 'Avery Ashby' + 'Arden Ashcroft' (issue #28 finding 3)", () => {
    // The committed register has "Avery Ashby" and "Arden Ashcroft" as SEPARATE full stand-ins.
    // The old check verified each capitalised token independently, so "Avery" (from "Avery
    // Ashby") and "Ashcroft" (from "Arden Ashcroft") each matched SOME token somewhere and the
    // spliced full name "Avery Ashcroft" — which is in NO stand-in — passed as "synthetic". The
    // fix must require the WHOLE entry to reduce to an empty skeleton once full stand-in PHRASES
    // are elided at word boundaries, which "Avery Ashcroft" cannot do against either phrase.
    const path = tempVocabFile(
      ["# reviewed[synthetic]: invented stand-in — token-spliced probe", "Avery Ashcroft"].join(
        "\n",
      ),
    );

    expect(() => loadVocabulary(path, ["Avery Ashby", "Arden Ashcroft"])).toThrow(
      /not present in stand-ins/i,
    );
  });

  it("loads a synthetic entry that IS a full committed stand-in phrase", () => {
    const path = tempVocabFile(
      ["# reviewed[synthetic]: invented stand-in", "Avery Ashby"].join("\n"),
    );

    expect(() => loadVocabulary(path, ["Avery Ashby", "Arden Ashcroft"])).not.toThrow();
    expect(loadVocabulary(path, ["Avery Ashby", "Arden Ashcroft"]).has("Avery Ashby")).toBe(true);
  });

  it("loads a synthetic entry combining TWO full stand-in phrases plus punctuation/numbers", () => {
    const path = tempVocabFile(
      [
        "# reviewed[synthetic]: two invented stand-ins composited, plus structural content",
        "Avery Ashby, Arden Ashcroft - 6-4 6-2 (2026)",
      ].join("\n"),
    );

    expect(() => loadVocabulary(path, ["Avery Ashby", "Arden Ashcroft"])).not.toThrow();
  });

  it("loads a real/public-classed entry without needing ANY stand-ins backing", () => {
    const path = tempVocabFile(
      [
        "# reviewed: a real, publicly-known place name — not identifying to any individual.",
        "Riverdale Country Club",
      ].join("\n"),
    );

    expect(() => loadVocabulary(path, [])).not.toThrow();
    expect(loadVocabulary(path, []).has("Riverdale Country Club")).toBe(true);
  });
});

describe("whole-document accounting (issue #28 round 2 findings R2-1/R2-2/R2-3)", () => {
  describe("R2-1: xmlns/fill/stroke are exempt only for a CLOSED value grammar", () => {
    it("REFUSES an svg whose xmlns value carries an identity", () => {
      expect(() =>
        assertAllowListed('<svg xmlns="https://example.test/Patrick-Turner"></svg>', {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });

    it("REFUSES a fill value that is a url() paint reference carrying an identity", () => {
      expect(() =>
        assertAllowListed('<path fill="url(https://example.test/Patrick-Turner)"></path>', {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });

    it.each([["#ff0000"], ["none"], ["currentColor"]])(
      "admits fill=\"%s\" without a vocabulary entry",
      (value) => {
        expect(() =>
          assertAllowListed(`<path fill="${value}"></path>`, {
            standIns: [],
            vocabulary: vocab(),
          }),
        ).not.toThrow();
      },
    );

    it("admits the standard SVG xmlns value without a vocabulary entry", () => {
      expect(() =>
        assertAllowListed('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).not.toThrow();
    });
  });

  describe("R2-2: element names and attribute names are atomised", () => {
    it("REFUSES an unlisted, non-standard ELEMENT name", () => {
      expect(() =>
        assertAllowListed("<patrick-turner></patrick-turner>", {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });

    it("REFUSES an unlisted data-* ATTRIBUTE name with an EMPTY value", () => {
      // The value is deliberately empty so this cannot pass because of a checked value — only the
      // NAME channel can be catching it.
      expect(() =>
        assertAllowListed("<div data-patrick-turner></div>", {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });

    it("REFUSES an unlisted, non-data ATTRIBUTE name", () => {
      expect(() =>
        assertAllowListed('<div patrick-turner="x"></div>', {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });

    it("admits a standard element with a standard, allow-listed attribute name/value", () => {
      expect(() =>
        assertAllowListed('<div class="wrapper"></div>', {
          standIns: [],
          vocabulary: vocab("wrapper"),
        }),
      ).not.toThrow();
    });

    it("creates an element-name atom for a non-standard tag", () => {
      const atoms = extractAtoms("<patrick-turner></patrick-turner>");
      expect(
        atoms.some((a) => a.kind === "element-name" && a.value === "patrick-turner"),
      ).toBe(true);
    });

    it("creates an attribute-name atom carrying only the REMAINDER after the data- prefix", () => {
      const atoms = extractAtoms('<div data-patrick-turner=""></div>');
      const nameAtom = atoms.find((a) => a.kind === "attribute-name");
      expect(nameAtom?.value).toBe("patrick-turner");
    });

    it("does not flag a standard element/attribute pair at all", () => {
      const atoms = extractAtoms('<div class="x" id="y"><span>ok</span></div>');
      expect(atoms.some((a) => a.kind === "element-name")).toBe(false);
      expect(atoms.some((a) => a.kind === "attribute-name")).toBe(false);
    });
  });

  describe("R2-3: requiresReview is Unicode-aware and case-independent", () => {
    it("returns true for a lowercase multi-token alphabetic skeleton", () => {
      expect(requiresReview("patrick turner")).toBe(true);
    });

    it("returns true for a non-ASCII multi-token alphabetic skeleton", () => {
      expect(requiresReview("josé garcía")).toBe(true);
    });

    it("returns false for a single token", () => {
      expect(requiresReview("wrapper")).toBe(false);
    });

    it("REFUSES loading a lowercase name-shaped vocabulary entry with no justification", () => {
      const dir = mkdtempSync(join(tmpdir(), "fixture-vocab-r2-"));
      const path = join(dir, "vocab.txt");
      writeFileSync(path, "patrick turner\n");

      expect(() => loadVocabulary(path)).toThrow(/reviewed/i);
    });

    it("REFUSES loading a non-ASCII name-shaped vocabulary entry with no justification", () => {
      const dir = mkdtempSync(join(tmpdir(), "fixture-vocab-r2-"));
      const path = join(dir, "vocab.txt");
      writeFileSync(path, "josé garcía\n");

      expect(() => loadVocabulary(path)).toThrow(/reviewed/i);
    });

    it("loads a lowercase name-shaped entry once justified", () => {
      const dir = mkdtempSync(join(tmpdir(), "fixture-vocab-r2-"));
      const path = join(dir, "vocab.txt");
      writeFileSync(path, "# reviewed: a real, public place — not identifying.\npatrick turner\n");

      expect(() => loadVocabulary(path)).not.toThrow();
    });
  });

  describe("directive content (doctype)", () => {
    it("admits a standard <!DOCTYPE html>", () => {
      expect(() =>
        assertAllowListed("<!DOCTYPE html><html><body></body></html>", {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).not.toThrow();
    });

    it("REFUSES a doctype carrying an identity", () => {
      expect(() =>
        assertAllowListed("<!DOCTYPE Patrick Turner><html><body></body></html>", {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });
  });

  describe("CDATA content", () => {
    it("REFUSES CDATA carrying an identity", () => {
      expect(() =>
        assertAllowListed("<svg><![CDATA[Patrick Turner]]></svg>", {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });
  });

  describe("parser-discarded bytes (issue #28 round-3 finding R3-1)", () => {
    // `redactHtml` writes the RAW string; the policy used to inspect only cheerio's RECOVERED DOM.
    // Where the parser recovers from malformed markup, those are two different documents, and an
    // identity discarded by the parser reached no atom at all.
    it("REFUSES the reviewer's exact repro: an orphan end tag between two real nodes", () => {
      expect(() =>
        assertAllowListed("<div></Patrick Turner>", { standIns: [], vocabulary: vocab() }),
      ).toThrow(PolicyError);
    });

    it("creates a parser-discarded atom for the orphan end tag", () => {
      const atoms = extractAtoms("<div></Patrick Turner>");
      expect(
        atoms.some(
          (a) => a.kind === "parser-discarded" && a.value.includes("Patrick Turner"),
        ),
      ).toBe(true);
    });

    it("REFUSES an orphan end tag carrying an identity MID-TEXT, not only at top level", () => {
      // The HTML5 tree builder merges the surrounding character-data runs into ONE text node
      // ("helloworld") whose location spans the orphan token's bytes too, even though `.data`
      // does not contain them — a gap-complement check alone would miss this shape.
      expect(() =>
        assertAllowListed("<p>hello</Patrick Turner>world</p>", {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });

    it("does not refuse well-formed markup with no parser recovery involved", () => {
      // "42" is purely structural (an atom that reduces to an empty skeleton), so this exercises
      // parser-recovery accounting without also depending on an unrelated vocabulary entry.
      expect(() =>
        assertAllowListed("<!DOCTYPE html><html><body><p>42</p></body></html>", {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).not.toThrow();
    });

    it("does not flag every seven committed fixtures with a spurious parser-discarded atom", () => {
      // Regression guard for the false positives found while building this fix: real captured
      // markup with a duplicated/overlapping trailing-whitespace text node after </body>, and a
      // malformed (but non-identity-bearing) unquoted-into-quoted attribute run, both produced
      // zero parser-discarded atoms once the fix correctly cross-checks against every OTHER node's
      // real start/end tag location before flagging an orphan.
      const files = [
        "test/fixtures/tennisrecord/match-history-empty.html",
        "test/fixtures/tennisrecord/match-history.html",
        "test/fixtures/tennisrecord/player-stats.html",
        "test/fixtures/tennisrecord/profile.html",
        "test/fixtures/tennisrecord/team.html",
        "test/fixtures/usta/profile-wtn-both.html",
        "test/fixtures/usta/profile-wtn-doubles-only.html",
      ];
      for (const file of files) {
        const html = readFileSync(file, "utf8");
        const atoms = extractAtoms(html);
        expect(atoms.filter((a) => a.kind === "parser-discarded")).toEqual([]);
      }
    });
  });

  describe("closed value grammars for structural attributes (issue #28 round-3 finding R3-2)", () => {
    // Round 2 removed xmlns/fill/stroke from name-only exemption but left the rest exempt by
    // NAME alone — the same mistake the round-2 fix was supposed to have retired as a PRINCIPLE,
    // reapplied only to the three attributes that round happened to name. With an empty
    // vocabulary, every structural attribute below must now ATOMISE (and therefore refuse) a
    // value outside its closed grammar, and ADMIT a value inside it.
    describe("refuses a value outside the grammar", () => {
      it.each([
        ["d", '<path d="Patrick Turner"></path>'],
        ["points", '<polygon points="Patrick Turner"></polygon>'],
        ["viewBox", '<svg viewBox="Patrick Turner"></svg>'],
        ["width", '<img width="Patrick Turner">'],
        ["height", '<img height="Patrick Turner">'],
        ["colspan", '<table><td colspan="Patrick Turner"></td></table>'],
        ["rowspan", '<table><td rowspan="Patrick Turner"></td></table>'],
        ["transform", '<path transform="Patrick Turner"></path>'],
        ["role", '<div role="Patrick Turner"></div>'],
        ["type", '<input type="Patrick Turner">'],
        ["preserveAspectRatio", '<svg preserveAspectRatio="Patrick Turner"></svg>'],
        ["focusable", '<svg focusable="Patrick Turner"></svg>'],
      ])("%s", (_attr, html) => {
        expect(() => assertAllowListed(html, { standIns: [], vocabulary: vocab() })).toThrow(
          PolicyError,
        );
      });
    });

    describe("admits a legitimate value inside the grammar, with no vocabulary entry", () => {
      it.each([
        ["d (real path data)", '<path d="M0 0 L10 10 Z"></path>'],
        ["points (real point list)", '<polygon points="0,0 1,1 2,0"></polygon>'],
        ["viewBox (4 numbers)", '<svg viewBox="0 0 24 24"></svg>'],
        ["width (bare number)", '<img width="120">'],
        ["width (percentage)", '<img width="100%">'],
        ["height (px unit)", '<img height="24px">'],
        ["colspan (integer)", '<table><td colspan="2"></td></table>'],
        ["rowspan (integer)", '<table><td rowspan="1"></td></table>'],
        ["transform (real transform)", '<path transform="translate(1,1) rotate(45)"></path>'],
        ["role (aria role)", '<div role="navigation"></div>'],
        ["type (input type)", '<input type="checkbox">'],
        ["preserveAspectRatio (token)", '<svg preserveAspectRatio="xMidYMid meet"></svg>'],
        ["focusable (true)", '<svg focusable="true"></svg>'],
      ])("%s", (_label, html) => {
        expect(() =>
          assertAllowListed(html, { standIns: [], vocabulary: vocab() }),
        ).not.toThrow();
      });
    });

    it("still yields zero attribute atoms for the full legitimate-value fixture (regression guard)", () => {
      const html =
        '<svg viewBox="0 0 10 10" d="M0 0 L10 10" width="10" height="10" fill="#fff" ' +
        'stroke="#000" points="0,0 1,1" transform="translate(1,1)" preserveAspectRatio="none" ' +
        'focusable="false" xmlns="http://www.w3.org/2000/svg"></svg>' +
        '<table><td colspan="2" rowspan="1"></td></table><input type="text" role="button">';
      const atoms = extractAtoms(html);

      expect(atoms.filter((a) => a.kind === "attribute")).toHaveLength(0);
    });
  });

  describe("capture-level: neither output nor provenance is written when a structural channel refuses", () => {
    it("an identity in an ELEMENT NAME refuses assertAllowListed outright", () => {
      expect(() =>
        assertAllowListed("<div><patrick-turner></patrick-turner></div>", {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });

    it("an identity in an ATTRIBUTE NAME refuses assertAllowListed outright", () => {
      expect(() =>
        assertAllowListed('<div data-patrick-turner=""></div>', {
          standIns: [],
          vocabulary: vocab(),
        }),
      ).toThrow(PolicyError);
    });
  });
});
