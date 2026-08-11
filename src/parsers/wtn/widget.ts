import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { collapse, findUsDate, hrefParam } from "../dom.js";
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
const SUBTITLE = ".v-form-wtn-widget__section-subtitle";
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
 *
 * And it carries **two dates per section** — `Updated` (the ITF's publication date for the number)
 * and `Last Played`. Both were skipped until issue #132, on the strength of a code comment saying
 * the widget "shows only a current value"; every one of the 194 WTN sections in this project's
 * captures carries both, so the ingest was stamping the *capture* date onto a number the page had
 * dated itself. `Updated` is what `rating_observations.observed_on` is for.
 */
export function parseWtnWidget(html: string, source: SourceRef): WtnProfile | null {
  const $ = cheerio.load(html);
  const widgets = $(WIDGET);
  if (widgets.length === 0) return null;
  // Guarding duplicate section titles inside the first widget says nothing about a SECOND widget:
  // `.first()` would silently pick one by DOM order and drop a conflicting rating in the other.
  // Same reasoning as the section-level guard, one level up.
  // (Provenance: Codex adversarial review round 5 on PR #26.)
  if (widgets.length > 1) {
    throw new ParseError(`${widgets.length} WTN widgets on one profile`, WIDGET, source.url);
  }
  const widget = widgets.first();

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
        updatedOn: subtitleDate($, $el, "UPDATED", source),
        lastPlayedOn: subtitleDate($, $el, "LAST PLAYED", source),
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
    singles: ratingFrom($, sections, "WTN SINGLES", source),
    doubles: ratingFrom($, sections, "WTN DOUBLES", source),
  });
}

type WtnSection = {
  title: string;
  rawValue: string;
  updatedOn: string | null;
  lastPlayedOn: string | null;
  el: Cheerio<AnyNode>;
};

/**
 * The date guard lives **here**, at the one place the value is consumed, rather than beside the
 * value/title guards in the loop above. A section this function never reads is one whose date
 * nothing will ever store, and refusing a page over it would be a guard with no consequence to
 * protect; checking in both places would mean two conditions that must be kept agreeing.
 *
 * It fails closed, exactly like a recognised section whose value cannot be read. The alternative —
 * falling back to the capture date — is the defect #132 closes: downstream it is indistinguishable
 * from a genuine publication date, so nothing after this point could ever tell the two apart.
 * `lastPlayedOn` gets no such guard; nothing persists it, so it has no wrong value to produce.
 */
function ratingFrom(
  $: CheerioAPI,
  sections: WtnSection[],
  title: string,
  source: SourceRef,
): WtnRating | null {
  const found = sections.find((s) => s.title === title);
  if (found === undefined) return null;
  if (found.updatedOn === null) {
    throw new ParseError(`"${title}" section has no readable Updated date`, SUBTITLE, source.url);
  }
  return {
    value: Number(found.rawValue),
    confidence: collapse(found.el.find(CONFIDENCE).first().text()) || null,
    zone: parseZone(collapse(found.el.find(ZONE).first().text())),
    updatedOn: found.updatedOn,
    lastPlayedOn: found.lastPlayedOn,
  };
}

/**
 * The date out of the section subtitle labelled `label` — `Updated 08/05/2026` → `2026-08-05`.
 *
 * Selected by its **label**, never by its position among the subtitles: the two labels appear in
 * different orders on different sections of the same page, and picking `:nth-child` would read
 * "Last Played" as the publication date on whichever sections happen to be ordered the other way.
 * That failure is silent — both are valid dates.
 *
 * A section carrying the same label twice throws, on the same reasoning the duplicate-title and
 * duplicate-widget guards above are written from: `.first()` would let a stale or responsive second
 * subtitle silently decide which date a dossier prints.
 */
function subtitleDate(
  $: CheerioAPI,
  section: Cheerio<AnyNode>,
  label: string,
  source: SourceRef,
): string | null {
  const matching = section
    .find(SUBTITLE)
    .filter((_, el) => collapse($(el).text()).toUpperCase().startsWith(label))
    .get();
  if (matching.length === 0) return null;
  if (matching.length > 1) {
    throw new ParseError(`duplicate "${label}" subtitle in one WTN section`, SUBTITLE, source.url);
  }
  return findUsDate($(matching[0]).text());
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
