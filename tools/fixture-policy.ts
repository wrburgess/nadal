/**
 * The fixture allow-list policy — the inversion of `tools/redact-fixture.ts`'s blacklist.
 *
 * `redact-fixture.ts` substitutes every identity someone remembered to list, then sweeps the
 * result for the identity CLASSES it knows how to recognise (a structural detector per source, a
 * five-class never-publish sweep). Both are still a blacklist: content nobody thought to name
 * ships by default. An independent reviewer ruled that unacceptable for a public repository (PR
 * #26, round 12).
 *
 * This module runs AFTER substitution, over the already-redacted output, and inverts the
 * boundary: every content ATOM — a normalised text-node run, a comment body, or a non-structural
 * attribute value — must reduce to an empty SKELETON or one already committed to a per-source
 * VOCABULARY file. Anything else REFUSES the capture outright; nothing is written.
 *
 * The reduction ladder, in order:
 *
 *  1. An attribute whose NAME is numeric, geometric, or enumerated by the HTML/SVG spec (d,
 *     viewBox, width, height, colspan, role, type, …) is admitted without its value ever being
 *     inspected — `extractAtoms` never creates an atom for one. A free-form, author-chosen
 *     attribute (class, id, style, aria-*, data-v-*, …) is NOT exempt — its value is atomised like
 *     any other content, since it is exactly the kind of human-authored string this policy exists
 *     to check (issue #28 finding 2).
 *  2. The atom is normalised through `normalizeForComparison` in `tools/redact-fixture.ts` — the
 *     SAME pipeline the existing survivor sweeps use, so this is not a second, subtly different
 *     normaliser (see that module's docstring on why that would be a bypass).
 *  3. Every synthetic stand-in is elided, anchored at WORD BOUNDARIES, so a stand-in "Lee" does
 *     not blank the middle of a real "Leeson".
 *  4. Every structural run (integers, decimals, US dates, set scores including match-tiebreak
 *     notation, hex colours, SVG path data) is elided.
 *  5. What remains has its punctuation and whitespace collapsed to produce the SKELETON.
 *  6. An empty skeleton is admitted — the atom was purely synthetic and/or structural.
 *  7. A skeleton already present in the vocabulary is admitted.
 *  8. Otherwise the atom REFUSES the capture, reporting every unclassified atom (not only the
 *     first) with its skeleton, node kind and locating DOM path.
 *
 * KNOWN LIMITATION — bare digit runs of ANY length are admitted structurally (step 4's trailing
 * `\b\d+\b` pattern), with no length cap: `computeSkeleton("8165551234", [])` and
 * `computeSkeleton("99999", [])` both reduce to the empty string, same as a two-digit set score.
 * This is deliberate, not an oversight — TennisRecord match ids and SVG path coordinates are
 * legitimate long numeric runs that a real capture must be able to admit, and refusing every long
 * digit run would break real fixtures rather than protect anyone. The practical consequence: this
 * allow-list policy does NOT constrain numeric identifiers (phone numbers, USTA uaids, ITF
 * tennis-ids, match ids) at all — a page could carry an unlisted phone number or id and this
 * module alone would admit it. Those classes are covered by OTHER layers, not this one:
 * `tools/redact-fixture.ts`'s `assertNoUnlistedPii` independently forbids phone numbers (and
 * email addresses, mailto/tel links, street addresses), and the source-specific structural
 * detector sweeps (`DETECTOR_SETS` in `tools/capture-fixture.ts`, e.g. `uaid`, `tennis-id`) cover
 * USTA/ITF identifiers. Do not read "the allow-list policy passed" as "no numeric identifier is
 * present" — read it as "no NON-numeric unclassified content is present"; the numeric-identifier
 * guarantee, such as it is, comes from those other two layers.
 */

import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
// Deliberately circular with tools/redact-fixture.ts: `redact()` there calls `assertAllowListed`
// here (task 9), and this module reuses that module's normalisation helpers rather than
// re-deriving them (see this module's docstring). Both edges are FUNCTION references used only
// inside function bodies — never at module-top-level evaluation — which is what makes the cycle
// safe under Node's ESM loader. `PolicyError` deliberately does NOT extend `RedactionError`: a
// `class X extends Y` reference is evaluated immediately at module load, and doing that across
// this cycle throws "Class extends value undefined" depending on which side of the cycle loads
// first.
import { assertNoUnlistedPii, escapeRegExp, nfc, normalizeForComparison } from "./redact-fixture.js";

export type AtomKind = "text" | "attribute" | "comment";

/** One content atom: a normalised text-node run, a comment body, or a non-structural attribute. */
export type Atom = {
  kind: AtomKind;
  value: string;
  path: string;
  attrName?: string;
};

/**
 * Attribute NAMES the parser reads structurally — their VALUE is never inspected, whatever it is.
 *
 * The line is principled, not convenient: exempt ONLY attributes whose values are numeric,
 * geometric, or enumerated by the HTML/SVG spec — never an attribute whose value is a free-form,
 * author-chosen string. `class`, `id`, `style`, every `aria-*`, and every `data-v-*` used to be
 * exempt by NAME alone, which let a human-readable value like `aria-label="Patrick Turner"`
 * survive redaction with no atom and no allow-list check at all (issue #28 finding 2) — ARIA
 * labels are content exposed to assistive technology, and `id`/`class`/`style` are author-chosen
 * free-form strings, not fixed vocabularies. Those are now atomised like any other attribute.
 */
const STRUCTURAL_ATTR_NAMES = new Set([
  "d",
  "viewbox",
  "points",
  "transform",
  "width",
  "height",
  "colspan",
  "rowspan",
  "xmlns",
  "fill",
  "stroke",
  "preserveaspectratio",
  "focusable",
  "type",
  "role",
]);

function isStructuralAttrName(name: string): boolean {
  return STRUCTURAL_ATTR_NAMES.has(name.toLowerCase());
}

/**
 * Walk text nodes, comment bodies (recursively — `.text()` skips comments, same reason
 * `renderedView` in `redact-fixture.ts` re-parses them) and non-structural attribute values,
 * carrying a locating DOM path for each atom.
 */
export function extractAtoms(html: string): Atom[] {
  const $ = cheerio.load(html);
  const atoms: Atom[] = [];

  const walk = (node: AnyNode, path: string): void => {
    if (node.type === "comment") {
      atoms.push({ kind: "comment", value: node.data, path: `${path}>#comment` });
      return;
    }
    if (node.type === "text") {
      if (node.data !== "") atoms.push({ kind: "text", value: node.data, path });
      return;
    }
    // domhandler types a <script>/<style> ELEMENT's `node.type` as "script"/"style", never "tag" —
    // an earlier `if (node.type === "tag") { if (node.tagName === "script" ...) return; }` guard
    // here could never fire, so those elements fell through to the generic children-walk below,
    // which never inspected their ATTRIBUTES at all — a publication surface with no atom and
    // therefore no allow-list check (issue #28 finding 2).
    //
    // A LATER fix (issue #28 finding 1) also made this walk descend into script/style CHILDREN
    // instead of skipping them. The earlier reasoning — "redaction already strips this, so
    // atomising it here would only flood the vocabulary for no privacy gain" — was wrong: it
    // assumed the body reaching this policy had necessarily survived `redactHtml`'s
    // SCRIPT_OR_STYLE regex, which only matches PAIRED `<script>...</script>`/`<style>...</style>`
    // tags. A truncated or malformed capture like `<script>Patrick Turner` (no closing tag) never
    // matches that regex, so its body survives redaction untouched — and the old skip then threw
    // that survivor away unread, producing NO atom and no allow-list check at all. Atomising the
    // text body instead costs nothing for well-formed input: a paired, already-stripped
    // `<script></script>` has no children left to atomise, so the "no flood" property holds
    // exactly when the premise (stripping happened) is actually true, rather than being assumed.
    if (node.type === "tag" || node.type === "script" || node.type === "style") {
      const tagPath = `${path}>${node.tagName}`;
      for (const [attrName, attrValue] of Object.entries(node.attribs)) {
        if (isStructuralAttrName(attrName)) continue;
        atoms.push({ kind: "attribute", value: attrValue, path: tagPath, attrName });
      }
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of node.children) walk(child as AnyNode, tagPath);
      }
      return;
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child as AnyNode, path);
    }
  };

  for (const node of $.root().toArray()) walk(node as AnyNode, "");

  return atoms;
}

/**
 * Structural value grammars, elided in order. Decimals/dates/scores/hex-colours run BEFORE the
 * bare integer pattern, so (say) a date's year is not partially consumed by the integer pattern
 * first, which would leave the rest of the date unrecognisable.
 */
const STRUCTURAL_PATTERNS: RegExp[] = [
  // US date: 1/15/2026, 01-15-26.
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  // ISO-shaped date: 2026-01-15.
  /\b\d{4}-\d{2}-\d{2}\b/g,
  // Decimal (a rating like 4.02, or a coordinate).
  /\b\d+\.\d+\b/g,
  // Set score, optionally followed by a (match-)tiebreak: "6-4", "7-6(7)", "6-2 (10-8)".
  /\d{1,2}-\d{1,2}(?:\s?\(\d{1,2}(?:-\d{1,2})?\))?/g,
  // Hex colour.
  /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g,
  // SVG path data: a command letter followed by its numeric argument list.
  /[MmLlHhVvCcSsQqTtAaZz](?:\s*-?\d+(?:\.\d+)?[,\s]*)+/g,
  // Bare integer, last so the classes above get first crack at their digits.
  /\b\d+\b/g,
];

function elideStructuralRuns(value: string): string {
  let out = value;
  for (const pattern of STRUCTURAL_PATTERNS) {
    out = out.replace(pattern, " ");
  }
  return out;
}

/**
 * Elide every stand-in, anchored at word boundaries so a stand-in "Lee" cannot blank the middle
 * of a real "Leeson" and leave "son" behind. Longest-first so a stand-in that is a prefix of a
 * longer one ("Dana" vs "Dana Sample") does not carve up the longer phrase first.
 */
function elideStandIns(value: string, standIns: string[]): string {
  const sorted = [...standIns].filter((s) => s !== "").sort((a, b) => b.length - a.length);
  let out = value;
  for (const standIn of sorted) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(standIn)}\\b`, "gi"), " ");
  }
  return out;
}

/**
 * Strip whatever punctuation remains and collapse whitespace — the SKELETON.
 *
 * Letters are matched with `\p{L}` rather than `\w`, since JS's `\w` is ASCII-only even under the
 * `u` flag: an unqualified `\w` would strip an accented letter as if it were punctuation, silently
 * corrupting the skeleton of any non-ASCII name into something a vocabulary entry could never
 * match.
 */
function toSkeleton(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reduce one atom's raw value to its skeleton, per the ladder in the module docstring. */
export function computeSkeleton(value: string, standIns: string[]): string {
  const normalized = normalizeForComparison(value);
  const withoutStandIns = elideStandIns(normalized, standIns);
  const withoutStructural = elideStructuralRuns(withoutStandIns);
  return toSkeleton(withoutStructural);
}

export type PolicyViolation = {
  skeleton: string;
  kind: AtomKind;
  path: string;
  attrName?: string;
};

/**
 * Thrown when one or more atoms in a capture are neither synthetic, structural, nor already
 * vocabulary-listed — the "not safe to publish" signal for this policy, parallel to
 * `RedactionError` in `tools/redact-fixture.ts` but deliberately its own class rather than a
 * subclass: a `class X extends Y` reference is evaluated at module load, and this module is
 * circularly imported with `redact-fixture.ts` (see the import comment above), so extending
 * across that cycle is unsafe regardless of which side happens to load first.
 */
export class PolicyError extends Error {
  constructor(
    message: string,
    readonly violations: PolicyViolation[],
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * Fail the capture unless every content atom reduces to an empty skeleton or one already in the
 * vocabulary. `standIns` are the synthetic replacement values from the substitution map (task 9's
 * caller) or from the committed `tools/fixture-vocabulary/stand-ins.txt` (a CI-facing caller that
 * has no access to the out-of-repo map — see the module README / deviation D1).
 */
export function assertAllowListed(
  html: string,
  options: { standIns: string[]; vocabulary: Set<string> },
): void {
  const atoms = extractAtoms(html);
  const violations: PolicyViolation[] = [];
  // `computeSkeleton` always emits NFC (via `normalizeForComparison`); a vocabulary entry
  // authored/committed in NFD must match all the same — normalise the lookup set once rather
  // than requiring every caller to have NFC-normalised the file first.
  const vocabulary = new Set([...options.vocabulary].map((entry) => nfc(entry)));

  for (const atom of atoms) {
    const skeleton = computeSkeleton(atom.value, options.standIns);
    if (skeleton === "") continue;
    if (vocabulary.has(skeleton)) continue;
    violations.push({ skeleton, kind: atom.kind, path: atom.path, attrName: atom.attrName });
  }

  if (violations.length > 0) {
    throw new PolicyError(
      `${violations.length} unclassified atom(s) — not synthetic, not structural, and not in ` +
        `the vocabulary:\n${violations
          .map(
            (v) =>
              `  [${v.kind}${v.attrName !== undefined ? `@${v.attrName}` : ""}] ${v.path}: "${v.skeleton}"`,
          )
          .join("\n")}`,
      violations,
    );
  }
}

/**
 * Two or more consecutive capitalised words — the shape a real personal name takes. Exported so
 * `tools/bootstrap-vocabulary.ts` applies the SAME name-shape test when deciding which skeletons
 * it may auto-write versus which it must leave for a human to disposition by hand.
 */
export function isNameShaped(value: string): boolean {
  return /\b[A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*)+\b/.test(value);
}

/**
 * Load a per-source vocabulary file: one skeleton per line, `#` comments ignored, blank lines
 * reset any pending justification. A name-shaped entry (two or more consecutive capitalised
 * words — the shape a real personal name takes) must be immediately preceded by a justification
 * line, or the file fails to load outright; a plain comment or blank line between the
 * justification and the entry breaks the immediacy on purpose, so one justification cannot be
 * stretched to cover a second entry a human never actually read.
 *
 * Two justification forms exist, and they make different STRENGTHS of claim:
 *
 *  - `# reviewed[synthetic]: <reason>` asserts the entry is an invented stand-in value — a claim
 *    this loader can and does verify, by reusing `computeSkeleton` (the SAME reduction the
 *    allow-list check itself runs, not a second, subtly different one): the entry passes iff
 *    `computeSkeleton(entry, standIns) === ""`, i.e. eliding full stand-in PHRASES at word
 *    boundaries (and structural runs) leaves nothing behind. This is deliberately narrower than
 *    "this string looks synthetic" — a human guessing at syntheticity is exactly the failure this
 *    marker exists to make impossible (issue #28 follow-up: an unenforced "already-redacted
 *    synthetic" claim covered 14 entries that were not backed by any stand-in, several of them
 *    real Kansas City-area place names).
 *
 *    An earlier version of this check verified each CAPITALISED TOKEN in the entry independently
 *    against tokens drawn from `standIns`, rather than requiring the whole entry to be accounted
 *    for by full stand-in phrases. Since the committed register contains both "Avery Ashby" and
 *    "Arden Ashcroft" as separate stand-ins, that independent-token check let a spliced entry
 *    "Avery Ashcroft" — a full name in NEITHER stand-in — pass as "synthetic", because "Avery" and
 *    "Ashcroft" each matched a token from a DIFFERENT stand-in (issue #28 finding 3). Requiring the
 *    full-phrase skeleton to reduce to empty closes that: "Avery Ashcroft" cannot be elided by
 *    either "Avery Ashby" or "Arden Ashcroft" at a word boundary, so it fails to load.
 *  - `# reviewed: <reason>` is the general free-text form for every other honest classification
 *    (a real public place/club/league/section/tournament name, static UI chrome, boilerplate, …).
 *    It is not machine-checked beyond the PII sweep below, the same as before this fix — there is
 *    no automatable test for "is this a real place name", so the loader does not pretend to run
 *    one; a human's read-and-approve judgment is the whole control, same as it always was.
 *
 * Every entry additionally runs through `assertNoUnlistedPii`, so the vocabulary itself cannot
 * become the hole this policy exists to close.
 */
export function loadVocabulary(path: string, standIns: string[] = []): Set<string> {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const vocabulary = new Set<string>();
  let pendingReviewed: { kind: "synthetic" | "plain"; reason: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const syntheticMatch = /^#\s*reviewed\[synthetic\]:\s*(.+)$/i.exec(line);
    if (syntheticMatch) {
      pendingReviewed = { kind: "synthetic", reason: syntheticMatch[1] ?? "" };
      continue;
    }
    const reviewedMatch = /^#\s*reviewed:\s*(.+)$/i.exec(line);
    if (reviewedMatch) {
      pendingReviewed = { kind: "plain", reason: reviewedMatch[1] ?? "" };
      continue;
    }
    if (line === "" || line.startsWith("#")) {
      pendingReviewed = null;
      continue;
    }

    if (vocabulary.has(line)) {
      throw new Error(`duplicate vocabulary entry "${line}" in ${path}`);
    }
    if (isNameShaped(line) && pendingReviewed === null) {
      throw new Error(
        `name-shaped vocabulary entry "${line}" in ${path} must be immediately preceded by a ` +
          `"# reviewed: <reason>" or "# reviewed[synthetic]: <reason>" line`,
      );
    }
    if (pendingReviewed?.kind === "synthetic") {
      // The SAME reduction the allow-list check itself runs (`computeSkeleton`), not a second,
      // independent-token check — that independent-token form let a spliced entry like "Avery
      // Ashcroft" pass by matching "Avery" against ONE stand-in and "Ashcroft" against a
      // DIFFERENT one, with no stand-in ever backing the full phrase (issue #28 finding 3).
      // Requiring the whole entry to reduce to an empty skeleton after eliding full stand-in
      // phrases at word boundaries closes that: a real identity with mere token overlap survives.
      const remainder = computeSkeleton(line, standIns);
      if (remainder !== "") {
        throw new Error(
          `synthetic-classed vocabulary entry "${line}" in ${path} is not fully accounted for ` +
            `by stand-ins.txt — content not present in stand-ins: "${remainder}" remains after ` +
            `eliding full stand-in phrases at word boundaries — reclassify with a plain ` +
            `"# reviewed: <reason>" line (e.g. real-public) if it is a real public name, or add ` +
            `the missing stand-in phrase(s) to stand-ins.txt if it is genuinely synthetic; do ` +
            `not weaken this check`,
        );
      }
    }
    assertNoUnlistedPii(line);

    vocabulary.add(line);
    pendingReviewed = null;
  }

  return vocabulary;
}

/**
 * Load the committed synthetic stand-in list (`tools/fixture-vocabulary/stand-ins.txt`): one
 * stand-in value per line, `#` comments ignored. These are invented names/locations/ids by
 * construction — the name-shape review gate above does NOT apply, since every line here is
 * name-shaped by definition and already known-synthetic (see deviation D1 in the PR that added
 * this file).
 */
export function loadStandIns(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}
