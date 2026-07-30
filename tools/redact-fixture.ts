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
const BASE64_DATA_URI = /data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=\s]+/gi;

function escapeRegExp(value: string): string {
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
 * Text nodes *and* attribute values are included, because an identity can sit in either. Runs of
 * whitespace are collapsed to a single space so that a name separated by a decoded newline or tab
 * still matches a pattern written with a space.
 *
 * Verification only — this view is never written to a fixture, so parsing cannot alter the
 * committed markup. (Provenance: Codex adversarial review round 8 on PR #26, rated critical.)
 */
function renderedView(html: string): string {
  const $ = cheerio.load(html);
  const parts = [$.root().text()];
  $("*").each((_, el) => {
    if (el.type === "tag") parts.push(...Object.values(el.attribs));
  });
  return parts.join("\n").replace(/\s+/g, " ");
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

  // Three views, and an identity must be absent from all of them. An encoding this module cannot
  // *substitute* still cannot ship silently — the capture fails instead.
  const decoded = decodeEntities(html);
  const rendered = renderedView(html);

  for (const value of options.forbidden) {
    const found =
      tolerantPattern(value).exec(html) ??
      tolerantPattern(value).exec(decoded) ??
      tolerantPattern(value).exec(rendered);
    if (found !== null) {
      survivors.push(`forbidden value survives: ${value} (as "${found[0]}")`);
    }
  }

  const allowed = new Set((options.allowed ?? []).map(lower));
  for (const detector of options.detectors ?? []) {
    for (const match of decoded.matchAll(detector.pattern)) {
      const captured = match[1];
      if (captured === undefined) continue;
      const decoded = decodePlus(captured);
      if (allowed.has(lower(decoded)) || allowed.has(lower(captured))) continue;
      survivors.push(`${detector.name} not in allow-list: ${decoded}`);
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

function decodePlus(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** Redact and verify in one call — the shape every fixture capture should use. */
export function redact(
  html: string,
  substitutions: Substitution[],
  options?: { detectors?: Detector[]; allowed?: string[] },
): string {
  const out = redactHtml(html, substitutions);
  assertRedacted(out, {
    forbidden: substitutions.map((s) => s.from),
    detectors: options?.detectors,
    allowed: options?.allowed ?? substitutions.map((s) => s.to),
  });
  return out;
}
