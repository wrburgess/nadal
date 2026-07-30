import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { assertColumns, collapse, parseNumber, parseWinLoss, tableWithCellText } from "../dom.js";
import {
  ParseError,
  tennisRecordTeamSchema,
  type SourceRef,
  type TeamRosterEntry,
  type TennisRecordTeam,
} from "../types.js";

const ROSTER_SCOPE = "div.large";
const ROSTER_COLUMN = "NTRP";

/**
 * The roster's column contract, in order. Cells are decoded positionally, so the *order* is the
 * contract — anchoring on a single `NTRP` header proves the right table was found and nothing
 * about where anything is inside it. Drop the Location column and every field after it shifts by
 * one: locations become ratings, ratings become win/loss records, and the nullable parsers absorb
 * the mismatch into plausible-looking nulls without a single error.
 * (Provenance: Codex adversarial review round 3 on PR #26.)
 *
 * Matched on whitespace-stripped, lower-cased header text, because the page writes these with
 * `<br>` inside them (`Local<br>Singles`) and the season column carries a year (`2026<br>Record`).
 */
const ROSTER_COLUMNS: RegExp[] = [
  /^name$/,
  /^location$/,
  /^ntrp$/,
  /record$/,
  /^localsingles$/,
  /^localdoubles$/,
  /^localrecord$/,
  /^rating$/,
];

/**
 * The physical width of a roster BODY row, which is not the header count: the `Rating` header
 * spans two columns, so eight headers describe nine cells. Header count and row width have to be
 * tracked separately or "exact cell count" quietly means "at least as many as there are headers".
 */
const ROSTER_ROW_CELLS = 9;

/**
 * Parse a TennisRecord team profile: the team's league context and its roster with ratings.
 *
 * This is the roster discovery path for scouting an opposing team. TennisLink's own team pages
 * moved behind an OAuth login (see `docs/findings.md`), so until a login-assisted capture exists
 * this is how a `Team` and its `TeamMembership` rows get populated.
 */
export function parseTennisRecordTeam(html: string, source: SourceRef): TennisRecordTeam {
  const $ = cheerio.load(html);
  // The desktop container holds two tables — the roster and the local schedule — so scoping to
  // `div.large` alone would happily parse the schedule's date/opponent rows as roster entries.
  const table = tableWithCellText($, ROSTER_COLUMN, ROSTER_SCOPE);
  if (table === null) {
    throw new ParseError(
      "team roster table not found",
      `${ROSTER_SCOPE} table with an "${ROSTER_COLUMN}" column`,
      source.url,
    );
  }
  const header = parseHeader($, source);
  assertColumns($, table, ROSTER_COLUMNS, "team roster", source);

  const roster = table
    .find("tr")
    .filter((_, tr) => $(tr).find("td").length > 0)
    .map((_, tr) => {
      const cells = $(tr)
        .find("td")
        .map((_i, td) => collapse($(td).text()))
        .get();
      // EXACT, and against the ROW width rather than the header count — the two differ here
      // because the `Rating` header carries `colspan="2"`, so eight headers describe nine cells.
      // The earlier `>= headers.length` form accepted a body row with an extra cell inserted
      // before the rating and silently read a different column as the rating, while the
      // header-mutation tests never reached this guard because `assertColumns` threw first.
      // (Provenance: Codex adversarial review round 6 on PR #26.)
      if (cells.length !== ROSTER_ROW_CELLS) {
        throw new ParseError(
          `roster row has ${cells.length} cells, expected exactly ${ROSTER_ROW_CELLS}`,
          `${ROSTER_SCOPE} tr td`,
          source.url,
        );
      }
      return {
        name: cells[0] ?? "",
        location: cells[1] ?? null,
        ntrp: parseNumber(cells[2]),
        seasonRecord: parseWinLoss(cells[3]),
        localSingles: parseWinLoss(cells[4]),
        localDoubles: parseWinLoss(cells[5]),
        localRecord: parseWinLoss(cells[6]),
        dynamicRating: parseNumber(cells[7]),
      } satisfies TeamRosterEntry;
    })
    .get()
    .filter((entry) => entry.name !== "");

  return tennisRecordTeamSchema.parse({ ...header, roster });
}

/**
 * The header is three stacked rows: a single unpunctuated context line, the season name, and the
 * team name.
 *
 * The context line ("Adult 18+ Missouri Valley M 4.0") has no delimiters, so it is split by
 * pattern: the rating level and the one-letter gender are unambiguous at the end, and the league
 * type is recognised by its trailing age band. When that band is absent the split is genuinely
 * undecidable, so the parser reports `leagueType: null` and leaves the whole remainder in
 * `section` rather than guessing where one ends and the other begins.
 */
function parseHeader(
  $: CheerioAPI,
  source: SourceRef,
): Omit<TennisRecordTeam, "roster"> {
  const rows = $("table")
    .filter((_, table) => /^Adult|^Mixed|^Senior|^Tri-Level|^Combo/.test(collapse($(table).text())))
    .first()
    .find("tr");
  if (rows.length === 0) {
    throw new ParseError("team header block not found", "table (league context)", source.url);
  }

  const context = collapse(rows.eq(0).text());
  const withAgeBand = /^(.+?\d+\+)\s+(.+?)\s+([A-Z])\s+([\d.]+)$/.exec(context);
  const withoutAgeBand = /^(.+?)\s+([A-Z])\s+([\d.]+)$/.exec(context);

  return {
    teamName: collapse(rows.eq(2).text()),
    seasonName: collapse(rows.eq(1).text()) || null,
    leagueType: withAgeBand?.[1] ?? null,
    section: withAgeBand?.[2] ?? withoutAgeBand?.[1] ?? null,
    gender: withAgeBand?.[3] ?? withoutAgeBand?.[2] ?? null,
    ratingLevel: withAgeBand?.[4] ?? withoutAgeBand?.[3] ?? null,
  };
}
