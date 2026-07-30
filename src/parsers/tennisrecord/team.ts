import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
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

  const roster = table
    .find("tr")
    .filter((_, tr) => $(tr).find("td").length > 0)
    .map((_, tr) => {
      const cells = $(tr)
        .find("td")
        .map((_i, td) => collapse($(td).text()))
        .get();
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
