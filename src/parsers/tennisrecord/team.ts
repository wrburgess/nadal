import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { collapse, parseNumber, parseWinLoss, tableWithCellText } from "../dom.js";
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
  assertRosterColumns($, table, source);

  const roster = table
    .find("tr")
    .filter((_, tr) => $(tr).find("td").length > 0)
    .map((_, tr) => {
      const cells = $(tr)
        .find("td")
        .map((_i, td) => collapse($(td).text()))
        .get();
      if (cells.length < ROSTER_COLUMNS.length) {
        throw new ParseError(
          `roster row has ${cells.length} cells, expected at least ${ROSTER_COLUMNS.length}`,
          `${ROSTER_SCOPE} tr`,
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

/** Verify the ordered column contract before any positional decoding happens. */
function assertRosterColumns(
  $: CheerioAPI,
  table: Cheerio<AnyNode>,
  source: SourceRef,
): void {
  const headers = table
    .find("tr")
    .first()
    .find("th")
    .map((_, th) => collapse($(th).text()).replace(/\s+/g, "").toLowerCase())
    .get();

  if (headers.length !== ROSTER_COLUMNS.length) {
    throw new ParseError(
      `roster has ${headers.length} columns, expected ${ROSTER_COLUMNS.length} (${headers.join(", ")})`,
      `${ROSTER_SCOPE} tr th`,
      source.url,
    );
  }
  ROSTER_COLUMNS.forEach((expected, index) => {
    const actual = headers[index] ?? "";
    if (!expected.test(actual)) {
      throw new ParseError(
        `roster column ${index} is "${actual}", expected ${String(expected)}`,
        `${ROSTER_SCOPE} tr th:nth-child(${index + 1})`,
        source.url,
      );
    }
  });
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
