import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { collapse, hrefParam } from "../dom.js";
import {
  ParseError,
  wtnProfileSchema,
  type SourceRef,
  type WtnProfile,
  type WtnRating,
} from "../types.js";

const WIDGET = ".v-form-wtn-widget";
const SECTION = ".v-form-wtn-widget__section";
const TITLE = ".v-form-wtn-widget__section-title";
const VALUE = ".v-form-wtn-widget__section-value";
const CONFIDENCE = ".v-form-wtn-widget__section-confidence";
const ZONE = ".v-form-wtn-widget__section-zone";
const ITF_TEXT = ".v-form-wtn-widget__itf-text";
const ITF_LINK = "a.v-form-wtn-widget__navigation-link";

/**
 * Parse the ITF World Tennis Number widget embedded in a USTA player profile.
 *
 * Returns `null` when the page carries no widget: plenty of USTA players have no WTN record, and
 * that is a fact about the player, not a structural failure of the page.
 *
 * Every value is read from inside a located `.v-form-wtn-widget__section`, never from page text.
 * courtgrab2 matched `/Singles:?\s*([0-9.]+)/` against the whole document, so any other "Singles"
 * anywhere on the page — navigation, a promo block, a related-player card — could supply a
 * player's rating, and the failure is invisible because the result still looks like a WTN.
 *
 * The widget also carries **confidence** and **game zone**, which the spreadsheet workflow this
 * replaces never captured. At 3.5 a low-confidence WTN and a high-confidence one are very
 * different evidence about the same number.
 */
export function parseWtnWidget(html: string, source: SourceRef): WtnProfile | null {
  const $ = cheerio.load(html);
  const widget = $(WIDGET).first();
  if (widget.length === 0) return null;

  const singles = section($, widget, "SINGLES");
  const doubles = section($, widget, "DOUBLES");

  // A widget that prints rating values but matches neither title is a page that changed its
  // section labels, not a player without ratings — and the two are indistinguishable in the
  // result, so the difference has to be made here or it is lost.
  if (singles === null && doubles === null && widget.find(VALUE).length > 0) {
    throw new ParseError("WTN widget present but no titled section matched", TITLE, source.url);
  }

  return wtnProfileSchema.parse({ tennisId: tennisId($, widget), singles, doubles });
}

function tennisId($: CheerioAPI, widget: Cheerio<AnyNode>): string | null {
  const fromLink = hrefParam(widget.find(ITF_LINK).first().attr("href"), "tennis-id");
  if (fromLink !== null) return fromLink;
  return /ITF Tennis ID\s+([A-Z0-9]+)/i.exec(collapse(widget.find(ITF_TEXT).first().text()))?.[1] ?? null;
}

function section(
  $: CheerioAPI,
  widget: Cheerio<AnyNode>,
  discipline: "SINGLES" | "DOUBLES",
): WtnRating | null {
  const found = widget
    .find(SECTION)
    .filter((_, el) => collapse($(el).find(TITLE).text()).toUpperCase() === `WTN ${discipline}`)
    .first();
  if (found.length === 0) return null;

  const value = Number(collapse(found.find(VALUE).first().text()));
  if (!Number.isFinite(value)) return null;

  return {
    value,
    confidence: collapse(found.find(CONFIDENCE).first().text()) || null,
    zone: parseZone(collapse(found.find(ZONE).first().text())),
  };
}

/** `GAME ZONE 30.87 TO 27.40` — printed high-to-low, since a lower WTN is a stronger player. */
function parseZone(raw: string): { from: number; to: number } | null {
  const match = /([\d.]+)\s+TO\s+([\d.]+)/i.exec(raw);
  if (match === null) return null;
  return { from: Number(match[1]), to: Number(match[2]) };
}
