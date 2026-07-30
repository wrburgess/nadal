import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PolicyError,
  assertAllowListed,
  extractAtoms,
  loadVocabulary,
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

  it("yields no atom for a structural attribute name", () => {
    const html =
      '<div class="profile" id="x" style="color:red" aria-hidden="true">' +
      '<svg viewBox="0 0 10 10" d="M0 0 L10 10"></svg></div>';
    const atoms = extractAtoms(html);

    expect(atoms.filter((a) => a.kind === "attribute")).toHaveLength(0);
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

  it("does NOT atomise the style body text — redaction already strips it", () => {
    const atoms = extractAtoms(html);

    expect(atoms.some((a) => a.value.includes(".x{}"))).toBe(false);
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
        standIns: STAND_INS,
        vocabulary: vocab("p aspx playername"),
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
    const path = tempVocabFile(["# a comment", "p aspx playername", "", "42"].join("\n"));
    const loaded = loadVocabulary(path);

    expect(loaded.has("p aspx playername")).toBe(true);
    expect(loaded.has("42")).toBe(true);
    expect(loaded.size).toBe(2);
  });

  it("rejects a duplicate vocabulary entry", () => {
    const path = tempVocabFile(["p aspx playername", "p aspx playername"].join("\n"));

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
