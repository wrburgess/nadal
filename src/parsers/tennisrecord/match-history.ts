import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import {
  assertColumns,
  collapse,
  hrefParam,
  lines,
  parseNumber,
  parseUsDate,
  requireOne,
} from "../dom.js";
import {
  ParseError,
  courtMatchRecordSchema,
  type CourtMatchRecord,
  type PlayerRef,
  type SetScore,
  type SourceRef,
} from "../types.js";

const DESKTOP_TABLE = "div.large table";
const MOBILE_MATCH = "div.small div.container496";

/**
 * The desktop table's ordered column contract. This is the highest-value table in the project and
 * it is decoded entirely by index, so it gets the same guarantee as every other positional table
 * here — locating the table proves nothing about where its fields sit inside it.
 */
const MATCH_COLUMNS: RegExp[] = [
  /^matchdate$/,
  /^league$/,
  /^team$/,
  /^court$/,
  /^partner$/,
  /^opponent\(s\)$/,
  /^w\/l$/,
  /^result$/,
  /^match$/,
  /^rating$/,
];

/**
 * The value a tournament entry prints in the desktop table's League column, and in the same
 * position of the mobile block. It is the POSITIVE signal that a teamless block is legitimate:
 * across all 281 archived pages it appears on 61 of 61 teamless rows and on 0 of 3996 league rows.
 */
const TOURNAMENT_LEAGUE_LABEL = "Tournament";

/**
 * Parse a TennisRecord player match history into one record per LEAGUE court played.
 *
 * This is the richest public source in the project: it carries the court slot, the partner, the
 * opponents, the score and the resulting dynamic rating for every match a player has played,
 * across every league they play in. Court-slot tendencies, partner frequency, prior meetings and
 * windowed records — the derived fields in spec § Deliverables — all reduce to these records.
 *
 * The page renders the same list twice, and the two renderings are not interchangeable: the
 * desktop table (`div.large`) has the full per-court detail but no opponent-team column, while
 * the mobile block (`div.small`) names the opponent team. We read the desktop table for the
 * record and take the opponent team from the mobile block by position, refusing to guess if the
 * two ever fall out of step.
 *
 * **Tournament courts are correlated and then omitted, not recorded.** A tournament entry is real
 * play, but it carries none of what a court record is keyed and scoped by: no TennisLink teams to
 * link, a draw position (`R2`, `C-F`, `16`) rather than a court slot, and — decisively — no `mid=`
 * match id, which is half of `court_match_source_unique`. Storing one would mean a row the next
 * pull cannot reconcile, so re-running the pull would duplicate it, breaking spec § Ingestion's
 * first discipline. They are still date-correlated like every other row before being dropped, so
 * omitting them cannot hide the two renderings falling out of step.
 */
export function parseMatchHistory(html: string, source: SourceRef): CourtMatchRecord[] {
  const $ = cheerio.load(html);
  const table = requireOne($, DESKTOP_TABLE, "match history table", source.url);
  assertColumns($, table, MATCH_COLUMNS, "match history table", source);

  const rows = table.find("tr").filter((_, tr) => $(tr).find("td").length > 0);
  if (rows.length === 0) return [];

  // Counted BEFORE the blocks are read, so renderings of different lengths report that fact rather
  // than whatever the first unpaired block happens to violate.
  const blocks = $(MOBILE_MATCH);
  if (blocks.length !== rows.length) {
    throw new ParseError(
      `desktop rendering has ${rows.length} matches but mobile rendering has ${blocks.length}`,
      `${DESKTOP_TABLE} / ${MOBILE_MATCH}`,
      source.url,
    );
  }

  // Which rows are tournaments is decided by the DESKTOP table, then required to agree with the
  // mobile block. Reading either rendering alone would let one of them silently reclassify a match.
  const isTournament = rows
    .toArray()
    .map((tr) => lines($, $($(tr).find("td").get(1)))[0] === TOURNAMENT_LEAGUE_LABEL);
  const correlates = parseMobileCorrelates($, blocks, isTournament, source);

  return rows
    .toArray()
    .map((tr, index) => {
      const correlate = correlates[index];
      // Unreachable while the length check above holds; kept as a type-level guarantee that the
      // record is never built from a missing correlate rather than as a runtime branch.
      if (correlate === undefined) {
        throw new ParseError(
          `no mobile block correlates with desktop row ${index}`,
          `${DESKTOP_TABLE} / ${MOBILE_MATCH}`,
          source.url,
        );
      }
      const row = $(tr);
      if (correlate.kind === "tournament") {
        assertTournamentRenderingsAgree($, row, correlate.playedOn, index, source);
        return null;
      }
      return parseRow($, row, correlate, source);
    })
    .filter((record): record is CourtMatchRecord => record !== null)
    .map((record) => {
      assertCardinality(record, source);
      return courtMatchRecordSchema.parse(record);
    });
}

type OpponentTeam = { kind: "league"; name: string; section: string | null; playedOn: string };
type TournamentEntry = { kind: "tournament"; playedOn: string };
type MatchCorrelate = OpponentTeam | TournamentEntry;

/**
 * The mobile block renders one small table per match, linking both teams — the profiled player's
 * and the opponent's — with the opponent second. We keep its date too, so the positional
 * correlation with the desktop table is verified rather than trusted.
 *
 * A league block that does not link exactly two teams throws. Returning a null opponent instead
 * would turn a mobile-markup change into scouting history that is silently missing who each match
 * was against, while every other field still looks correct. That refusal is unchanged: only a
 * block whose DESKTOP row positively declares a tournament is allowed to name no opponent team,
 * and it is then required to look like one (`parseTournamentBlock`).
 */
function parseMobileCorrelates(
  $: CheerioAPI,
  blocks: Cheerio<AnyNode>,
  isTournament: boolean[],
  source: SourceRef,
): MatchCorrelate[] {
  return blocks.toArray().map((block, index) => {
    const $block = $(block);
    const teamCells = $block.find("a[href*='teamprofile.aspx']");
    if (isTournament[index] === true) {
      return parseTournamentBlock($, $block, teamCells.length, source);
    }
    if (teamCells.length !== 2) {
      throw new ParseError(
        `mobile match block links ${teamCells.length} teams, expected 2 (own and opponent)`,
        `${MOBILE_MATCH} a[href*='teamprofile.aspx']`,
        source.url,
      );
    }
    const parts = lines($, $(teamCells.get(1)));
    const name = parts[0];
    if (name === undefined || name === "") {
      throw new ParseError("mobile match block names no opponent team", MOBILE_MATCH, source.url);
    }
    // The date is REQUIRED, not best-effort. It is the only thing that verifies the positional
    // correlation with the desktop table; skipping the comparison when it fails to parse leaves
    // count-only matching, under which a reordering silently attributes every opponent team
    // after the divergence to the wrong match.
    // (Provenance: Codex adversarial review round 10 on PR #26.)
    const playedOn = parseUsDate($block.find("th").first().text());
    if (playedOn === null) {
      throw new ParseError(
        "mobile match block has no parseable date to correlate on",
        `${MOBILE_MATCH} th`,
        source.url,
      );
    }
    return { kind: "league", name, section: parts[1] ?? null, playedOn };
  });
}

/**
 * A tournament block, verified rather than assumed.
 *
 * The desktop row has already declared this match a tournament; that alone is not enough to stop
 * requiring an opponent team, because a page where the two renderings disagree is exactly the case
 * this parser refuses to guess about. So the block must corroborate on two further counts —
 * it links NO team profiles, and it renders no `<th>` header row (a league block always does, on
 * all 3996 in the archive; a tournament block never does) — and its own date must be readable in
 * the row it labels `Tournament`, which is a third corroboration and the value the caller
 * correlates on.
 */
function parseTournamentBlock(
  $: CheerioAPI,
  $block: Cheerio<AnyNode>,
  teamLinks: number,
  source: SourceRef,
): TournamentEntry {
  if (teamLinks !== 0) {
    throw new ParseError(
      `desktop row is a tournament but its mobile block links ${teamLinks} teams, expected none`,
      `${MOBILE_MATCH} a[href*='teamprofile.aspx']`,
      source.url,
    );
  }
  if ($block.find("th").length > 0) {
    throw new ParseError(
      "desktop row is a tournament but its mobile block renders a league header row",
      `${MOBILE_MATCH} th`,
      source.url,
    );
  }
  // The block's own `Tournament` cell locates the header row without counting rows: a tournament
  // block leads with a full-width name row that a league block has no equivalent of, so a
  // positional read would be one markup tweak away from taking the date off the wrong line.
  const header = $block
    .find("tr")
    .filter((_, tr) =>
      $(tr)
        .find("td")
        .toArray()
        .some((cell) => lines($, $(cell))[0] === TOURNAMENT_LEAGUE_LABEL),
    )
    .first();
  const playedOn = parseUsDate(header.find("td").first().text());
  if (playedOn === null) {
    throw new ParseError(
      "tournament block has no parseable date to correlate on",
      `${MOBILE_MATCH} tr td`,
      source.url,
    );
  }
  return { kind: "tournament", playedOn };
}

/**
 * A tournament row is dropped, but not before it is correlated.
 *
 * Skipping the date comparison for a row we discard anyway would be the easy shortcut and it costs
 * the one guarantee that makes positional correlation safe: if the renderings ever fall out of
 * step, the rows this parser *thinks* are tournaments shift too, and a real league match gets
 * discarded in silence.
 */
function assertTournamentRenderingsAgree(
  $: CheerioAPI,
  row: Cheerio<AnyNode>,
  blockPlayedOn: string,
  index: number,
  source: SourceRef,
): void {
  const playedOn = parseUsDate($(row.find("td").get(0)).text());
  if (playedOn !== blockPlayedOn) {
    throw new ParseError(
      `renderings disagree at tournament row ${index}: desktop has ${playedOn ?? "no readable date"}, mobile block has ${blockPlayedOn}`,
      `${DESKTOP_TABLE} / ${MOBILE_MATCH}`,
      source.url,
    );
  }
}

function parseRow(
  $: CheerioAPI,
  row: Cheerio<AnyNode>,
  opponentTeam: OpponentTeam,
  source: SourceRef,
): CourtMatchRecord {
  const cells = row.find("td");
  if (cells.length !== MATCH_COLUMNS.length) {
    throw new ParseError(
      `match row has ${cells.length} cells, expected exactly ${MATCH_COLUMNS.length}`,
      `${DESKTOP_TABLE} tr`,
      source.url,
    );
  }
  const cell = (index: number): Cheerio<AnyNode> => $(cells.get(index));

  const playedOn = parseUsDate(cell(0).text());
  if (playedOn === null) {
    throw new ParseError(
      `unparseable match date "${collapse(cell(0).text())}"`,
      `${DESKTOP_TABLE} td:nth-child(1)`,
      source.url,
    );
  }
  if (opponentTeam.playedOn !== playedOn) {
    throw new ParseError(
      `renderings disagree at ${playedOn}: mobile block has ${opponentTeam.playedOn}`,
      `${DESKTOP_TABLE} / ${MOBILE_MATCH}`,
      source.url,
    );
  }

  const teamParts = lines($, cell(2));
  const slot = collapse(cell(3).text());
  const opponentParts = lines($, cell(5));
  const defaulted = opponentParts.some((part) => /^default/i.test(part));
  const rawMatchRating = collapse(cell(8).text());

  const leagueContext = lines($, cell(1)).join(" ");
  const teamName = teamParts[0];
  // Same failure shape as an empty score cell: an emptied identity column would produce a record
  // that still has a date, a slot and a result, and silently belongs to nobody.
  if (leagueContext === "" || teamName === undefined || teamName === "") {
    throw new ParseError(
      `court on ${playedOn} has no ${leagueContext === "" ? "league context" : "team"}`,
      `${DESKTOP_TABLE} td:nth-child(2) / td:nth-child(3)`,
      source.url,
    );
  }

  // The court-level idempotency key (spec § Ingestion's first discipline: re-run anytime, nothing
  // duplicates). A record without it looks usable and cannot be reconciled on the next pull, so
  // its absence is a structural failure rather than a missing optional field.
  // `mid=` with no value yields an empty string, not null — an empty idempotency key is as
  // unusable as a missing one, and the null-only check contradicted the comment above it.
  // (Provenance: Codex adversarial review round 7 on PR #26.)
  const sourceMatchId = hrefParam(cell(7).find("a").attr("href"), "mid");
  if (sourceMatchId === null || sourceMatchId === "") {
    throw new ParseError(
      `court on ${playedOn} has no source match id`,
      `${DESKTOP_TABLE} td:nth-child(8) a[href*='mid=']`,
      source.url,
    );
  }

  return {
    playedOn,
    leagueContext,
    teamName,
    teamSection: teamParts[1] ?? null,
    opponentTeamName: opponentTeam.name,
    opponentTeamSection: opponentTeam.section,
    slot,
    discipline: disciplineFor(slot, source),
    partner: parsePlayers(lines($, cell(4)), source)[0] ?? null,
    opponents: defaulted ? [] : parsePlayers(opponentParts, source),
    result: parseResult(collapse(cell(6).text()), source),
    sets: parseSets(lines($, cell(7)), defaulted, source),
    defaulted,
    matchRating: parseNumber(rawMatchRating),
    // "S" in the match column means the result was not rated because a participant was
    // self-rated or unrated — a different fact from "this match has no rating yet" (`-----`),
    // and one a dossier should be able to show rather than silently drop.
    selfRated: rawMatchRating.toUpperCase() === "S",
    resultingRating: parseNumber(collapse(cell(9).text())),
    sourceMatchId,
  };
}

/** `S1` → singles, `D1`–`D4` → doubles. Spec § Problem context: slots are per-event data. */
function disciplineFor(slot: string, source: SourceRef): "singles" | "doubles" {
  if (/^S\d*$/i.test(slot)) return "singles";
  if (/^D\d*$/i.test(slot)) return "doubles";
  throw new ParseError(
    `unrecognised court slot "${slot}"`,
    `${DESKTOP_TABLE} td:nth-child(4)`,
    source.url,
  );
}

/**
 * `W` or `L` — and nothing else.
 *
 * Treating "anything that isn't a W" as a loss is the tempting one-liner, and it turns an empty or
 * renamed cell into a silent defeat: the record still balances, the dossier still renders, and the
 * player's win rate is simply wrong. A result that cannot be read is a page that changed.
 */
function parseResult(raw: string, source: SourceRef): "W" | "L" {
  const value = raw.toUpperCase();
  if (value === "W" || value === "L") return value;
  throw new ParseError(
    `unreadable match result "${raw}"`,
    `${DESKTOP_TABLE} td:nth-child(7)`,
    source.url,
  );
}

/**
 * A player cell alternates names and parenthesised ratings: `Sawyer Sable`, `(3.69)`,
 * `Quinn Quillon`, `(3.41)`. A rating line always follows the player it belongs to, so a missing
 * one (an unrated player prints `(-----)`, which parses to null) never shifts the pairing.
 *
 * **A rating with no player before it throws.** It means the cell is not the alternating shape
 * this pairing depends on, and carrying on would attach ratings to the wrong people — the exact
 * failure that looks like data rather than like a bug.
 */
function parsePlayers(parts: string[], source: SourceRef): PlayerRef[] {
  const players: PlayerRef[] = [];
  for (const part of parts) {
    if (/^\(.*\)$/.test(part)) {
      const last = players[players.length - 1];
      if (last === undefined) {
        throw new ParseError(
          `rating "${part}" with no player before it`,
          `${DESKTOP_TABLE} player cell`,
          source.url,
        );
      }
      last.dynamicRating = parseNumber(part);
      continue;
    }
    if (/^default/i.test(part)) continue;
    players.push({ name: part, dynamicRating: null });
  }
  return players;
}

/**
 * A doubles court has a partner and two opponents; a singles court has one opponent and no
 * partner. Anything else means the cell layout changed, and an under-populated court silently
 * removes people from partner-frequency and prior-meeting counts.
 *
 * Defaulted courts are exempt: nobody played, so the opponents cell legitimately reads `Default`.
 */
function assertCardinality(record: CourtMatchRecord, source: SourceRef): void {
  if (record.defaulted) return;
  const expectedOpponents = record.discipline === "doubles" ? 2 : 1;
  const expectedPartner = record.discipline === "doubles";

  if (record.opponents.length !== expectedOpponents || (record.partner !== null) !== expectedPartner) {
    throw new ParseError(
      `${record.discipline} court on ${record.playedOn} has ${record.opponents.length} opponent(s) and ${record.partner === null ? "no" : "a"} partner`,
      `${DESKTOP_TABLE} participant cells`,
      source.url,
    );
  }
}

/**
 * `4-6`, `7-5`, `1-0` → two sets and a match tiebreak, each oriented to the **match** winner.
 *
 * The orientation is established from the fixture, not assumed: every straight-sets `L` row
 * prints the opponent winning both (`6-3 6-3` on a loss), which is only possible if the leading
 * number belongs to the match winner. It does **not** mean the leading number is larger in every
 * set — the match winner drops one in any three-setter, which is why `4-6 7-5 1-0` is a win.
 * `SetScore`'s field names carry that distinction so no consumer has to rediscover it.
 *
 * A 10-point match tiebreak replaces the deciding set and is printed as a one-game set, so only a
 * third-or-later `1-0` qualifies. Position is what distinguishes it from a short first set.
 *
 * Two ways to fail, both loud:
 * - **an unrecognised, non-empty score component** — a changed score format would otherwise leave
 *   a half-length set list on a record that still reports its W/L;
 * - **no score components at all** on a court that was actually played — an emptied cell would
 *   otherwise produce a W/L record with `sets: []`, indistinguishable downstream from a match
 *   that legitimately has no score. A defaulted court is exempt: nobody played it.
 */
function parseSets(parts: string[], defaulted: boolean, source: SourceRef): SetScore[] {
  const sets: SetScore[] = [];
  for (const part of parts) {
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (match === null) {
      throw new ParseError(
        `unrecognised score component "${part}"`,
        `${DESKTOP_TABLE} td:nth-child(8)`,
        source.url,
      );
    }
    const matchWinnerGames = Number(match[1]);
    const matchLoserGames = Number(match[2]);
    sets.push({
      matchWinnerGames,
      matchLoserGames,
      matchTiebreak: sets.length >= 2 && Math.max(matchWinnerGames, matchLoserGames) <= 1,
    });
  }

  if (sets.length === 0 && !defaulted) {
    throw new ParseError("played court has no score", `${DESKTOP_TABLE} td:nth-child(8)`, source.url);
  }
  return sets;
}
