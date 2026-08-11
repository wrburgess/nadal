import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { collapse, findUsDate, hrefParam } from "../dom.js";
import {
  ParseError,
  ntrpRatingTypeSchema,
  ustaProfileSchema,
  type RatingObservation,
  type SourceRef,
  type UstaProfile,
} from "../types.js";

const NAME = '[data-element-name="fullName"] .readonly-text__text h3';
const CONTEXT = '[data-element-name="nameGenderAddress"] .readonly-text__text';
const NTRP = '[data-element-name="ntrpSummary"]';
const WTN_LINK = "a.v-form-wtn-widget__navigation-link";

/**
 * Parse a USTA player-search profile: identity, league context, and the dated NTRP rating.
 *
 * The page is a client-rendered SPA; these fixtures are its post-render DOM, which is what the
 * login-assisted scraper captures. Fields are read from `data-element-name` anchors — the page's
 * own semantic hooks — rather than from a page-wide text scrape, so a value can never be supplied
 * by unrelated chrome that happens to contain the right word.
 *
 * The WTN half of the same page has its own parser (`src/parsers/wtn/widget.ts`): one fetch,
 * two records. Spec § Ingestion lists WTN as a separate source, which it is organisationally —
 * but not as a separate fetch.
 */
export function parseUstaProfile(html: string, source: SourceRef): UstaProfile {
  const $ = cheerio.load(html);

  const name = collapse($(NAME).first().text());
  if (name === "") throw new ParseError("player name not found", NAME, source.url);

  // The uaid lives in the URL fragment and nowhere in the document. Without it the record cannot
  // be resolved to a player at ingest, and spec § Ingestion forbids a silent merge — so this is
  // a refusal to build the record, not a null field.
  const uaid = uaidFrom(source.url);
  if (uaid === null) {
    throw new ParseError("no uaid in the source URL", "source.url#uaid", source.url);
  }

  const context = contextLines($, source);

  return ustaProfileSchema.parse({
    name,
    uaid,
    gender: context.gender,
    location: context.location,
    section: context.labelled("Section"),
    district: context.labelled("District"),
    wtnTennisId: hrefParam($(WTN_LINK).first().attr("href"), "tennis-id"),
    ntrp: parseNtrp($, source),
  });
}

function uaidFrom(url: string): string | null {
  return /[#&?]uaid=(\d+)/.exec(url)?.[1] ?? null;
}

// The label USTA prints ahead of the gender value on live pages — `Competition Category: MALE`.
// The committed fixture predated this label entirely (issue #130): `players.gender` held this
// whole labelled string, verbatim, on all 77 rows that had a gender, because `contextLines` read
// `identity[0]` raw instead of stripping it. Kept alongside `KNOWN_LABELS` below rather than
// merged into it, because it is searched for FIRST and positionally, not merely stripped like
// `Section:`/`District:`/`Nationality:` are — see `GENDER_INDEX` in the block comment below.
const GENDER_LABEL = "Competition Category";

// The labels `labelled()` already strips. Also used to recognise a labelled field that has landed
// in the *location* position (see `location` below) so a page missing a location paragraph does
// not silently mistake `Section: ...` for it.
const KNOWN_LABELS = [GENDER_LABEL, "Section", "District", "Nationality"];

/**
 * The context block is the identity paragraph(s) — gender and location — followed by
 * `Section:`/`District:`/`Nationality:` fields. Historically all of this arrived as exactly two
 * paragraphs: `MALE | Rivermont, MO` and `Section: Missouri Valley | District: Heart of America |
 * Nationality: USA`. Live USTA markup (issue #130) instead prefixes the gender segment with a
 * `Competition Category:` label, `&nbsp;`-separated from its value, and sometimes spreads the
 * identity across several one-field-per-`<p>` paragraphs (with an empty spacer `<p></p>` between
 * them) rather than one pipe-joined line — two shapes seen in the SAME live document.
 *
 * Every paragraph is flattened into one ordered list of pipe-delimited, non-empty segments —
 * `collapse()` already turns the `&nbsp;` (U+00A0) after the label's colon into an ordinary space,
 * since JS's `\s` treats U+00A0 as whitespace — so gender and location are found the same way
 * regardless of which paragraph or how many pipes they arrived on:
 *
 *  - **Gender** is the segment labelled `Competition Category:`, with the label stripped, if one
 *    exists; otherwise (the OLD, still-live shape) it is positionally the FIRST segment. Either
 *    way the value is emitted exactly as printed (`MALE`), like every other identity-adjacent
 *    value here — mapping the sources' different spellings onto one vocabulary is an ingest
 *    decision, made once where both sources meet (`src/ingest/normalize-gender.ts`, issue #130),
 *    not twice inside two parsers.
 *  - **Location** is positionally the segment right after gender's, UNLESS that segment is itself
 *    one of `KNOWN_LABELS` — which means the location paragraph is simply absent, not that
 *    `Section: ...` is the location.
 *
 * The block is **required**, and so is its identity paragraph. Letting it go missing produced a
 * record with a real name and uaid, an empty gender, and null location/section/district — a
 * profile that looks usable and carries no context at all, which is worse than one that failed.
 * (Provenance: Codex adversarial review round 3 on PR #26.)
 */
function contextLines(
  $: CheerioAPI,
  source: SourceRef,
): {
  gender: string | null;
  location: string | null;
  labelled: (label: string) => string | null;
} {
  const block = $(CONTEXT).first();
  if (block.length === 0) {
    throw new ParseError("player context block not found", CONTEXT, source.url);
  }

  const paragraphs = block
    .find("p")
    .map((_, p) => collapse($(p).text()))
    .get();

  const segments = paragraphs
    .flatMap((line) => line.split("|"))
    .map(collapse)
    .filter((segment) => segment !== "");

  const genderIndex = segments.findIndex((segment) => segment.startsWith(`${GENDER_LABEL}:`));
  const labelled = genderIndex !== -1;
  // The unlabelled fallback is positional, so it needs the SAME guard `location` applies below: a
  // page whose identity paragraph is missing entirely leaves `Section: ...` as the first surviving
  // segment, and taking it positionally would return a labelled field AS the gender — a real-looking
  // wrong value, which is exactly what the block comment above says is worse than failing. Guarding
  // only `location` (which is what the first cut of this change did) fixes the instance and leaves
  // the class: both fallbacks are positional, so both need it.
  const unlabelledCandidate = segments[0] ?? "";
  const unlabelledIsAnotherField = KNOWN_LABELS.some((label) =>
    unlabelledCandidate.startsWith(`${label}:`),
  );
  const genderRaw = labelled
    ? collapse(segments[genderIndex]!.slice(GENDER_LABEL.length + 1))
    : unlabelledIsAnotherField
      ? ""
      : unlabelledCandidate;

  if (genderRaw === "") {
    throw new ParseError("player context block has no identity line", `${CONTEXT} p`, source.url);
  }

  const locationCandidate = segments[(labelled ? genderIndex : 0) + 1];
  const location =
    locationCandidate !== undefined &&
    !KNOWN_LABELS.some((label) => locationCandidate.startsWith(`${label}:`))
      ? locationCandidate
      : null;

  return {
    gender: genderRaw,
    location,
    labelled: (label) => {
      const found = segments.find((field) => field.startsWith(`${label}:`));
      return found === undefined ? null : collapse(found.slice(label.length + 1));
    },
  };
}

/**
 * `3.5 C` plus `Updated Date 12/31/24` → a dated NTRP observation.
 *
 * The date conversion (including the two-digit-year rule this block's `12/31/24` needs) lives in
 * `findUsDate`, shared with the WTN widget's section subtitles — issue #132. It used to be an
 * inline copy here, which is how one page ends up with two answers for what `/25` means.
 */
function parseNtrp($: CheerioAPI, source: SourceRef): RatingObservation | null {
  const block = $(NTRP).first();
  if (block.length === 0) return null;

  const rating = /^([0-9](?:\.[05])?)(?:\s+([A-Za-z]))?$/.exec(
    collapse(block.find(".readonly-text__text").text()),
  );
  if (rating === null) return null;

  const observedOn = findUsDate(block.find(".readonly-text__subtext").text());
  if (observedOn === null) return null;

  let ratingType: string | null = null;
  if (rating[2] !== undefined) {
    const letter = rating[2].toUpperCase();
    if (!ntrpRatingTypeSchema.safeParse(letter).success) {
      throw new ParseError(`unrecognised NTRP rating type "${letter}"`, NTRP, source.url);
    }
    ratingType = letter;
  }

  return {
    source: "ntrp",
    value: Number(rating[1]),
    ratingType,
    observedOn,
  } as RatingObservation;
}
