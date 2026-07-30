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

  const opponentTeams = parseOpponentTeams($);
  if (opponentTeams.length !== rows.length) {
    throw new ParseError(
      `desktop rendering has ${rows.length} matches but mobile rendering has ${opponentTeams.length}`,
      `${DESKTOP_TABLE} / ${MOBILE_MATCH}`,
      source.url,
    );
  }

  return rows
    .map((index, tr) => parseRow($, $(tr), opponentTeams[index], source))
    .get()
    .map((record) => courtMatchRecordSchema.parse(record));
}

type OpponentTeam = { name: string | null; section: string | null; playedOn: string | null };

/**
 * The mobile block renders one small table per match; the second row's third cell is the opposing
 * team. We also keep its date so the positional correlation can be verified rather than trusted.
 */
function parseOpponentTeams($: CheerioAPI): OpponentTeam[] {
  return $(MOBILE_MATCH)
    .map((_, block) => {
      const $block = $(block);
      const teamCells = $block.find("a[href*='teamprofile.aspx']");
      const opponent = teamCells.length > 1 ? $(teamCells.get(1)) : null;
      const parts = opponent === null ? [] : lines($, opponent);
      return {
        name: parts[0] ?? null,
        section: parts[1] ?? null,
        playedOn: parseUsDate($block.find("th").first().text()),
      };
    })
    .get();
}

function parseRow(
  $: CheerioAPI,
  row: Cheerio<AnyNode>,
  opponentTeam: OpponentTeam | undefined,
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
  if (opponentTeam !== undefined && opponentTeam.playedOn !== null && opponentTeam.playedOn !== playedOn) {
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
    opponentTeamName: opponentTeam?.name ?? null,
    opponentTeamSection: opponentTeam?.section ?? null,
    slot,
    discipline: disciplineFor(slot, source),
    partner: parsePlayers(lines($, cell(4)))[0] ?? null,
    opponents: defaulted ? [] : parsePlayers(opponentParts),
    result: /^w/i.test(collapse(cell(6).text())) ? "W" : "L",
    sets: parseSets(lines($, cell(7))),
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
 * A player cell alternates names and parenthesised ratings: `Sawyer Sable`, `(3.69)`,
 * `Quinn Quillon`, `(3.41)`. A rating line always follows the player it belongs to, so a missing
 * one (an unrated player prints `(-----)`, which parses to null) never shifts the pairing.
 */
function parsePlayers(parts: string[]): PlayerRef[] {
  const players: PlayerRef[] = [];
  for (const part of parts) {
    if (/^\(.*\)$/.test(part)) {
      const last = players[players.length - 1];
      if (last !== undefined) last.dynamicRating = parseNumber(part);
      continue;
    }
    if (/^default/i.test(part)) continue;
    players.push({ name: part, dynamicRating: null });
  }
  return players;
}

/**
 * `6-4`, `5-7`, `1-0` → two sets and a match tiebreak.
 *
 * A 10-point match tiebreak is printed as a one-game "set". No real set can be won with a single
 * game, so a set whose winner has at most one game is the tiebreak — flagged rather than dropped,
 * because a dossier that counts it as a set understates every games-won ratio it computes.
 */
function parseSets(parts: string[]): SetScore[] {
  const sets: SetScore[] = [];
  for (const part of parts) {
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (match === null) continue;
    const games: [number, number] = [Number(match[1]), Number(match[2])];
    sets.push({ games, matchTiebreak: Math.max(games[0], games[1]) <= 1 });
  }
  return sets;
}
