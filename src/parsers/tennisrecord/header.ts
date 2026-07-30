import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { collapse, lines, parseNumber, parseUsDate } from "../dom.js";
import {
  ParseError,
  ntrpRatingTypeSchema,
  tennisRecordHeaderSchema,
  type RatingObservation,
  type SourceRef,
  type TennisRecordHeader,
} from "../types.js";

const DYNAMIC_LABEL = "Estimated Dynamic Rating";
const PROJECTED_LABEL = "Projected Year End Rating";

/**
 * Parse the identity + ratings block TennisRecord repeats at the top of every player page
 * (profile, match history, player stats).
 *
 * Anchored on the "Estimated Dynamic Rating" label rather than a table index: the label is
 * content the page is about, while a position is an accident of layout that a sidebar or an ad
 * slot can shift without anyone touching the data.
 */
export function parseTennisRecordHeader(html: string, source: SourceRef): TennisRecordHeader {
  const $ = cheerio.load(html);
  return parseHeaderFrom($, source);
}

/** Shared with the profile parser, which needs the header and the rest of the page from one load. */
export function parseHeaderFrom($: CheerioAPI, source: SourceRef): TennisRecordHeader {
  const label = labelCell($, DYNAMIC_LABEL);
  if (label === null) {
    throw new ParseError(
      "player header block not found",
      `td:contains("${DYNAMIC_LABEL}")`,
      source.url,
    );
  }
  const table = label.closest("table");
  const identityRow = table.find("tr").first();
  const identityParts = lines($, identityRow.find("td").first());
  const identity = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(identityParts[0] ?? "");

  const ntrpParts = lines($, identityRow.find("td").eq(1));
  const dynamicParts = lines($, label.closest("tr").find("td").eq(1));
  const projectedLabel = labelCell($, PROJECTED_LABEL);
  const projectedParts =
    projectedLabel === null ? [] : lines($, projectedLabel.closest("tr").find("td").eq(1));

  return tennisRecordHeaderSchema.parse({
    name: identity?.[1] ?? identityParts[0] ?? "",
    location: identity?.[2] ?? null,
    gender: genderOf(identityParts[1]),
    ntrp: ntrpObservation(ntrpParts, source),
    dynamicRating: observation("tr_dynamic", dynamicParts),
    projectedYearEndRating: parseNumber(projectedParts[0]),
  });
}

function labelCell($: CheerioAPI, label: string): Cheerio<AnyNode> | null {
  const found = $("td")
    .filter((_, td) => collapse($(td).text()) === label)
    .first();
  return found.length === 0 ? null : found;
}

function genderOf(raw: string | undefined): "Male" | "Female" | null {
  const value = collapse(raw ?? "");
  return value === "Male" || value === "Female" ? value : null;
}

/**
 * `["4.0 C", "12/31/2025"]` → a dated NTRP observation.
 *
 * An unrecognised type letter throws rather than degrading to `null`: a self-rated 4.0 and a
 * computer-rated 4.0 are different players to scout, so quietly discarding the letter would hide
 * the very distinction the field exists for.
 */
function ntrpObservation(parts: string[], source: SourceRef): RatingObservation | null {
  const match = /^([0-9](?:\.[05])?)(?:\s+([A-Za-z]))?$/.exec(parts[0] ?? "");
  const observedOn = parseUsDate(parts[1]);
  if (match === null || observedOn === null) return null;

  let ratingType: string | null = null;
  if (match[2] !== undefined) {
    const letter = match[2].toUpperCase();
    if (!ntrpRatingTypeSchema.safeParse(letter).success) {
      throw new ParseError(`unrecognised NTRP rating type "${letter}"`, "header ntrp", source.url);
    }
    ratingType = letter;
  }

  return { source: "ntrp", value: Number(match[1]), ratingType, observedOn } as RatingObservation;
}

function observation(
  source: RatingObservation["source"],
  parts: string[],
): RatingObservation | null {
  const value = parseNumber(parts[0]);
  const observedOn = parseUsDate(parts[1]);
  if (value === null || observedOn === null) return null;
  return { source, value, ratingType: null, observedOn };
}
