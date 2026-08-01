/**
 * Fixture redaction — the privacy control that lets this PUBLIC repository carry fixtures cut from
 * real captured pages.
 *
 * A parser is exercised by markup *structure*, never by whose name sits in a text node, so
 * substituting synthetic identities costs the fixture nothing while keeping third-party PII —
 * names, locations, USTA/ITF ids — out of a public repo. What must survive untouched is every
 * element, class and attribute the parser reads; `redactHtml` therefore edits text only, and
 * removes nothing but `<script>`, `<style>` and base64 payloads.
 *
 * The substitution map itself is NEVER committed: it pairs each real identity with its synthetic
 * stand-in, so publishing it would publish exactly the data this module exists to remove. Pass it
 * with `--map <path>` pointing outside the repository. `test/fixtures/README.md` records that
 * redaction was applied and which categories were substituted — not the mapping.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
// Deliberately circular with tools/fixture-policy.ts, which imports normalisation helpers back
// from this module. Both references are used only inside function BODIES (never at module-scope
// evaluation), which is the shape Node's ESM loader resolves without a "before initialization"
// error — see the `redact()` docstring below for why the cycle exists at all.
import { assertAllowListed } from "./fixture-policy.js";

export type Substitution = { from: string; to: string };

/**
 * A structural sweep for identities nobody remembered to list. `pattern` must carry exactly one
 * capture group holding the identity; every captured value has to appear in `allowed`.
 */
export type Detector = { name: string; pattern: RegExp };

export class RedactionError extends Error {
  constructor(
    message: string,
    readonly survivors: string[],
  ) {
    super(message);
    this.name = "RedactionError";
  }
}

const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
// The payload class deliberately EXCLUDES whitespace. Including `\s` made the match run past the
// end of an unquoted attribute value and eat the separator before the next attribute, so
// `<img src=data:image/png;base64,QUJD alt=logo>` became `...REDACTEDalt=logo` — silently deleting
// `alt` and changing the markup this tool exists to preserve.
// (Provenance: Codex adversarial review round 10 on PR #26.)
const BASE64_DATA_URI = /data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/gi;

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAllCaps(value: string): boolean {
  return value === value.toUpperCase() && value !== value.toLowerCase();
}

function isAlnum(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * Decode HTML character references to their characters.
 *
 * Used for **verification only** — never to build a fixture — so the committed markup is never
 * altered by it. `Cory&#32;Hogan`, `&#67;ory Hogan` and `O&#39;Brien` are all ordinary things for
 * a server to emit, and each of them is invisible to a matcher that only knows literal, percent
 * and plus encodings. Sweeping a decoded copy alongside the raw one means an identity has to
 * survive *both* spellings to escape, whatever encoding a future page invents.
 */
export function decodeEntities(value: string): string {
  // The terminating semicolon is OPTIONAL. HTML parsers recover a numeric reference without one
  // — `&#67ory Hogan` is a parse error that still renders as `Cory Hogan` — so a decoder that
  // requires it can be walked straight past by markup a browser displays perfectly.
  // (Provenance: Codex adversarial review round 4 on PR #26.)
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * What the page actually *renders*, with every entity resolved by a standards-complete decoder.
 *
 * `decodeEntities` above knows a hand-written handful of named references, and a hand-written list
 * is exactly the wrong shape for this job: HTML5 defines over two thousand named references, and
 * `Cory&NewLine;Hogan` renders as the name while evading any table that does not happen to list
 * `&NewLine;`. So rather than lengthening the table, parse the document and read it back — the
 * parser's decoder is complete by construction, and it stays complete as the spec moves.
 *
 * Three kinds of node can carry an identity, and all three are collected:
 *
 * - **text nodes** — the obvious case;
 * - **attribute values** — an identity sits in an `href` or a `title` as easily as in a text node;
 * - **comment bodies** — which `.text()` does NOT return, so `<!-- Cory&NewLine;Hogan -->` was
 *   invisible to a view built from rendered text alone. A comment's content is raw, so it is
 *   parsed in turn and read back, giving it the same standards-complete decoding as the document.
 *
 * Runs of whitespace are collapsed to a single space so that a name separated by a decoded newline
 * or tab still matches a pattern written with a space.
 *
 * Verification only — this view is never written to a fixture, so parsing cannot alter the
 * committed markup. Stripping comment bodies at write time would also close the comment case, and
 * is the stronger move if this surface ever grows again; it is not taken here because it would
 * change committed markup for a case verification already covers.
 * (Provenance: Codex adversarial review rounds 8 and 9 on PR #26, both rated critical.)
 */
function renderedView(html: string): string {
  const $ = cheerio.load(html);
  const parts: string[] = [$.root().text()];

  const walk = (node: AnyNode): void => {
    if (node.type === "comment") {
      parts.push(fullyDecodeEntities(node.data));
      return;
    }
    if (node.type === "tag") parts.push(...Object.values(node.attribs));
    // Recurse on anything with children — including the document ROOT, whose type is not "tag".
    // Returning early on a non-tag node stopped the walk at the root and silently collected no
    // attributes at all, which a passing attribute test then hid.
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child as AnyNode);
    }
  };
  for (const node of $.root().toArray()) walk(node as AnyNode);

  return collapseFormatChars(parts.join("\n"));
}

/**
 * Decode entities the way a browser renders them, by parsing the fragment and reading its text
 * back — complete by construction (HTML5 defines over two thousand named references) rather
 * than a hand-written table. This is the SAME mechanism `renderedView` has always used for a
 * comment body (which `.text()` does not reach on the document itself); naming and exporting it
 * lets `tools/fixture-policy.ts` reduce an atom's content through the identical decoder instead
 * of inventing a second one.
 */
export function fullyDecodeEntities(value: string): string {
  return cheerio.load(value).root().text();
}

/**
 * Unicode format characters (category Cf) plus the zero-width set, which render as nothing and
 * can therefore sit invisibly inside an identity.
 */
const FORMAT_CHARS = new RegExp(
  `[${String.fromCharCode(0x5c)}p{Cf}${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d)}${String.fromCharCode(0xfeff)}${String.fromCharCode(0x2060)}]`,
  "gu",
);

/**
 * Fold zero-width/format characters to a space and collapse whitespace runs to one space.
 *
 * Split out of `renderedView` so `normalizeForComparison` applies the EXACT same fold rather than
 * a re-derived regex — a second, subtly different normaliser would be a bypass of exactly the
 * kind the reviews above closed.
 * (Provenance: Codex adversarial review round 10 on PR #26, rated critical.)
 */
export function collapseFormatChars(value: string): string {
  return value.replace(FORMAT_CHARS, " ").replace(/\s+/g, " ");
}

/**
 * Match one identity in **any** encoding, including the mixed ones real pages emit.
 *
 * Enumerating whole-string spellings (literal / `encodeURIComponent` / plus-encoded) is not
 * enough: TennisRecord writes `teamname=Gerleman%2c Garrett` — comma percent-encoded, space
 * left literal — which is none of those three. Rather than cross-product the encodings, match
 * per character. Each character may appear:
 *
 * - literally;
 * - percent-encoded (`%2c`), for a value inside an href;
 * - as an HTML numeric character reference, decimal (`&#32;`) or hex (`&#x20;`), which a server
 *   may emit for **any** character, letters included — `&#67;ory Hogan` renders as `Cory Hogan`;
 * - as `+`, for a space in a query string.
 *
 * The `i` flag covers `%2c` vs `%2C` and `&#X20;` vs `&#x20;`.
 *
 * (Provenance: the percent/space mix was caught by this module's own detector sweep on the first
 * real capture — nine real surnames survived a redaction that reported success against the
 * spelling list. The character-reference gap was caught by the Codex adversarial review on
 * PR #26, rated critical because this is a privacy control on a public repository.)
 */
function tolerantPattern(value: string): RegExp {
  const source = [...value]
    .map((ch) => `(?:${characterAlternatives(ch)
      .map((a) => a.pattern)
      .join("|")})`)
    .join("");
  return new RegExp(source, "gi");
}

const NAMED_FOR_CHAR: Record<string, string[]> = {
  "&": ["&amp;"],
  "<": ["&lt;"],
  ">": ["&gt;"],
  '"': ["&quot;"],
  "'": ["&apos;"],
};

/**
 * `pattern` is regex source; `literal` is the text that source actually consumes. They differ
 * wherever a pattern carries a zero-width assertion, and conflating them would both mis-sort the
 * alternatives and desynchronise the alignment walk that reads them back.
 */
type Alternative = { pattern: string; literal: string };

/**
 * Every spelling one character can take, **longest first**.
 *
 * Order is load-bearing, not cosmetic. `&` is a prefix of `&#38;`, `%` of `%25`, and `&#67;` of
 * `&#67`, so a shortest-first walk consumes one character of a multi-character sequence and every
 * subsequent offset is wrong — corrupting the replacement rather than merely missing it. Sorting
 * by the LITERAL length means the longest spelling that actually matches is the one consumed, and
 * it also fixes the regex alternation order, which is first-match-wins.
 * (Provenance: Codex adversarial review rounds 2 and 4 on PR #26.)
 */
function characterAlternatives(ch: string): Alternative[] {
  const code = ch.codePointAt(0) ?? 0;
  const hex = code.toString(16);
  const alternatives: Alternative[] = [
    { pattern: escapeRegExp(ch), literal: ch },
    { pattern: `&#${code};`, literal: `&#${code};` },
    { pattern: `&#x${hex};`, literal: `&#x${hex};` },
    // Semicolon-less forms, which HTML parsers recover and render. The negative lookahead stops
    // `&#67` from matching inside a longer reference such as `&#671;`, which is a different
    // character entirely.
    { pattern: `&#${code}(?![0-9])`, literal: `&#${code}` },
    { pattern: `&#x${hex}(?![0-9a-fA-F])`, literal: `&#x${hex}` },
    ...(NAMED_FOR_CHAR[ch] ?? []).map((entity) => ({ pattern: entity, literal: entity })),
  ];
  if (!isAlnum(ch)) {
    const encoded = encodeURIComponent(ch);
    alternatives.push({ pattern: escapeRegExp(encoded), literal: encoded });
  }
  if (ch === " ") alternatives.push({ pattern: "\\+", literal: "+" });
  return alternatives.sort((a, b) => b.literal.length - a.literal.length);
}

/**
 * Recover how each non-alphanumeric character was encoded in a specific match, so the
 * replacement can be written back in the same style — `Gerleman%2c Garrett` becomes
 * `Kestrel%2c Avery`, not a literal comma that would break the href for a later reader.
 *
 * Alphanumeric characters always align 1:1 with the pattern, so walking `from` and the matched
 * text together is exact.
 */
function encodingStyle(from: string, matched: string): Map<string, string> {
  const style = new Map<string, string>();
  let i = 0;
  for (const ch of from) {
    const rest = matched.slice(i);
    // Consume whichever alternative actually matched here. Walking the alternatives is what keeps
    // the alignment exact now that a character can also appear as a multi-character entity — an
    // assumed width of 1 would desynchronise the rest of the walk from the first `&#67;`.
    const candidate =
      characterAlternatives(ch).find((option) =>
        rest.toLowerCase().startsWith(option.literal.toLowerCase()),
      )?.literal ?? ch;
    // Slice the ACTUAL text rather than reusing the candidate: the two differ in case
    // (`encodeURIComponent(",")` is `%2C`, the page writes `%2c`), and echoing the candidate
    // would rewrite the page's own casing on every replacement.
    const used = rest.slice(0, candidate.length);
    if (!isAlnum(ch)) style.set(ch, used);
    i += used.length;
  }
  return style;
}

function applyStyle(value: string, style: Map<string, string>): string {
  return [...value].map((ch) => (isAlnum(ch) ? ch : (style.get(ch) ?? ch))).join("");
}

/**
 * Substitute every identity, strip script/style bodies, and collapse base64 payloads.
 *
 * Matching is case-insensitive because the same person appears title-cased in a link and
 * upper-cased in a table cell on one TennisRecord page; an ALL-CAPS match is replaced with an
 * ALL-CAPS stand-in so the fixture keeps the casing variation the team parser must not normalize.
 *
 * Spellings are applied longest-first so a longer identity ("Cory Hogan") is consumed before a
 * shorter one that is a prefix of it ("Cory") can carve it up.
 */
/**
 * Characters a replacement may not contain.
 *
 * Substitution runs over raw markup, so a stand-in carrying `'` would terminate a single-quoted
 * href the moment it landed in one — corrupting the very markup the fixture exists to preserve,
 * and doing it in whichever attribute happened to hold the name. Escaping per attribute context
 * would mean parsing and re-serialising the document, which alters markup by itself; refusing the
 * input is both stricter and non-destructive, and the operator picks the stand-ins anyway.
 * `&` is permitted: it cannot terminate an attribute, and real team names contain it
 * (`HOA/Fenwick/18&over4.0M`). (Provenance: Codex adversarial review round 3 on PR #26.)
 */
const UNSAFE_IN_REPLACEMENT = /["'<>]/;

/**
 * Characters that are structurally significant in a URL query and must not be *introduced* by a
 * replacement.
 *
 * `applyStyle` can only reproduce the encoding of characters that appear in the ORIGINAL — that is
 * where the per-character styles come from. A character present only in the replacement is
 * emitted literally, so substituting a name for one containing `&` inside
 * `playername=Cory%20Hogan` yields `playername=A&B` and splits the parameter. Characters already
 * present in the original are fine: their encoding was observed and is reproduced.
 * (Provenance: Codex adversarial review round 6 on PR #26.)
 */
const URL_STRUCTURAL = ["&", "=", "?", "#"];

function assertSafeReplacements(substitutions: Substitution[]): void {
  const unsafe = substitutions.filter((s) => UNSAFE_IN_REPLACEMENT.test(s.to));
  if (unsafe.length > 0) {
    throw new RedactionError(
      `replacement values may not contain " ' < or > — they would break the markup they land in:\n${unsafe
        .map((s) => `  ${s.to}`)
        .join("\n")}`,
      unsafe.map((s) => s.to),
    );
  }

  const introduced = substitutions.flatMap((s) =>
    URL_STRUCTURAL.filter((ch) => s.to.includes(ch) && !s.from.includes(ch)).map(
      (ch) => `${s.from} -> ${s.to} (introduces "${ch}")`,
    ),
  );
  if (introduced.length > 0) {
    throw new RedactionError(
      `a replacement may not introduce ${URL_STRUCTURAL.join(" ")} that the original lacks — the encoding to write it back with is unknown, so it would be emitted literally and could split a URL query:\n${introduced
        .map((entry) => `  ${entry}`)
        .join("\n")}`,
      introduced,
    );
  }
}

export function redactHtml(html: string, substitutions: Substitution[]): string {
  assertSafeReplacements(substitutions);

  let out = html.replace(SCRIPT_OR_STYLE, (match) => {
    const tag = match.slice(1, match.indexOf(">")).split(/\s/)[0];
    return `<${tag}></${tag}>`;
  });

  out = out.replace(BASE64_DATA_URI, "data:image/png;base64,REDACTED");

  // Before any substitution: a session credential is not an identity anyone would have listed in
  // the map, so it must not depend on one. See `CREDENTIAL_FIELD` for why this is emptied rather
  // than left for the allow-list to refuse.
  out = stripCredentialFields(out);

  // Longest identity first, so a longer one ("Cory Hogan") is consumed before a shorter one that
  // is a prefix of it ("Cory") can carve it up.
  const ordered = [...substitutions].sort((a, b) => b.from.length - a.from.length);

  for (const { from, to } of ordered) {
    out = out.replace(tolerantPattern(from), (match) => {
      const replacement = applyStyle(to, encodingStyle(from, match));
      return isAllCaps(match) ? replacement.toUpperCase() : replacement;
    });
  }

  return out;
}

/**
 * Fail unless the output is clean, by two independent means.
 *
 * `forbidden` catches the identities the operator listed. `detectors` + `allowed` close the gap
 * that list cannot: they re-derive every identity the page still advertises (each `playername=`
 * in a TennisRecord href, each `uaid` on a USTA profile) and require it to be a synthetic one, so
 * a name nobody thought to list is caught structurally rather than by memory.
 */
export function assertRedacted(
  html: string,
  options: { forbidden: string[]; detectors?: Detector[]; allowed?: string[] },
): void {
  const survivors: string[] = [];

  // Several views, and an identity must be absent from ALL of them. An encoding this module
  // cannot *substitute* still cannot ship silently — the capture fails instead.
  const baseViews = views(html);
  // ...each also in NFC. `José` composed (U+00E9) and decomposed (`e` + U+0301) are the same name
  // to every reader and different code-point sequences to a matcher, so a map entry written in
  // one form silently misses the other. Normalising both sides collapses that difference.
  // (Provenance: Codex adversarial review round 11 on PR #26, rated critical.)
  const allViews = [...baseViews, ...baseViews.map(nfc)];

  for (const value of options.forbidden) {
    const found = [value, nfc(value)]
      .flatMap((needle) => allViews.map((view) => tolerantPattern(needle).exec(view)))
      .find((match) => match !== null);
    if (found !== undefined && found !== null) {
      survivors.push(`forbidden value survives: ${value} (as "${found[0]}")`);
    }
  }

  const allowed = new Set((options.allowed ?? []).map((v) => nfc(lower(v))));
  const detectorView = baseViews[1] ?? html;
  for (const detector of options.detectors ?? []) {
    for (const match of detectorView.matchAll(detector.pattern)) {
      const captured = match[1];
      if (captured === undefined) continue;
      const value = decodePlus(captured);
      if (allowed.has(nfc(lower(value))) || allowed.has(nfc(lower(captured)))) continue;
      survivors.push(`${detector.name} not in allow-list: ${value}`);
    }
  }

  if (survivors.length > 0) {
    throw new RedactionError(
      `redaction incomplete — ${survivors.length} survivor(s):\n${survivors.join("\n")}`,
      survivors,
    );
  }
}

function lower(value: string): string {
  return value.toLowerCase();
}

/** Canonical composition, so the same name written two ways compares equal. */
export function nfc(value: string): string {
  return value.normalize("NFC");
}

/**
 * Percent-escapes resolved, so an identity hidden in a URL-encoded value is visible to the sweep
 * in whichever normalisation form it was encoded from — `Jose%CC%81` decodes to the decomposed
 * spelling, which the NFC pass above then folds onto the composed one. Invalid escape runs are
 * left alone rather than throwing, since raw markup contains `%` for many reasons.
 *
 * Works on any string, not only a full page — `tools/fixture-policy.ts` runs this over a single
 * atom's value, same as `assertRedacted`/`assertNoUnlistedPii` run it over the whole document.
 */
export function percentDecode(value: string): string {
  return value.replace(/(?:%[0-9a-fA-F]{2})+/g, (escaped) => {
    try {
      return decodeURIComponent(escaped);
    } catch {
      return escaped;
    }
  });
}

export function decodePlus(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * The four independent readings a survivor sweep checks: raw markup, the hand-written
 * decimal/hex/named-entity decode, the standards-complete parser decode (which also reaches
 * comment bodies and folds zero-width/format characters to a space), and percent-decoding.
 *
 * Named and exported so `assertRedacted` and `assertNoUnlistedPii` share one construction instead
 * of two independently-maintained array literals, and so `tools/fixture-policy.ts` can build the
 * same views over a single atom rather than re-deriving the list.
 */
export function views(html: string): string[] {
  return [html, decodeEntities(html), renderedView(html), percentDecode(html)];
}

/**
 * Reduce one atom's raw value to a single normalised string, through the SAME pipeline the
 * multi-view survivor sweeps above use — entity decode (including the parser-based decode that
 * reaches comment bodies and the full named-entity table), percent decode, zero-width/format
 * character collapse, NFC, whitespace collapse. `tools/fixture-policy.ts` reduces every atom
 * through this one function rather than a second, independently-written normaliser — see the
 * module docstring on why that would be a bypass of exactly the kind rounds 8-11 closed.
 */
export function normalizeForComparison(value: string): string {
  const decoded = fullyDecodeEntities(decodeEntities(value));
  const percentDecoded = percentDecode(decoded);
  const folded = collapseFormatChars(percentDecoded);
  return nfc(folded).trim();
}

/**
 * Fields whose VALUE is a credential belonging to the capturing SESSION, not data about the page's
 * subject — the class every other layer in this module was not built for.
 *
 * `NEVER_PUBLISH` below covers third-party PII (email, phone, address); the substitution map covers
 * identities someone enumerated; the detectors cover ids the site advertises. A page captured from a
 * logged-in session also carries the OPERATOR's secrets: TennisLink's league pages are ASP.NET
 * WebForms and embed a 172-character `hdnCSRFToken` and a 14,420-character `__VIEWSTATE` inline.
 *
 * The allow-list would refuse such a token rather than ship it, so nothing leaks silently — but the
 * REFUSAL is where this became dangerous rather than safe. `docs/runbooks/capture-fixtures.md` tells
 * an operator to resolve a refusal by classifying the atom and **adding it to the committed
 * vocabulary**, and a 172-character opaque string reads as "boilerplate" to someone working that loop
 * mechanically. Following the documented procedure correctly could therefore commit a live session
 * token to a public repository.
 *
 * ## Why this is parsed and not pattern-matched
 *
 * The first three versions of this control hand-wrote a tag matcher, and each review round found a new
 * way it was lexically wrong: `\b` matched after a hyphen so `data-type` skipped a live token; the
 * `(?<![-\w])` that fixed it did not cover `:`, so the legal attribute name `data:type` skipped it
 * too; and `<(?:input|meta)\b[^>]*>` truncated the tag at a `>` INSIDE a quoted value, so
 * `value="abc>SECRET"` survived untouched — with the backstop assertion sharing the identical bypass
 * because it reused the same matcher.
 *
 * Three rounds, three delimiters, the same defect moving sideways. Lexical HTML has more edge cases
 * than anyone enumerates by hand, so the tag boundaries now come from the real parser this module
 * already imports. `htmlparser2` (via cheerio) reports each element's exact `[startIndex, endIndex]`
 * span and its parsed `attribs`, which settles all three classes at the root: `data-type`,
 * `data:type` and `type` are simply distinct keys, and a `>` inside a quoted value is the tokenizer's
 * problem rather than ours.
 *
 * This is also the house pattern rather than a new one — the parsers in `src/parsers/` locate with
 * cheerio and only then read values, and courtgrab2 before them used Nokogiri `.css()` the same way.
 * This function had deviated from it; it no longer does.
 *
 * The one thing NOT delegated to the parser is writing the value back. Re-serialising a cheerio tree
 * would reformat markup this module exists to preserve byte-for-byte, so the replacement is a string
 * splice inside the parser-supplied span. That is safe in a way the old code was not: the span is
 * authoritative, so a quoted `>` can no longer terminate it early, and an UNQUOTED attribute value
 * cannot contain `>` at all under the HTML spec.
 *
 * ## Why emptying, and why erring toward it
 *
 * Emptying rather than substituting is deliberate: an empty value reduces to an empty SKELETON, so the
 * allow-list admits it with no vocabulary entry and it never reaches the refusal report that caused
 * the problem. A placeholder would put a new atom back INTO that report.
 *
 * Over-stripping a hidden field or a `<meta>` is harmless here, and the control errs that way on
 * purpose: this produces a TEST FIXTURE, no parser reads a hidden input or a meta, and the element
 * with every other attribute survives. So `csrfEnabled="true"` losing its value costs nothing. The one
 * place precision genuinely matters is USER-VISIBLE text, which is why `type=submit|button|reset|image`
 * — whose `value` is the control's label — is excluded outright.
 *
 * ## What this still does not do
 *
 * It is a blacklist. `CREDENTIAL_NAMES` carries the conventions of the frameworks this project meets,
 * but a credential in a field named something else still ships, and `assertNoCredentialFields` backs
 * up only the listed names. That is a real limit, not a formality.
 * (Provenance: #27; live signed-in TennisLink session 2026-08-01; Codex adversarial review on PR #79.)
 */
const CREDENTIAL_NAMES = new Set(
  [
    // ASP.NET WebForms / MVC
    "__VIEWSTATE",
    "__VIEWSTATEGENERATOR",
    "__VIEWSTATEENCRYPTED",
    "__EVENTVALIDATION",
    "__RequestVerificationToken",
    // Rails
    "authenticity_token",
    // Laravel — the field Codex correctly flagged as stripped by nothing
    "_token",
    // Django
    "csrfmiddlewaretoken",
    // Express / Angular / common conventions
    "_csrf",
    "csrf_token",
    "csrf-token",
    "xsrf-token",
  ].map((name) => name.toLowerCase()),
);

/**
 * Names that CONTAIN a csrf/xsrf marker — deliberately broad, because the blast radius is a hidden
 * field or a meta that nothing reads (see "Why emptying" above). This is what catches TennisLink's
 * `hdnCSRFToken` without the list having to know that vendor's prefix convention.
 */
const CREDENTIAL_NAME_PATTERN = /csrf|xsrf/i;

function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAMES.has(name.toLowerCase()) || CREDENTIAL_NAME_PATTERN.test(name);
}

/** A submit/button/reset/image `value` is the control's VISIBLE LABEL, never a credential. */
const LABEL_BEARING_TYPES = new Set(["submit", "button", "reset", "image"]);

/** The attributes that can carry a credential: `value` on an input, `content` on a meta. */
const CREDENTIAL_ATTRS = ["value", "content"] as const;

type CredentialSpan = {
  start: number;
  end: number;
  names: string[];
  raw: string;
  tagName: string;
  attribs: Record<string, string>;
};

/**
 * Locate every credential-bearing attribute using the real parser, returning spans into the ORIGINAL
 * string. Shared by the stripper and its backstop so the two can never disagree about what counts.
 */
function findCredentialSpans(html: string): CredentialSpan[] {
  // parse5 (cheerio's default parser) reports spans under `sourceCodeLocationInfo`. `endIndex` is
  // EXCLUSIVE — pinned empirically, because an off-by-one here fails silently.
  const $ = cheerio.load(html, { sourceCodeLocationInfo: true } as cheerio.CheerioOptions);
  const found: CredentialSpan[] = [];

  $("input, meta").each((_i, element) => {
    const attribs: Record<string, string> = element.attribs ?? {};
    const start = element.startIndex;
    const end = element.endIndex;
    if (start === null || start === undefined || end === null || end === undefined) return;
    const raw = html.slice(start, end);

    // The label exemption must FAIL CLOSED. `<input type="submit" type="hidden" id="hdnCSRFToken"
    // value="…">` is malformed but browser-tolerated, and parse5 keeps the FIRST `type` — so trusting
    // the parsed value would exempt a hidden credential field as a button and skip it entirely. A
    // duplicated `type` means the parsed view cannot be trusted about this element, so the exemption
    // is refused rather than granted. This is the duplicate-attribute class applied to the exemption
    // instead of to the value, and an exemption is exactly where that class is most dangerous.
    const typeOccurrences = raw.match(/(?:^|[\s/])type\s*=/gi)?.length ?? 0;
    const type = (attribs.type ?? "").trim().toLowerCase();
    if (typeOccurrences <= 1 && LABEL_BEARING_TYPES.has(type)) return;

    const names = Object.entries(attribs)
      .filter(([key]) => key.toLowerCase() === "name" || key.toLowerCase() === "id")
      .map(([, value]) => value)
      .filter(isCredentialName);
    if (names.length === 0) return;

    found.push({
      start,
      end,
      names,
      raw,
      tagName: element.tagName,
      attribs,
    });
  });

  return found;
}

/**
 * Serialise a credential-bearing tag from the parser's authoritative attribute map, emptying the
 * credential attributes.
 *
 * ## Why no byte pattern at all
 *
 * Two consecutive review rounds found the same class of defect: a hand-written byte pattern
 * disagreeing with parse5 about what an attribute value IS.
 *
 *  - Duplicate attributes — `value="public" value="SECRET"`. parse5 keeps the first and discards the
 *    second, but the second stays in the bytes, so a first-match replace emptied the decoy.
 *  - Unquoted values containing `=` — `value=x=9876…`. The HTML spec forbids `=` there, but the spec's
 *    own error handling APPENDS it, so parse5 reads the whole thing while a spec-shaped character
 *    class stopped at `x`, leaving `value=""=9876…` — a dangling token tail the backstop then
 *    certified as clean.
 *
 * Patching the character class would have been a third round of the same mistake. The class only
 * closes by removing the byte pattern: the parser already knows every attribute and its exact value,
 * so the tag is rebuilt from that map instead of edited in place. Duplicates collapse (parse5 already
 * discarded them), quoting is normalised, unquoted values are quoted, and every lexical question —
 * `=`, `>`, mixed quotes, case, self-closing slashes — stops being ours to answer.
 *
 * The cost is that a credential-bearing tag loses its original formatting. That is acceptable
 * precisely here and nowhere else in this module: these are hidden `<input>`s and `<meta>`s that no
 * parser in `src/parsers/` reads, the element and all its attributes survive, and the
 * "markup the parsers read is structurally identical" guarantee is unaffected.
 * (Provenance: Codex adversarial review rounds 2 and 3 on PR #79, both rated critical.)
 */
function escapeAttributeValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function serialiseWithEmptiedCredentials(
  tagName: string,
  attribs: Record<string, string>,
): string {
  const rendered = Object.entries(attribs).map(([key, value]) => {
    const emptied = CREDENTIAL_ATTRS.includes(key.toLowerCase() as (typeof CREDENTIAL_ATTRS)[number]);
    return `${key}="${escapeAttributeValue(emptied ? "" : value)}"`;
  });
  return `<${tagName}${rendered.length > 0 ? ` ${rendered.join(" ")}` : ""}>`;
}

/** Empty the value of every credential-bearing field, leaving the rest of the markup identical. */
export function stripCredentialFields(html: string): string {
  const spans = findCredentialSpans(html);
  if (spans.length === 0) return html;

  // Rewrite right-to-left so earlier spans keep their original offsets.
  let out = html;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    const rebuilt = serialiseWithEmptiedCredentials(span.tagName, span.attribs);
    out = out.slice(0, span.start) + rebuilt + out.slice(span.end);
  }
  return out;
}

/**
 * Fail the capture if a credential field still carries a value.
 *
 * Shares `findCredentialSpans` with the stripper — a backstop that can drift from the thing it backs
 * up is not a backstop. Two independent conditions, because the parsed map alone is not sufficient on
 * arbitrary INPUT:
 *
 *  1. any parsed credential attribute whose value is non-empty; and
 *  2. a credential attribute appearing **more than once in the raw span**, which parse5 collapses to
 *     one — the duplicate-attribute bypass. Output produced by `stripCredentialFields` is
 *     parser-serialised and so can never trip this; only unprocessed input can.
 *
 * The message names the FIELD and the length of what survived, never the value, since a secret does
 * not become safe by being printed in an error.
 */
export function assertNoCredentialFields(html: string): void {
  const survivors: string[] = [];

  for (const span of findCredentialSpans(html)) {
    const label = span.names.join("/");
    for (const attr of CREDENTIAL_ATTRS) {
      const value = span.attribs[attr];
      if (value !== undefined && value !== "") {
        survivors.push(`${label} @${attr} (${value.length} chars)`);
      }
      const occurrences = span.raw.match(new RegExp(`(?:^|[\\s/])${attr}\\s*=`, "gi"))?.length ?? 0;
      if (occurrences > 1) {
        survivors.push(`${label} @${attr} (${occurrences} duplicate attributes in raw markup)`);
      }
    }
  }

  if (survivors.length > 0) {
    throw new RedactionError(
      `output still carries a session credential in a known credential field — these belong to the capturing operator, not to the page's subject, and must never be committed:\n${survivors
        .map((s) => `  ${s}`)
        .join("\n")}`,
      survivors,
    );
  }
}

/**
 * Identity classes that must NEVER appear in a committed fixture, whether or not anyone listed
 * them in the substitution map.
 *
 * The map-derived sweep can only catch identities someone thought to enumerate, and the
 * source-specific detectors are narrow spot checks tied to one site's markup. Neither sees a
 * `mailto:` link, a phone number, or a street address — so an unlisted identity of a kind the map
 * was never about would be written to a public fixture with the tool reporting success.
 *
 * This closes the demonstrated classes. It does NOT make the control complete: a blacklist cannot
 * be, which is the finding recorded against this tool and the reason the allow-list redesign is
 * tracked as follow-up work rather than claimed as done here.
 * (Provenance: Codex adversarial review round 12 on PR #26.)
 */
const NEVER_PUBLISH: { name: string; pattern: RegExp }[] = [
  { name: "email address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "mailto link", pattern: /mailto:[^"'\s>]+/gi },
  { name: "tel link", pattern: /tel:\+?[\d()\-. ]{7,}/gi },
  { name: "phone number", pattern: /\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g },
  {
    name: "street address",
    pattern:
      /\b\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Ter|Terrace)\b/g,
  },
];

/**
 * Fail the capture if any never-publish class appears anywhere in the output — raw, decoded,
 * rendered or percent-decoded.
 */
export function assertNoUnlistedPii(html: string): void {
  const survivors: string[] = [];
  for (const { name, pattern } of NEVER_PUBLISH) {
    for (const view of views(html)) {
      const found = new RegExp(pattern.source, pattern.flags).exec(view);
      if (found !== null) {
        survivors.push(`${name}: ${found[0]}`);
        break;
      }
    }
  }
  if (survivors.length > 0) {
    throw new RedactionError(
      `output contains identity classes that must never be committed, whether or not they are in the substitution map:\n${survivors
        .map((s) => `  ${s}`)
        .join("\n")}`,
      survivors,
    );
  }
}

/**
 * Redact and verify in one call.
 *
 * When `options.vocabulary` is supplied, the allow-list policy (`tools/fixture-policy.ts`) runs
 * FIRST, before the forbidden-value and detector sweeps: no caller can hold a redacted string
 * that still carries an atom that is neither synthetic, structural, nor already vocabulary-listed
 * (task 9). `vocabulary` is opt-in rather than always-on so that a bare `redact(html, subs)` call
 * — every pre-existing caller of this function, none of which has a vocabulary to pass — stays a
 * no-op for this stage.
 *
 * A call WITHOUT `vocabulary` is the LEGACY blacklist-only path (forbidden-value sweep +
 * structural detector sweep only) — it is **not** the closed allow-list boundary issue #28 added,
 * and must not be read as one: it ships whatever nobody thought to forbid or detect. This
 * function does not, and structurally cannot, enforce "never call me without a vocabulary" —
 * that enforcement lives one layer up, in `tools/capture-fixture.ts`'s `main()`, which refuses
 * the capture outright unless a vocabulary path resolves (default or explicit `--vocabulary`).
 * `tools/capture-fixture.ts` is the real closed-boundary production entrypoint; call it, not this
 * function directly, for any capture that must be allow-list-enforced.
 */
export function redact(
  html: string,
  substitutions: Substitution[],
  options?: {
    detectors?: Detector[];
    allowed?: string[];
    standIns?: string[];
    vocabulary?: Set<string>;
  },
): string {
  const out = redactHtml(html, substitutions);
  if (options?.vocabulary !== undefined) {
    assertAllowListed(out, {
      standIns: options.standIns ?? substitutions.map((s) => s.to),
      vocabulary: options.vocabulary,
    });
  }
  assertNoUnlistedPii(out);
  assertNoCredentialFields(out);
  assertRedacted(out, {
    forbidden: substitutions.map((s) => s.from),
    detectors: options?.detectors,
    allowed: options?.allowed ?? substitutions.map((s) => s.to),
  });
  return out;
}
