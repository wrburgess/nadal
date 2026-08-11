import * as cheerio from "cheerio";
import { collapse, hrefParam } from "../dom.js";
import { ParseError, wtnPlayerProfileSchema, type SourceRef, type WtnPlayerProfile } from "../types.js";

// Attribute-CONTAINS, never a whole class name (`class*=`, not `class=`): worldtennisnumber.com's
// build appends a per-deploy hash to every CSS module class — `playerDetailsHeader___p1yB3` today,
// something else after the next deploy — and a whole-class selector breaks on the very first one.
// `playerDetailsHeader` is the stable, human-authored half of the name and is what this parser
// anchors on; verified against a live capture to occur exactly once in the document.
const IDENTITY_BLOCK = '[class*="playerDetailsHeader"]';
const NAME = "h2";

// The WHOLE identity paragraph, not a `startsWith` on the gender word: `Male|41-50|USA`. Anchored
// at the start so a reordered or relabelled line (`41-50|Male|USA`, `M|41-50|USA`) matches nothing
// and refuses, the same direction `parseWtnWidget`'s `subtitleDate` always fails in. Not anchored
// at the end — the trailing segment is a country name (plus, on the real page, a flag `<img>` that
// contributes no text of its own), and constraining its exact text would refuse a real profile over
// a field this parser does not read.
const IDENTITY_LINE = /^(Male|Female)\|([^|]+)\|/;

/**
 * Parse a player's own WTN profile page (worldtennisnumber.com) for the two fields only this page
 * can supply — `gender` and `ageRange` (issue #128). Deliberately narrow: this page also renders a
 * WTN rating, but issue #132 already settled the USTA-embedded ITF widget as the rating source of
 * record, so a second, independent number from a second page is not read here at all — see
 * `WtnPlayerProfile`'s doc comment in `../types.js`.
 *
 * `tennisId` is read from `source.url`'s own `tennis-id` query parameter, never from the document
 * body — the same reasoning `parseUstaProfile`'s `uaid` follows for the USTA page's URL fragment.
 * Without it the record cannot be resolved to a player at ingest (`src/ingest/wtn-profile-pull.ts`),
 * so a source URL that carries none is a refusal to build the record, not a null field.
 */
export function parseWtnProfile(html: string, source: SourceRef): WtnPlayerProfile {
  const $ = cheerio.load(html);

  const tennisId = hrefParam(source.url, "tennis-id");
  if (tennisId === null) {
    throw new ParseError("no tennis-id in the source URL", "source.url#tennis-id", source.url);
  }

  const blocks = $(IDENTITY_BLOCK);
  if (blocks.length === 0) {
    throw new ParseError("player identity block not found", IDENTITY_BLOCK, source.url);
  }
  // Same reasoning as `parseWtnWidget`'s duplicate-widget guard: `.first()` would silently pick
  // one by DOM order and drop a conflicting name/gender/age-range in the other, rather than
  // refusing over a page shape this parser has never verified.
  if (blocks.length > 1) {
    throw new ParseError(`${blocks.length} player identity blocks on one page`, IDENTITY_BLOCK, source.url);
  }
  const block = blocks.first();

  const name = collapse(block.find(NAME).first().text());
  if (name === "") {
    throw new ParseError("player name not found", `${IDENTITY_BLOCK} ${NAME}`, source.url);
  }

  const identityLines = block
    .find("p")
    .filter((_, p) => IDENTITY_LINE.test(collapse($(p).text())))
    .get();
  if (identityLines.length === 0) {
    throw new ParseError("player identity line not found", `${IDENTITY_BLOCK} p`, source.url);
  }
  if (identityLines.length > 1) {
    throw new ParseError("more than one player identity line on one page", `${IDENTITY_BLOCK} p`, source.url);
  }

  const match = IDENTITY_LINE.exec(collapse($(identityLines[0]).text()));
  // `identityLines.length === 1` above already proved this matches; the assertion is for the type
  // checker, not a second runtime guard.
  if (match === null) {
    throw new ParseError("player identity line not found", `${IDENTITY_BLOCK} p`, source.url);
  }
  const [, gender, ageRangeRaw] = match;
  const ageRange = collapse(ageRangeRaw ?? "");
  if (ageRange === "") {
    throw new ParseError("player identity line has no age range", `${IDENTITY_BLOCK} p`, source.url);
  }

  return wtnPlayerProfileSchema.parse({
    name,
    tennisId,
    gender,
    ageRange,
  });
}
