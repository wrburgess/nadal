import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { ParseError } from "./types.js";

/**
 * Split an element's content on `<br>`.
 *
 * TennisRecord packs several fields into one `<td>`, separated only by `<br>` — a partner cell is
 * `<a>Nova Norbury</a><br>(3.55)`, a team cell is `<a>Norbury, Nova<br>Missouri Valley</a>`.
 * `.text()` concatenates those into `Nova Norbury(3.55)` and `Norbury, NovaMissouri Valley`, which
 * is why reading these cells as plain text produces values that look almost right.
 */
export function lines($: CheerioAPI, el: Cheerio<AnyNode>): string[] {
  const out: string[] = [];
  let current = "";

  const walk = (node: AnyNode): void => {
    if (node.type === "text") {
      current += node.data;
      return;
    }
    if (node.type !== "tag") return;
    if (node.tagName === "br") {
      out.push(current);
      current = "";
      return;
    }
    for (const child of node.children) walk(child);
  };

  el.contents().each((_, node) => walk(node));
  out.push(current);

  return out.map(collapse).filter((line) => line !== "");
}

export function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Find exactly the element the parser depends on, or fail loudly.
 *
 * The alternative — returning an empty selection and carrying on — is what turns a site redesign
 * into a pull that writes nothing and reports success.
 */
export function requireOne(
  $: CheerioAPI,
  selector: string,
  what: string,
  url?: string,
): Cheerio<AnyNode> {
  const found = $(selector).first();
  if (found.length === 0) throw new ParseError(`${what} not found`, selector, url);
  return found;
}

/**
 * Find the table that contains a cell reading exactly `label`, optionally scoped to a container.
 *
 * Content-anchored rather than position-anchored: a table index is an accident of layout that an
 * ad slot or a sidebar can shift, whereas "the table with an NTRP column" is what the page is
 * about. `within` matters on pages that render the same data twice — a TennisRecord team page has
 * two `div.large` blocks (roster and schedule) and two renderings of each.
 */
export function tableWithCellText(
  $: CheerioAPI,
  label: string,
  within = "body",
): Cheerio<AnyNode> | null {
  const cell = $(within)
    .find("th, td")
    .filter((_, el) => collapse($(el).text()) === label)
    .first();
  return cell.length === 0 ? null : cell.closest("table");
}

/**
 * Assert a table's ordered column contract before anything is decoded by position.
 *
 * Positional decoding makes the column *order* the contract. Locating the right table proves
 * nothing about where its fields sit inside it, and neither does a minimum cell count: insert one
 * column and every later offset shifts while nullable parsers absorb the mismatch into
 * plausible-looking values. Every positionally-decoded table in this layer routes through here, so
 * the guarantee is uniform rather than remembered per parser.
 *
 * Headers are compared with whitespace stripped and lower-cased, because these pages put `<br>`
 * inside header cells (`Local<br>Singles`) and some carry a year (`2026<br>Record`).
 * (Provenance: Codex adversarial review rounds 3-5 on PR #26, which found this same defect in
 * four separate tables.)
 */
export function assertColumns(
  $: CheerioAPI,
  table: Cheerio<AnyNode>,
  expected: RegExp[],
  what: string,
  source: { url: string },
): void {
  const headers = table
    .find("tr")
    .first()
    .find("th, td")
    .map((_, cell) => collapse($(cell).text()).replace(/\s+/g, "").toLowerCase())
    .get();

  if (headers.length !== expected.length) {
    throw new ParseError(
      `${what} has ${headers.length} columns, expected ${expected.length} (${headers.join(", ")})`,
      `${what} tr th`,
      source.url,
    );
  }
  expected.forEach((pattern, index) => {
    const actual = headers[index] ?? "";
    if (!pattern.test(actual)) {
      throw new ParseError(
        `${what} column ${index} is "${actual}", expected ${String(pattern)}`,
        `${what} tr th:nth-child(${index + 1})`,
        source.url,
      );
    }
  });
}

/**
 * A number, or `null` for every way these pages spell "no value".
 *
 * `-----` (unrated / not yet calculated), `S` (self-rated), `------` (no projection) and an empty
 * cell all mean "there is no number here" and must not become `0` — a zero rating is a real
 * rating, and it silently biases every average computed downstream.
 */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = collapse(raw).replace(/[()]/g, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * The one place US month/day/year parts become an ISO date, so the two entry points below cannot
 * disagree about the format or about the two-digit-year rule.
 *
 * A two-digit year is read as `20xx`. Read literally `24` is the year 24; read as what these pages
 * mean by it — a rating's effective date — it is 2024, and that date is the axis a rating
 * trajectory is plotted on.
 */
function isoFromUsParts(month: string, day: string, year: string): string {
  return `${year.length === 2 ? `20${year}` : year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * `11/15/2025` → `2025-11-15`, and **only** when the whole cell is that date.
 *
 * Anchored on purpose, and the anchoring is the contract its TennisRecord callers depend on: these
 * are positionally-decoded table cells, so a cell carrying a date *plus* other text is a cell this
 * parser has misidentified, not a date to salvage. `findUsDate` below asks the deliberately
 * different question, and widening this one to match it would start reading dates out of prose.
 */
export function parseUsDate(raw: string | undefined): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(collapse(raw ?? ""));
  if (match === null) return null;
  const [, month, day, year] = match;
  return isoFromUsParts(month ?? "", day ?? "", year ?? "");
}

/**
 * `Updated Date 12/31/24` → `2024-12-31`: the date **inside** a longer label.
 *
 * The other shape these pages use, and the one two different callers now meet — USTA's NTRP block
 * labels its date (`Updated Date 12/31/24`) and the WTN widget's section subtitles do the same
 * (`Updated 08/05/2026`, `Last Played 06/10/2025`). Both accept a two-digit year, which
 * `parseUsDate` does not, because both of these labels carry one in the wild.
 *
 * Returns `null` rather than a partially-built string when there is no date, so a caller that must
 * refuse can tell "no date" from "some date" — see `parseWtnWidget`, which throws on the former.
 *
 * **`\d{4}` is tried before `\d{2}`, and the order is load-bearing.** JS alternation is
 * leftmost-wins, not longest-match, so `(\d{2}|\d{4})` matches the `20` of `2026` and yields
 * `2020-08-05` — a plausible date, five years wrong, from a page that printed the right one. This
 * function was extracted from `parseNtrp`, which carried the reversed order; it was latent there
 * only because USTA's NTRP block always prints a two-digit year, and the WTN subtitles this now
 * also serves print four. (Issue #132.)
 */
export function findUsDate(raw: string | undefined): string | null {
  const match = /(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})/.exec(collapse(raw ?? ""));
  if (match === null) return null;
  const [, month, day, year] = match;
  return isoFromUsParts(month ?? "", day ?? "", year ?? "");
}

/** `10-5` → `{ wins: 10, losses: 5 }`; anything else → null. `0-0` is a record, not an absence. */
export function parseWinLoss(raw: string | undefined): { wins: number; losses: number } | null {
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(collapse(raw ?? ""));
  if (match === null) return null;
  return { wins: Number(match[1]), losses: Number(match[2]) };
}

/** Pull a query-string parameter out of an href, tolerating the unencoded spaces these pages emit. */
export function hrefParam(href: string | undefined, name: string): string | null {
  if (href === undefined) return null;
  const match = new RegExp(`[?&]${name}=([^&]*)`).exec(href);
  if (match === null) return null;
  try {
    return decodeURIComponent((match[1] ?? "").replace(/\+/g, " "));
  } catch {
    return match[1] ?? null;
  }
}
