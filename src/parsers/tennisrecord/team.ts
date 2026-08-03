import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import {
  assertColumns,
  collapse,
  hrefParam,
  parseNumber,
  parseUsDate,
  parseWinLoss,
  tableWithCellText,
} from "../dom.js";
import {
  ParseError,
  tennisRecordTeamSchema,
  type SourceRef,
  type TeamRosterEntry,
  type TeamScheduleRow,
  type TennisRecordTeam,
} from "../types.js";

const ROSTER_SCOPE = "div.large";
const ROSTER_COLUMN = "NTRP";
const SCHEDULE_COLUMN = "Local Schedule";

/**
 * The roster's column contract, keyed by header NAME rather than by position (issue #92).
 *
 * Position was the original contract, and it was fragile in the direction that matters: cells were
 * decoded by index, so a column inserted before `Rating` shifted every field after it — locations
 * became ratings and ratings became win/loss strings, absorbed into plausible-looking nulls without
 * an error. The exact-count assertion existed to make that loud (PR #26 round 3), and it did its
 * job: a real Sectionals opponent that had played postseason returned ELEVEN columns and the pull
 * was refused rather than misread.
 *
 * Refusing every such team is not a fix, though — every team that qualifies for Sectionals has by
 * definition played postseason. Reading by name removes the shift hazard itself, so the optional
 * block below can be tolerated without reopening the defect the count was guarding.
 *
 * Matched on whitespace-stripped, lower-cased header text, because the page writes these with
 * `<br>` inside them (`Local<br>Singles`) and the season column carries a year (`2026<br>Record`).
 */
type RosterField =
  | "name"
  | "location"
  | "ntrp"
  | "seasonRecord"
  | "localSingles"
  | "localDoubles"
  | "localRecord"
  | "dynamicRating";

/** Header text -> the field it carries. Every REQUIRED field appears exactly once. */
const ROSTER_FIELD_BY_HEADER: { pattern: RegExp; field: RosterField }[] = [
  { pattern: /^name$/, field: "name" },
  { pattern: /^location$/, field: "location" },
  { pattern: /^ntrp$/, field: "ntrp" },
  // The season column carries the year: `2026Record`. Anchored to digits so it cannot also match
  // `localrecord` or `postseasonrecord`, which are different columns entirely.
  { pattern: /^\d{4}record$/, field: "seasonRecord" },
  { pattern: /^localsingles$/, field: "localSingles" },
  { pattern: /^localdoubles$/, field: "localDoubles" },
  { pattern: /^localrecord$/, field: "localRecord" },
  { pattern: /^rating$/, field: "dynamicRating" },
];

/**
 * Columns that may be present and carry no field we read.
 *
 * A team page grows these once its postseason is on record. They are RECOGNIZED rather than
 * ignored: an unknown header still refuses (below), because an open vocabulary would silently
 * accept a page that had *renamed* or *dropped* a column we do rely on. The postseason MATCHES
 * themselves arrive through the `--players` cascade as ordinary court matches carrying their own
 * league context (measured: `Adult 40+ 3.5 Districts`), so nothing here needs to read them.
 */
const OPTIONAL_ROSTER_HEADERS: RegExp[] = [
  /^postseasonsingles$/,
  /^postseasondoubles$/,
  /^postseasonrecord$/,
];

/**
 * The local schedule's ordered column contract — team_matches candidates, not court_matches: date,
 * time, opponent team, site, result. Every header maps 1:1 to a body cell, unlike the roster's
 * `colspan`'d Rating column.
 */
const SCHEDULE_COLUMNS: RegExp[] = [
  /^localschedule$/,
  /^time$/,
  /^opponent$/,
  /^matchsite$/,
  /^result$/,
];

/**
 * Parse a TennisRecord team profile: the team's league context and its roster with ratings.
 *
 * This is the roster discovery path for scouting an opposing team. TennisLink's own team pages
 * moved behind an OAuth login (see `docs/findings.md`), so until a login-assisted capture exists
 * this is how a `Team` and its `TeamMembership` rows get populated.
 */
/**
 * Read the roster header row into a field -> cell-index map, and derive how wide a body row must be.
 *
 * Three separate guards, each replacing something the positional contract used to provide:
 *
 * 1. **Every header must be recognized.** An unknown column refuses. An open vocabulary that merely
 *    skipped what it did not know would silently accept a page that RENAMED or DROPPED a column we
 *    rely on — failing in the invisible direction, which is worse than the refusal being fixed here.
 * 2. **Every required field must be present, exactly once.** A duplicate header is a page change,
 *    not a preference, and picking either one would be a guess.
 * 3. **The body-row width is derived from the header's own colspans**, never a constant: the
 *    `Rating` header carries `colspan="2"`, so 8 headers describe 9 cells and 11 describe 12. A
 *    constant would have been wrong for the second shape in exactly the way the first constant was.
 */
function mapRosterColumns(
  $: CheerioAPI,
  table: Cheerio<AnyNode>,
  source: SourceRef,
): { index: Record<RosterField, number>; rowCells: number } {
  const headerCells = table.find("tr").first().find("th, td");
  const index = {} as Record<RosterField, number>;
  const seen = new Set<RosterField>();
  let cellCursor = 0;
  let rowCells = 0;

  headerCells.each((_, cell) => {
    const text = collapse($(cell).text()).replace(/\s+/g, "").toLowerCase();
    const span = Number($(cell).attr("colspan") ?? "1");
    const width = Number.isFinite(span) && span > 0 ? span : 1;
    const known = ROSTER_FIELD_BY_HEADER.find((c) => c.pattern.test(text));
    if (known !== undefined) {
      if (seen.has(known.field)) {
        throw new ParseError(
          `team roster has two "${text}" columns`,
          `${ROSTER_SCOPE} tr th`,
          source.url,
        );
      }
      seen.add(known.field);
      index[known.field] = cellCursor;
    } else if (!OPTIONAL_ROSTER_HEADERS.some((p) => p.test(text))) {
      throw new ParseError(
        `team roster has an unrecognized column "${text}"`,
        `${ROSTER_SCOPE} tr th`,
        source.url,
      );
    }
    cellCursor += width;
    rowCells += width;
  });

  const missing = ROSTER_FIELD_BY_HEADER.filter((c) => !seen.has(c.field)).map((c) => c.field);
  if (missing.length > 0) {
    throw new ParseError(
      `team roster is missing required column(s): ${missing.join(", ")}`,
      `${ROSTER_SCOPE} tr th`,
      source.url,
    );
  }
  return { index, rowCells };
}

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
  const columns = mapRosterColumns($, table, source);

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
      if (cells.length !== columns.rowCells) {
        throw new ParseError(
          `roster row has ${cells.length} cells, expected exactly ${columns.rowCells}`,
          `${ROSTER_SCOPE} tr td`,
          source.url,
        );
      }
      const at = (field: RosterField): string => cells[columns.index[field]] ?? "";
      const name = at("name");
      // A structurally valid row with no name is a page change, not an empty roster slot.
      // Filtering it away produced a plausible roster with a player quietly missing.
      // (Provenance: Codex adversarial review round 7 on PR #26.)
      if (name === "") {
        throw new ParseError("roster row has no player name", `${ROSTER_SCOPE} tr td`, source.url);
      }
      return {
        name,
        location: at("location") || null,
        ntrp: parseNumber(at("ntrp")),
        seasonRecord: parseWinLoss(at("seasonRecord")),
        localSingles: parseWinLoss(at("localSingles")),
        localDoubles: parseWinLoss(at("localDoubles")),
        localRecord: parseWinLoss(at("localRecord")),
        dynamicRating: parseNumber(at("dynamicRating")),
        // The roster row's own href, unmodified — Phase 3's re-pull handle. A row with no link
        // (no `<a>` around the name) yields null, which the pipeline reports rather than skips.
        profilePath: $(tr).find("td").first().find("a").attr("href") ?? null,
      } satisfies TeamRosterEntry;
    })
    .get();

  const schedule = parseSchedule($, source);

  return tennisRecordTeamSchema.parse({ ...header, roster, schedule });
}

/**
 * The team's local schedule — a second table on the same page, entirely distinct from the roster:
 * `team_matches` candidates (date, opponent TEAM, site, result) rather than per-court detail.
 *
 * Anchored on its own content marker (the "Local Schedule" header cell) rather than on "the
 * second `div.large` block" — `div.large` is ambiguous on this page (it wraps both tables), and a
 * positional selector already caused a Phase-2 defect here (see docs/findings.md).
 */
function parseSchedule($: CheerioAPI, source: SourceRef): TeamScheduleRow[] {
  const table = tableWithCellText($, SCHEDULE_COLUMN, ROSTER_SCOPE);
  if (table === null) {
    throw new ParseError(
      "team schedule table not found",
      `${ROSTER_SCOPE} table with a "${SCHEDULE_COLUMN}" column`,
      source.url,
    );
  }
  assertColumns($, table, SCHEDULE_COLUMNS, "team schedule", source);

  return table
    .find("tr")
    .filter((_, tr) => $(tr).find("td").length > 0)
    .map((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length !== SCHEDULE_COLUMNS.length) {
        throw new ParseError(
          `schedule row has ${cells.length} cells, expected exactly ${SCHEDULE_COLUMNS.length}`,
          `${ROSTER_SCOPE} tr td`,
          source.url,
        );
      }
      const cell = (index: number) => $(cells.get(index));

      const playedOn = parseUsDate(cell(0).text());
      if (playedOn === null) {
        throw new ParseError(
          `unparseable schedule date "${collapse(cell(0).text())}"`,
          `${ROSTER_SCOPE} tr td:nth-child(1)`,
          source.url,
        );
      }
      const opponentTeamName = collapse(cell(2).text());
      if (opponentTeamName === "") {
        throw new ParseError(
          `schedule row on ${playedOn} has no opponent team`,
          `${ROSTER_SCOPE} tr td:nth-child(3)`,
          source.url,
        );
      }

      // An unplayed fixture's result cell carries no result link at all, so a schedule row
      // legitimately has no `mid=` — unlike a match-history row, whose missing id IS a structural
      // failure (see `match-history.ts`). What the two DO share is that `mid=` with an empty value
      // is as unusable an idempotency key as a missing one, so both normalize `""` to null rather
      // than letting every empty-id row collide under the partial unique index.
      const rawSourceMatchId = hrefParam(cell(4).find("a").attr("href"), "mid");

      return {
        playedOn,
        scheduledTime: collapse(cell(1).text()) || null,
        opponentTeamName,
        site: collapse(cell(3).text()) || null,
        result: collapse(cell(4).text()) || null,
        sourceMatchId: rawSourceMatchId === "" ? null : rawSourceMatchId,
      } satisfies TeamScheduleRow;
    })
    .get();
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
): Omit<TennisRecordTeam, "roster" | "schedule"> {
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
