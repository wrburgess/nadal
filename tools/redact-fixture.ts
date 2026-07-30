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

/**
 * Match one identity in **any** encoding, including the mixed ones real pages emit.
 *
 * Enumerating whole-string spellings (literal / `encodeURIComponent` / plus-encoded) is not
 * enough: TennisRecord writes `teamname=Gerleman%2c Garrett` — comma percent-encoded, space
 * left literal — which is none of those three. Rather than cross-product the encodings, match
 * per character: each non-alphanumeric character may appear literally or percent-encoded, and a
 * space may additionally appear as `+`. The `i` flag also covers `%2c` vs `%2C`.
 *
 * (Provenance: the detector sweep in `assertRedacted` caught this on the first real capture —
 * nine real surnames survived a redaction that reported success against the spelling list.)
 */
function tolerantPattern(value: string): RegExp {
  const source = [...value]
    .map((ch) => {
      if (isAlnum(ch)) return escapeRegExp(ch);
      const alternatives = [escapeRegExp(ch), escapeRegExp(encodeURIComponent(ch))];
      if (ch === " ") alternatives.push("\\+");
      return `(?:${alternatives.join("|")})`;
    })
    .join("");
  return new RegExp(source, "gi");
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
    if (isAlnum(ch)) {
      i += 1;
      continue;
    }
    const rest = matched.slice(i);
    if (rest.startsWith("%")) {
      const width = encodeURIComponent(ch).length;
      style.set(ch, rest.slice(0, width));
      i += width;
    } else if (ch === " " && rest.startsWith("+")) {
      style.set(ch, "+");
      i += 1;
    } else {
      style.set(ch, ch);
      i += 1;
    }
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

  for (const value of options.forbidden) {
    const found = tolerantPattern(value).exec(html);
    if (found !== null) {
      survivors.push(`forbidden value survives: ${value} (as "${found[0]}")`);
    }
  }

  const allowed = new Set((options.allowed ?? []).map(lower));
  for (const detector of options.detectors ?? []) {
    for (const match of html.matchAll(detector.pattern)) {
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
