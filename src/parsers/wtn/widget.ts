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

  // Every section is inspected, not just the two we want. Asking only "is there a SINGLES
  // section?" cannot tell a player who has no singles WTN from a page that renamed the singles
  // title, and it misses that distinction *per discipline*: a top-level "both are null" guard
  // stays quiet whenever the other discipline still parses, so a renamed SINGLES beside a working
  // DOUBLES silently erases a rating. (Provenance: Codex adversarial review round 3 on PR #26.)
  const sections = widget
    .find(SECTION)
    .map((_, el) => {
      const $el = $(el);
      return {
        title: collapse($el.find(TITLE).first().text()).toUpperCase(),
        rawValue: collapse($el.find(VALUE).first().text()),
        el: $el,
      };
    })
    .get();

  // A duplicate recognised title is not harmless: `ratingFrom` takes the first and drops the
  // rest, so a responsive or stale second widget silently decides which rating a dossier shows.
  // The USTA page does render other blocks twice (its identity block appears in a desktop and a
  // mobile variant), so this is not hypothetical markup.
  // (Provenance: Codex adversarial review round 4 on PR #26.)
  const titles = sections.map((s) => s.title).filter((t) => t !== "");
  const duplicated = titles.find((t, i) => titles.indexOf(t) !== i);
  if (duplicated !== undefined) {
    throw new ParseError(`duplicate WTN section "${duplicated}"`, TITLE, source.url);
  }

  for (const { title, rawValue } of sections) {
    const known = title === "WTN SINGLES" || title === "WTN DOUBLES";
    // `rawValue === ""` is checked explicitly: `Number("")` is `0`, which is finite, so a
    // finiteness test alone accepts an emptied value cell as a WTN of zero.
    if (known && (rawValue === "" || !Number.isFinite(Number(rawValue)))) {
      throw new ParseError(`"${title}" section has no numeric value`, VALUE, source.url);
    }
    if (!known && rawValue !== "") {
      throw new ParseError(`unrecognised WTN section title "${title}"`, TITLE, source.url);
    }
  }

  return wtnProfileSchema.parse({
    tennisId: tennisId($, widget),
    singles: ratingFrom($, sections, "WTN SINGLES"),
    doubles: ratingFrom($, sections, "WTN DOUBLES"),
  });
}

type WtnSection = { title: string; rawValue: string; el: Cheerio<AnyNode> };

function ratingFrom($: CheerioAPI, sections: WtnSection[], title: string): WtnRating | null {
  const found = sections.find((s) => s.title === title);
  if (found === undefined) return null;
  return {
    value: Number(found.rawValue),
    confidence: collapse(found.el.find(CONFIDENCE).first().text()) || null,
    zone: parseZone(collapse(found.el.find(ZONE).first().text())),
  };
}

function tennisId($: CheerioAPI, widget: Cheerio<AnyNode>): string | null {
  const fromLink = hrefParam(widget.find(ITF_LINK).first().attr("href"), "tennis-id");
  if (fromLink !== null) return fromLink;
  return /ITF Tennis ID\s+([A-Z0-9]+)/i.exec(collapse(widget.find(ITF_TEXT).first().text()))?.[1] ?? null;
}

/** `GAME ZONE 30.87 TO 27.40` — printed high-to-low, since a lower WTN is a stronger player. */
function parseZone(raw: string): { from: number; to: number } | null {
  const match = /([\d.]+)\s+TO\s+([\d.]+)/i.exec(raw);
  if (match === null) return null;
  return { from: Number(match[1]), to: Number(match[2]) };
}
