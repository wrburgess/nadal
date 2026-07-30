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
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
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
  const source = [...value].map((ch) => `(?:${characterAlternatives(ch).join("|")})`).join("");
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
 * Every spelling one character can take, **longest first**.
 *
 * Order is load-bearing, not cosmetic. `&` is a prefix of `&#38;` and `%` is a prefix of `%25`,
 * so a shortest-first walk consumes one character of a five-character sequence and every
 * subsequent offset is wrong — which corrupts the replacement rather than merely missing it.
 * Sorting by length means the longest spelling that actually matches is the one consumed.
 * (Provenance: Codex adversarial review round 2 on PR #26.)
 */
function characterAlternatives(ch: string): string[] {
  const code = ch.codePointAt(0) ?? 0;
  const alternatives = [
    escapeRegExp(ch),
    `&#${code};`,
    `&#x${code.toString(16)};`,
    ...(NAMED_FOR_CHAR[ch] ?? []),
  ];
  if (!isAlnum(ch)) alternatives.push(escapeRegExp(encodeURIComponent(ch)));
  if (ch === " ") alternatives.push("\\+");
  return alternatives.sort((a, b) => unescapeAlternative(b).length - unescapeAlternative(a).length);
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
      characterAlternatives(ch)
        .map(unescapeAlternative)
        .find((option) => rest.toLowerCase().startsWith(option.toLowerCase())) ?? ch;
    // Slice the ACTUAL text rather than reusing the candidate: the two differ in case
    // (`encodeURIComponent(",")` is `%2C`, the page writes `%2c`), and echoing the candidate
    // would rewrite the page's own casing on every replacement.
    const used = rest.slice(0, candidate.length);
    if (!isAlnum(ch)) style.set(ch, used);
    i += used.length;
  }
  return style;
}

/** `characterAlternatives` returns regex source; recover the literal text each one matches. */
function unescapeAlternative(alternative: string): string {
  return alternative.replace(/\\(.)/g, "$1");
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
export function redactHtml(html: string, substitutions: Substitution[]): string {
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

  // Sweep the raw markup AND an entity-decoded copy of it. An identity has to be absent from both
  // to pass, so an encoding this module does not know how to *substitute* can still never ship
  // silently — the capture fails instead.
  const decoded = decodeEntities(html);

  for (const value of options.forbidden) {
    const found = tolerantPattern(value).exec(html) ?? tolerantPattern(value).exec(decoded);
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
