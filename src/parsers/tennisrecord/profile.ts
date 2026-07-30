import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { assertColumns, collapse, parseNumber, parseUsDate, tableWithCellText } from "../dom.js";
import { parseHeaderFrom } from "./header.js";
import {
  ParseError,
  tennisRecordProfileSchema,
  type RecentTeam,
  type SeasonRecord,
  type SourceRef,
  type TennisRecordProfile,
} from "../types.js";

const PLAYING_AREAS_LABEL = "Current Playing Areas (Player Rating Lists)";
const RECENT_TEAM_LABEL = "Recent Team";
const SEASON_LABEL = "All Matches";

/** The recent-team table's ordered contract — positionally decoded, so order is the contract. */
const RECENT_TEAM_COLUMNS: RegExp[] = [
  /^recentteam$/,
  /^type$/,
  /^section$/,
  /^gender$/,
  /^rating$/,
  /^matchstart$/,
];

/**
 * The aggregate table's ordered column contract: year + (total, win, loss, pct) for matches, sets
 * and games, then defaults.
 *
 * A *minimum* cell count is not enough. Insert one numeric column anywhere before the last decoded
 * field and the row still has fourteen-or-more numeric cells, so every offset shifts and parsing
 * succeeds with totals read from the wrong columns — the same silent corruption a count check was
 * meant to prevent, just one step further along.
 * (Provenance: Codex adversarial review round 4 on PR #26.)
 */
const AGGREGATE_COLUMNS: RegExp[] = [
  /^allmatches$/,
  /^totalmatches$/,
  /^win$/,
  /^loss$/,
  /^wpct$/,
  /^totalsets$/,
  /^win$/,
  /^loss$/,
  /^wpct$/,
  /^totalgames$/,
  /^win$/,
  /^loss$/,
  /^wpct$/,
  /^defaults$/,
];
const AGGREGATE_CELLS = AGGREGATE_COLUMNS.length;

/**
 * Parse a TennisRecord player profile: where the player currently rates, which teams they have
 * appeared for, and their per-season aggregate record.
 *
 * The recent-team list is what makes cross-league scouting possible — the same player shows up
 * under Adult 18+ and Adult 40+, and § Domain model requires both to be ingested with their
 * league context intact.
 */
export function parseTennisRecordProfile(html: string, source: SourceRef): TennisRecordProfile {
  const $ = cheerio.load(html);

  return tennisRecordProfileSchema.parse({
    header: parseHeaderFrom($, source),
    playingAreas: parsePlayingAreas($),
    recentTeams: parseRecentTeams($, source),
    seasonRecords: parseSeasonRecords($, source),
  });
}

function parsePlayingAreas($: CheerioAPI): string[] {
  const table = tableWithCellText($, PLAYING_AREAS_LABEL);
  if (table === null) return [];
  return table
    .find("tr")
    .slice(1)
    .map((_, tr) => collapse($(tr).text()))
    .get()
    .filter((value) => value !== "");
}

function parseRecentTeams($: CheerioAPI, source: SourceRef): RecentTeam[] {
  const table = tableWithCellText($, RECENT_TEAM_LABEL);
  if (table === null) return [];
  assertColumns($, table, RECENT_TEAM_COLUMNS, "recent-team table", source);

  return table
    .find("tr")
    .slice(1)
    .map((_, tr) => {
      const cells = $(tr)
        .find("td")
        .map((_i, td) => collapse($(td).text()))
        .get();
      if (cells.length !== RECENT_TEAM_COLUMNS.length) {
        throw new ParseError(
          `recent-team row has ${cells.length} cells, expected exactly ${RECENT_TEAM_COLUMNS.length}`,
          `${RECENT_TEAM_LABEL} tr`,
          source.url,
        );
      }
      const teamName = cells[0] ?? "";
      // Same fail-open shape as the roster: filtering the row away silently loses a player's
      // league/season affiliation while the rest of the profile still looks complete.
      if (teamName === "") {
        throw new ParseError(
          "recent-team row has no team name",
          `${RECENT_TEAM_LABEL} tr td`,
          source.url,
        );
      }
      return {
        teamName,
        leagueType: cells[1] ?? null,
        section: cells[2] ?? null,
        gender: cells[3] ?? null,
        ratingLevel: cells[4] ?? null,
        matchStartOn: parseUsDate(cells[5]),
      };
    })
    .get();
}

/**
 * The aggregate table: one row per year, then a totals row.
 *
 * The totals row is kept as its own record rather than recomputed from the year rows. It is the
 * site's own claim, and a disagreement between it and the years is a signal the page changed —
 * information that silently reconciling the two would destroy.
 */
function parseSeasonRecords($: CheerioAPI, source: SourceRef): SeasonRecord[] {
  const table = tableWithCellText($, SEASON_LABEL);
  if (table === null) {
    throw new ParseError(
      "season record table not found",
      `th:contains("${SEASON_LABEL}")`,
      source.url,
    );
  }

  assertColumns($, table, AGGREGATE_COLUMNS, "season table", source);

  return table
    .find("tr")
    .slice(1)
    .map((_, tr) => {
      const cells = $(tr)
        .find("td")
        .map((_i, td) => collapse($(td).text()))
        .get();
      // Columns: year, then (total, win, loss, pct) for matches / sets / games, then defaults.
      // The percentages are derived and deliberately dropped — recomputing them from the counts
      // is exact, whereas storing a rounded copy invites the two to disagree.
      const year = cells[0] ?? "";
      // Same class again, found by applying the reviewer's finding to its siblings rather than
      // waiting to be told: a structurally valid aggregate row with no year was dropped.
      if (year === "") {
        throw new ParseError("season row has no year", `${SEASON_LABEL} tr td`, source.url);
      }
      // EXACT, not minimum: an inserted column keeps the row above any minimum while shifting
      // every offset after it.
      if (cells.length !== AGGREGATE_CELLS) {
        throw new ParseError(
          `season row "${year}" has ${cells.length} cells, expected exactly ${AGGREGATE_CELLS}`,
          `${SEASON_LABEL} tr`,
          source.url,
        );
      }
      return {
        year,
        matches: counts(cells, 1, year, source),
        sets: counts(cells, 5, year, source),
        games: counts(cells, 9, year, source),
        defaults: count(cells, 13, year, source),
      };
    })
    .get();
}

function counts(
  cells: string[],
  at: number,
  year: string,
  source: SourceRef,
): { total: number; wins: number; losses: number } {
  return {
    total: count(cells, at, year, source),
    wins: count(cells, at + 1, year, source),
    losses: count(cells, at + 2, year, source),
  };
}

/**
 * Every aggregate cell must hold a real number.
 *
 * Coercing a missing or unparsable cell to `0` turns column drift into *statistics*: a season row
 * claiming zero wins, zero losses and zero games reads as a player who did not play, and it is
 * indistinguishable from one who did. That is a corrupted historical scouting signal delivered
 * with no error at all — the exact shape this parser layer exists to refuse.
 * (Provenance: Codex adversarial review round 3 on PR #26.)
 */
function count(cells: string[], at: number, year: string, source: SourceRef): number {
  const value = parseNumber(cells[at]);
  if (value === null) {
    throw new ParseError(
      `season row "${year}" column ${at} is not a number ("${cells[at] ?? ""}")`,
      `${SEASON_LABEL} td:nth-child(${at + 1})`,
      source.url,
    );
  }
  return value;
}
