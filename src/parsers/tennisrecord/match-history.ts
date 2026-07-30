import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { collapse, hrefParam, lines, parseNumber, parseUsDate, requireOne } from "../dom.js";
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
 * Parse a TennisRecord player match history into one record per court played.
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
 */
export function parseMatchHistory(html: string, source: SourceRef): CourtMatchRecord[] {
  const $ = cheerio.load(html);
  const table = requireOne($, DESKTOP_TABLE, "match history table", source.url);
  const rows = table.find("tr").filter((_, tr) => $(tr).find("td").length > 0);
  if (rows.length === 0) return [];

  const opponentTeams = parseOpponentTeams($, source);
  if (opponentTeams.length !== rows.length) {
    throw new ParseError(
      `desktop rendering has ${rows.length} matches but mobile rendering has ${opponentTeams.length}`,
      `${DESKTOP_TABLE} / ${MOBILE_MATCH}`,
      source.url,
    );
  }

  return rows
    .map((index, tr) => {
      const opponentTeam = opponentTeams[index];
      // Unreachable while the length check above holds; kept as a type-level guarantee that the
      // record is never built from a missing correlate rather than as a runtime branch.
      if (opponentTeam === undefined) {
        throw new ParseError(
          `no mobile block correlates with desktop row ${index}`,
          `${DESKTOP_TABLE} / ${MOBILE_MATCH}`,
          source.url,
        );
      }
      return parseRow($, $(tr), opponentTeam, source);
    })
    .get()
    .map((record) => {
      assertCardinality(record, source);
      return courtMatchRecordSchema.parse(record);
    });
}

type OpponentTeam = { name: string; section: string | null; playedOn: string | null };

/**
 * The mobile block renders one small table per match, linking both teams — the profiled player's
 * and the opponent's — with the opponent second. We keep its date too, so the positional
 * correlation with the desktop table is verified rather than trusted.
 *
 * A block that does not link exactly two teams throws. Returning a null opponent instead would
 * turn a mobile-markup change into scouting history that is silently missing who each match was
 * against, while every other field still looks correct.
 */
function parseOpponentTeams($: CheerioAPI, source: SourceRef): OpponentTeam[] {
  return $(MOBILE_MATCH)
    .map((_, block) => {
      const $block = $(block);
      const teamCells = $block.find("a[href*='teamprofile.aspx']");
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
      return {
        name,
        section: parts[1] ?? null,
        playedOn: parseUsDate($block.find("th").first().text()),
      };
    })
    .get();
}

function parseRow(
  $: CheerioAPI,
  row: Cheerio<AnyNode>,
  opponentTeam: OpponentTeam,
  source: SourceRef,
): CourtMatchRecord {
  const cells = row.find("td");
  const cell = (index: number): Cheerio<AnyNode> => $(cells.get(index));

  const playedOn = parseUsDate(cell(0).text());
  if (playedOn === null) {
    throw new ParseError(
      `unparseable match date "${collapse(cell(0).text())}"`,
      `${DESKTOP_TABLE} td:nth-child(1)`,
      source.url,
    );
  }
  if (opponentTeam.playedOn !== null && opponentTeam.playedOn !== playedOn) {
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

  return {
    playedOn,
    leagueContext: lines($, cell(1)).join(" "),
    teamName: teamParts[0] ?? "",
    teamSection: teamParts[1] ?? null,
    opponentTeamName: opponentTeam.name,
    opponentTeamSection: opponentTeam.section,
    slot,
    discipline: disciplineFor(slot, source),
    partner: parsePlayers(lines($, cell(4)), source)[0] ?? null,
    opponents: defaulted ? [] : parsePlayers(opponentParts, source),
    result: parseResult(collapse(cell(6).text()), source),
    sets: parseSets(lines($, cell(7)), source),
    defaulted,
    matchRating: parseNumber(rawMatchRating),
    // "S" in the match column means the result was not rated because a participant was
    // self-rated or unrated — a different fact from "this match has no rating yet" (`-----`),
    // and one a dossier should be able to show rather than silently drop.
    selfRated: rawMatchRating.toUpperCase() === "S",
    resultingRating: parseNumber(collapse(cell(9).text())),
    sourceMatchId: hrefParam(cell(7).find("a").attr("href"), "mid"),
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
 * `4-6`, `7-5`, `1-0` → two sets and a match tiebreak, all **winner-first**.
 *
 * Winner-first is established by the fixture, not assumed: every `L` row prints the opponent
 * winning (`6-3 6-3` on a loss), which is only possible if the leading number is the winner's.
 * `SetScore` names its fields accordingly so no consumer can read them the other way round.
 *
 * A 10-point match tiebreak replaces the deciding set and is printed as a one-game set, so only a
 * third-or-later `1-0` qualifies. Position is what distinguishes it from a short first set.
 *
 * **An unrecognised, non-empty score line throws.** Skipping it would let a changed score format
 * yield an empty or half-length set list on a record that still reports its W/L, which is a
 * plausible-looking match with the scores quietly removed.
 */
function parseSets(parts: string[], source: SourceRef): SetScore[] {
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
    const winnerGames = Number(match[1]);
    const loserGames = Number(match[2]);
    sets.push({
      winnerGames,
      loserGames,
      matchTiebreak: sets.length >= 2 && Math.max(winnerGames, loserGames) <= 1,
    });
  }
  return sets;
}
