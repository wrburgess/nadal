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
import type { AnyNode, ChildNode, Element } from "domhandler";
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
 * Naming conventions for a CSRF/anti-forgery/view-state field, lowercased. Matched against a
 * lowercased `name`/`id`, never against markup — see `assertNoSessionCredentials` below.
 *
 * NOT EXHAUSTIVE. This is the set of conventions this project has met (ASP.NET WebForms, Rails,
 * Django, Laravel, Express, generic `_token`); a framework this project has not yet captured a
 * page from can use a name outside this list. Signal 3 (shape) exists precisely because this list
 * cannot be complete.
 */
const SESSION_CREDENTIAL_NAME_MARKERS = [
  "csrf",
  "xsrf",
  "viewstate",
  "eventvalidation",
  "authenticity_token",
  "_token",
  "requestverification",
];

/** `type` values whose `value` is a visible button label, never a credential. */
const EXEMPT_INPUT_TYPES = new Set(["submit", "button", "reset", "image"]);

/**
 * An opaque-token shape: only base64/URL-safe-base64 characters, 64 or more of them, anchored so
 * the WHOLE value must match. A URL, a JSON blob, or prose all fail this — punctuation, spaces and
 * short values pass through untouched. THIS IS A THRESHOLD, not a certainty: a short unnamed
 * opaque token (under 64 characters) passes signal 3 and is caught only if signal 2's name list
 * happens to match it.
 */
const OPAQUE_TOKEN_SHAPE = /^[A-Za-z0-9+/=._-]{64,}$/;

/**
 * The only `http-equiv` value exempt from the shape signal (signal 3), lowercased.
 *
 * A Chrome origin-trial token is long, base64, and therefore shape-positive — but it is signed and
 * **origin-bound, not session-bound**: it is served to every visitor of the domain, so it is public
 * by construction and carries none of the capturing operator's state.
 *
 * **Enumerated deliberately, and kept to what was measured.** Every other `http-equiv` value gets
 * the shape check, `set-cookie` explicitly included — that one is deprecated but, where it appears,
 * carries literal session state, so exempting the whole `http-equiv` vocabulary would fail open on
 * exactly the case this module exists to catch. Measured over the committed corpus (the same method
 * that settled signal 1): all 10 shape-positive `<meta>` elements in `test/fixtures/` are
 * `http-equiv="origin-trial"`, so this one-value exemption removes every false refusal the corpus
 * actually produces without widening the rule past the evidence for it.
 */
const SHAPE_EXEMPT_HTTP_EQUIV = "origin-trial";

/**
 * Text that still looks like an in-scope element, and so must be re-parsed rather than trusted as
 * text — the trigger for the raw-text sweep in `assertNoSessionCredentials`.
 *
 * **Why this exists.** An element selector only sees *elements*, and HTML has containers whose
 * contents the parser produces as **text** no matter what they look like: `<noscript>` (RAWTEXT
 * while scripting is enabled, which is cheerio's default), `<textarea>` and `<title>` (RCDATA in
 * every mode), `<iframe>`, `<noframes>`, `<noembed>`, `<xmp>`. A real
 * `<input type="hidden" name="__VIEWSTATE" value="…">` inside any of them is invisible to
 * `$("input, meta")`, and — measured — five of those seven then carried the token all the way
 * through `redact()` into the returned bytes.
 *
 * **Why a trigger on the text rather than a list of container names.** The container list is the
 * enumeration, and enumerations fail at their edges — the recurring shape this project has logged
 * repeatedly. Asking instead *"is there text here that would be an in-scope element if it were
 * parsed?"* derives the guard from the structure of the problem: whatever container hid it, and
 * however deeply nested, the hidden markup still has to look like markup to matter.
 *
 * Over-matching is safe and deliberate: a false trigger costs one extra fragment parse that finds
 * nothing. Under-matching is the only dangerous direction, so this pattern is loose on purpose.
 * (Provenance: Codex adversarial review on PR #86 found the `<noscript>` instance; measuring it
 * showed six containers affected, so the fix is written against the class.)
 */
const IN_SCOPE_ELEMENT_IN_TEXT = /<\s*(?:input|meta)[\s/>]/i;

/** Bound on the raw-text re-parse recursion — nesting past this is pathological, not real markup. */
const RAW_TEXT_SWEEP_MAX_DEPTH = 3;

/**
 * Refuse a capture that still carries what looks like the CAPTURING OPERATOR's own session state
 * — a CSRF/anti-forgery token, an ASP.NET WebForms `__VIEWSTATE` blob, or an unnamed opaque
 * credential of the same shape — rather than a scouting subject's identity.
 *
 * **This layer DETECTS AND REFUSES. It does not remove, empty, or rewrite anything, and it never
 * will** — see the module docstring on why this module edits text only and never re-serialises
 * markup. On a refusal, the operator scrubs the SAVED page (outside the repo) by hand; see
 * `docs/runbooks/capture-fixtures.md` step 4.
 *
 * Parses the document exactly ONCE with `sourceCodeLocationInfo`/`onParseError`, then applies
 * three independent signals — any one of which refuses the whole document:
 *
 * 1. **Lossy parse** — the document contains a `duplicate-attribute` parse error ANYWHERE. A
 *    second `value=` or `type=` on one tag means the parsed attribute map and the source bytes
 *    disagree about what the page says, which is exactly the class of gap that made a REWRITING
 *    control unsafe (see #80). Every other parse-error code is ignored: real captured pages in
 *    this repo routinely emit `missing-whitespace-between-attributes` and
 *    `unexpected-character-in-attribute-name` and must still pass.
 * 2. **Convention** — an `<input>` or `<meta>` whose lowercased `name`+`id` contains one of
 *    `SESSION_CREDENTIAL_NAME_MARKERS` above, and whose value (`value` for `<input>`, `content`
 *    for `<meta>`) is non-empty.
 * 3. **Shape** — ANY non-exempt `<input>`, and ANY `<meta>` other than
 *    `http-equiv="origin-trial"`, whose value matches `OPAQUE_TOKEN_SHAPE` above. This is the
 *    STRUCTURAL signal: it catches an unnamed framework's token without depending on signal 2's
 *    list being complete.
 *
 *    **Its scope is deliberately wide, because every narrowing tried here failed open.** Two were
 *    caught by an orchestrator verification pass on this very change, and both had the same shape
 *    — a narrowing that reads as precision and behaves as a bypass:
 *
 *    - Restricting the input side to `type="hidden"` meant a **bare boolean `type`** (`<input type
 *      name="q7" value="{token}">`, which parses to `type=""`) silently skipped the signal. That is
 *      the same malformed-attribute-weakens-a-guard move review round 4 used against the withdrawn
 *      stripper, so it is a known-live technique, not a hypothetical.
 *    - Restricting the meta side to `name`-keyed metas let a **nameless** `<meta content="{token}">`
 *      through entirely, and `http-equiv="set-cookie"` with it.
 *
 *    Both narrowings were removed after measuring what they actually bought on the committed
 *    corpus: **zero**. No non-exempt `<input>` in `test/fixtures/` carries a shape-positive value,
 *    and every shape-positive `<meta>` there is an `origin-trial` one. So the wide rule costs no
 *    false refusals that the narrow rules were avoiding — see `SHAPE_EXEMPT_HTTP_EQUIV` above for
 *    the one exemption that measurement did justify.
 *
 * **What this does NOT cover — the complete list, verified by executing each case rather than
 * reasoning about it.** Stated exhaustively on purpose: a limits paragraph that enumerates only
 * some of its gaps is read as enumerating all of them, and that is how a control comes to be
 * trusted past its edge. Every line below was confirmed to pass this function unrefused:
 *
 * - **Element scope: `<input>` and `<meta>` only.** A credential carried by any *other* element is
 *   invisible here — `<div data-csrf-token="…">` passes, and so does a bare token sitting as the
 *   text of `<textarea name="__VIEWSTATE">…</textarea>`, because that token is text rather than an
 *   attribute of an in-scope element.
 *
 *   **Not a limit, and worth stating so the two are not confused:** an in-scope element that a
 *   raw-text container *hid* from the selector — an `<input>` inside `<noscript>`, `<textarea>`,
 *   `<title>`, `<iframe>`, `<noframes>`, `<noembed>` or `<xmp>` — **is** caught, by the raw-text
 *   sweep in `collectInScopeElements`. The distinction is whether the credential is an attribute of
 *   a real `<input>`/`<meta>` (caught, wherever it is nested) or merely text that happens to sit
 *   inside some other element (not caught).
 * - **Attribute scope: `value` on an `<input>`, `content` on a `<meta>`, and nothing else.**
 *   `<input type="hidden" id="x" data-token="…">` passes: the element is in scope, the attribute
 *   is not.
 * - **The convention list is a fixed set of known frameworks**, not a catalogue of every possible
 *   name.
 * - **The shape signal has a 64-character threshold**, under which a short unnamed opaque value
 *   passes both signals.
 * - **The `submit`/`button`/`reset`/`image` exemption is unconditional**, so
 *   `<input type="submit" name="__VIEWSTATE" value="…">` passes. That is the deliberate price of
 *   the recorded false positive this exemption exists for (`btnCsrfRefreshPage`, whose `value` is
 *   the words on a button); the exemption cannot be narrowed to signal 3 alone without
 *   re-breaking it, because that false positive is a signal-2 match.
 *
 * Every one of these is the **manual scrub's** job (`docs/runbooks/capture-fixtures.md` step 4),
 * whose `grep` runs over raw bytes and therefore reaches all of them. That grep is a real backstop,
 * not a formality — this function does not supersede it.
 *
 * **Two exemptions, and they are scoped differently — stated precisely, because an exemption
 * described more broadly than it is written is how a control comes to be trusted for something it
 * does not do:**
 *
 * - An `<input>` whose `type` (trimmed, lowercased) is `submit`, `button`, `reset` or `image` is
 *   exempt from **every** signal — its `value` is a visible button label. A MISSING or EMPTY `type`
 *   is NOT exempt (fails closed). A duplicate `type` attribute is caught by signal 1 before this
 *   exemption is ever consulted, so a hijacked `type="submit" type="hidden"` cannot borrow it.
 * - A `<meta http-equiv="origin-trial">` is exempt from **signal 3 only**. Signal 1 and signal 2
 *   still apply to it: an `origin-trial` meta on a document with a duplicate attribute still
 *   refuses, and one whose `name`/`id` matched a credential convention would still refuse.
 *
 * Nothing else is exempt from anything.
 */
/**
 * Every `<input>`/`<meta>` in `html`, INCLUDING ones a raw-text container hid from the selector by
 * making them text — plus every parse-error code seen across all parses.
 *
 * Each text node that still looks like in-scope markup (`IN_SCOPE_ELEMENT_IN_TEXT`) is re-parsed as
 * a fragment and swept the same way, to `RAW_TEXT_SWEEP_MAX_DEPTH`. The elements come back for the
 * caller's ordinary signal checks, so the hidden ones get the identical treatment — same signals,
 * same exemptions — rather than a parallel rule set that could drift from them.
 */
function collectInScopeElements(
  html: string,
  depth: number,
  found: { elements: Element[]; parseErrorCodes: string[] },
): void {
  if (depth > RAW_TEXT_SWEEP_MAX_DEPTH) return;

  const $ = cheerio.load(html, {
    sourceCodeLocationInfo: true,
    onParseError: (err) => {
      found.parseErrorCodes.push(err.code);
    },
  });

  $("input, meta").each((_, el) => {
    if (el.type === "tag") found.elements.push(el);
  });

  const hidden: string[] = [];
  const walk = (nodes: ChildNode[]): void => {
    for (const node of nodes) {
      if (node.type === "text" && IN_SCOPE_ELEMENT_IN_TEXT.test(node.data)) hidden.push(node.data);
      const children = (node as { children?: ChildNode[] }).children;
      if (children !== undefined) walk(children);
    }
  };
  walk($.root().toArray() as unknown as ChildNode[]);

  for (const text of hidden) collectInScopeElements(text, depth + 1, found);
}

export function assertNoSessionCredentials(html: string): void {
  const survivors: string[] = [];
  const found: { elements: Element[]; parseErrorCodes: string[] } = {
    elements: [],
    parseErrorCodes: [],
  };
  collectInScopeElements(html, 0, found);

  if (found.parseErrorCodes.includes("duplicate-attribute")) {
    survivors.push(
      "document contains a duplicate HTML attribute (e.g. two `value=` or `type=` on one tag) — the parsed attribute map cannot be trusted to match the source bytes",
    );
  }

  // NOTE: `continue`, not `return`. This loop replaced a cheerio `.each()` callback, where `return`
  // meant "skip this element"; in a `for` loop the same keyword would exit the WHOLE function and
  // silently stop checking every element after the first exempt or empty one — a fail-open that no
  // existing test would have caught, since they all use single-element fixtures.
  for (const el of found.elements) {
    const tag = el.tagName.toLowerCase();
    const rawName = el.attribs.name ?? "";
    const rawId = el.attribs.id ?? "";
    const key = `${rawName} ${rawId}`.toLowerCase();
    const value = tag === "meta" ? (el.attribs.content ?? "") : (el.attribs.value ?? "");
    const type = el.attribs.type?.trim().toLowerCase() ?? "";
    const exempt = tag === "input" && EXEMPT_INPUT_TYPES.has(type);

    if (exempt || value === "") continue;

    const label = rawName || rawId || "(unnamed)";

    if (SESSION_CREDENTIAL_NAME_MARKERS.some((marker) => key.includes(marker))) {
      survivors.push(
        `<${tag}> "${label}" — name/id matches a known CSRF/anti-forgery/view-state convention`,
      );
      continue;
    }

    // The shape signal applies to EVERY remaining element — every non-exempt `<input>` (the
    // `EXEMPT_INPUT_TYPES` skip above already removed the visible-label cases, which is all that
    // a narrower `type === "hidden"` test was buying) and every `<meta>` but an `origin-trial` one.
    // Both narrowings that once stood here failed open; the docstring above records what each let
    // through and the corpus measurement that showed neither was preventing a real refusal.
    const shapeApplies =
      tag === "input" || el.attribs["http-equiv"]?.trim().toLowerCase() !== SHAPE_EXEMPT_HTTP_EQUIV;
    if (shapeApplies && OPAQUE_TOKEN_SHAPE.test(value)) {
      survivors.push(`<${tag}> "${label}" — value is a long opaque token (shape signal)`);
    }
  }

  if (survivors.length > 0) {
    throw new RedactionError(
      `output contains what looks like a session credential — the CAPTURING OPERATOR's own session ` +
        `state, never a scouting subject's identity. Never add it to the vocabulary. Scrub it on the ` +
        `saved page instead, per docs/runbooks/capture-fixtures.md step 4. ${survivors.length} ` +
        `survivor(s):\n${survivors.map((s) => `  ${s}`).join("\n")}`,
      survivors,
    );
  }
}

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
  // LAYER OWNERSHIP — this call must stay BEFORE assertAllowListed. Do not reorder it, even though
  // the allow-list below would ALSO eventually refuse a long credential-shaped value: `value`/
  // `content` are not in `CLOSED_VALUE_GRAMMARS`, so the allow-list atomises the token as ordinary
  // unclassified content and refuses it for being *unrecognised*, not for being a *credential*.
  // That incidental, misleading refusal is the exact harm #80 is about: the operator is told
  // "unknown atom", and the documented remedy for an unknown atom is to add it to the vocabulary —
  // which for a session credential is the one thing that must never happen. Refusing HERE first
  // means the operator instead sees "this is a session credential, scrub it, never add it to the
  // vocabulary." Moving or deleting this call silently restores that defect; `redact() refuses a
  // session credential before the vocabulary loop` (test/tools-redact-fixture.test.ts) pins it by
  // asserting the thrown type is RedactionError, never PolicyError.
  assertNoSessionCredentials(out);
  if (options?.vocabulary !== undefined) {
    assertAllowListed(out, {
      standIns: options.standIns ?? substitutions.map((s) => s.to),
      vocabulary: options.vocabulary,
    });
  }
  assertNoUnlistedPii(out);
  assertRedacted(out, {
    forbidden: substitutions.map((s) => s.from),
    detectors: options?.detectors,
    allowed: options?.allowed ?? substitutions.map((s) => s.to),
  });
  return out;
}
