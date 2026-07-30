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

/** `11/15/2025` → `2025-11-15`. Returns null when the cell is not a US-format date. */
export function parseUsDate(raw: string | undefined): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(collapse(raw ?? ""));
  if (match === null) return null;
  const [, month, day, year] = match;
  return `${year}-${month?.padStart(2, "0")}-${day?.padStart(2, "0")}`;
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
