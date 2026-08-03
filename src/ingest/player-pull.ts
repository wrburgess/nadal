import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { openDb } from "../db/client.js";
import { errorMessage } from "../error-message.js";
import { players, teamMatches } from "../db/schema.js";
import { archivePage } from "./archive.js";
import { AmbiguousIdentityError } from "./errors.js";
import type { PageFetcher } from "./fetch.js";
import { findPlayerByName, resolvePlayer } from "./identity.js";
import { ParseError, parseMatchHistory, parseTennisRecordHeader, type CourtMatchRecord } from "../parsers/index.js";
import { upsertCourtMatch, upsertCourtMatchPlayers, upsertPlayer, upsertRatingObservation } from "./upsert.js";

type Db = ReturnType<typeof openDb>["db"];
type PlayerRow = typeof players.$inferSelect;

const TENNISRECORD_HOST = "https://www.tennisrecord.com";

/** `/adult/profile.aspx?playername=Ellis+Eastwick` → the match-history URL for the same player. */
export function matchHistoryUrlFor(playername: string, year: string): string {
  const params = new URLSearchParams({ year, playername, mt: "0", lt: "0", yr: "0" });
  return `${TENNISRECORD_HOST}/adult/matchhistory.aspx?${params.toString()}`;
}

/** A filesystem-safe archive slug derived from the URL itself, before the page is parsed. */
export function slugFromUrl(url: string): string {
  const cleaned = url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned.slice(0, 120) || "page").toLowerCase();
}

export type PlayerPullOptions = {
  db: Db;
  fetchPage: PageFetcher;
  /** A CLI-style target: a full URL, a `tr:`-prefixed URL, or a known player's name. */
  target?: string;
  /** A URL to fetch directly, bypassing target resolution — used by team-pull's `--players` cascade. */
  url?: string;
  /** Read `path` instead of fetching; `sourceUrl` is the page's real URL for provenance/parsing. */
  from?: { path: string; sourceUrl: string };
};

export type PlayerPullResult =
  | {
      kind: "ok";
      player: PlayerRow;
      courtMatchCount: number;
      archivedPath: string;
    }
  | { kind: "unknown-target"; message: string }
  | { kind: "ambiguous"; candidates: string[]; incoming?: string; context?: string }
  | { kind: "error"; message: string };

function resolveTargetUrl(
  db: Db,
  target: string,
): { kind: "url"; url: string } | { kind: "unknown-target" } | { kind: "ambiguous"; candidates: string[] } {
  if (/^https?:\/\//i.test(target)) return { kind: "url", url: target };
  if (target.startsWith("tr:")) return { kind: "url", url: target.slice(3) };

  const found = findPlayerByName(db, target);
  if (found.kind === "found") {
    if (found.row.tennisrecordUrl === null) return { kind: "unknown-target" };
    return { kind: "url", url: found.row.tennisrecordUrl };
  }
  if (found.kind === "ambiguous") {
    return { kind: "ambiguous", candidates: found.candidates.map((p) => p.canonicalName) };
  }
  return { kind: "unknown-target" };
}

function setsToScore(record: CourtMatchRecord): string {
  return record.sets.map((s) => `${s.matchWinnerGames}-${s.matchLoserGames}`).join(" ");
}

/**
 * Pull one player: resolve the target, fetch (or read `--from`), archive the raw page BEFORE
 * parsing, then run `parseTennisRecordHeader` and `parseMatchHistory` over the SAME bytes (one
 * fetch, two parsers — the match-history page carries both). Every write happens inside ONE
 * `sqlite.transaction`, so a `ParseError` or an ambiguous identity mid-pull writes nothing.
 *
 * Known limitation (documented, not a defect): an ambiguous identity for a partner or an opponent
 * named deep in a player's match history aborts the WHOLE pull, same as an ambiguous identity for
 * the player themself — spec § Ingestion forbids a silent merge, and there is no partial-write
 * shape here that isn't one.
 */
export async function pullPlayer(options: PlayerPullOptions): Promise<PlayerPullResult> {
  const { db, fetchPage, from } = options;

  let url: string;
  let body: string;
  let httpStatus: number;

  if (from !== undefined) {
    url = from.sourceUrl;
    body = readFileSync(from.path, "utf8");
    httpStatus = 200;
  } else {
    let resolvedUrl: string;
    if (options.url !== undefined) {
      resolvedUrl = options.url;
    } else if (options.target !== undefined) {
      const resolved = resolveTargetUrl(db, options.target);
      if (resolved.kind === "unknown-target") {
        return { kind: "unknown-target", message: `unknown player target "${options.target}"` };
      }
      if (resolved.kind === "ambiguous") return { kind: "ambiguous", candidates: resolved.candidates };
      resolvedUrl = resolved.url;
    } else {
      return { kind: "error", message: "pullPlayer: one of target, url, or from is required" };
    }
    url = resolvedUrl;
    try {
      const page = await fetchPage(url);
      body = page.body;
      httpStatus = page.status;
    } catch (err) {
      return { kind: "error", message: errorMessage(err) };
    }
  }

  const archivedPath = archivePage({
    sourceSet: "tennisrecord",
    slug: slugFromUrl(url),
    url,
    body,
    httpStatus,
  });

  const source = { url, fetchedAt: new Date().toISOString() };
  let header;
  let matches: CourtMatchRecord[];
  try {
    header = parseTennisRecordHeader(body, source);
    matches = parseMatchHistory(body, source);
  } catch (err) {
    if (err instanceof ParseError) return { kind: "error", message: err.message };
    throw err;
  }

  try {
    const player = db.transaction((tx) => {
      const resolved = resolvePlayer(tx, { tennisrecordUrl: url, name: header.name });
      if (resolved.kind === "ambiguous") {
        throw new AmbiguousIdentityError(header.name, resolved.candidates.map((p) => p.canonicalName), "player profile name");
      }
      const updated = upsertPlayer(tx, {
        id: resolved.row.id,
        canonicalName: header.name,
        tennisrecordUrl: url,
        gender: header.gender,
      });

      if (header.ntrp !== null) {
        upsertRatingObservation(tx, {
          playerId: updated.id,
          source: "ntrp",
          value: header.ntrp.value,
          ratingType: header.ntrp.ratingType,
          observedOn: header.ntrp.observedOn,
        });
      }
      if (header.dynamicRating !== null) {
        upsertRatingObservation(tx, {
          playerId: updated.id,
          source: "tr_dynamic",
          value: header.dynamicRating.value,
          ratingType: null,
          observedOn: header.dynamicRating.observedOn,
        });
      }

      for (const record of matches) {
        const linkedTeamMatch =
          record.sourceMatchId === null
            ? undefined
            : tx.select().from(teamMatches).where(eq(teamMatches.sourceMatchId, record.sourceMatchId)).all()[0];

        const courtMatch = upsertCourtMatch(tx, {
          teamMatchId: linkedTeamMatch?.id ?? null,
          slot: record.slot,
          discipline: record.discipline,
          // The profiled player is written on side "home" immediately below, so the parser's
          // player-relative `result` maps straight onto a side. This MUST stay inside the loop
          // iteration that assigns the participant sides: sides here are pull-perspective (see
          // `upsertCourtMatchPlayers`, which SETS `side` on conflict), so a later pull of an
          // opposing player rewrites all of them from that player's perspective. The flip is
          // symmetric and `windowedRecord` is perspective-invariant only because the winner flips
          // with the sides — hoisting this out would silently invert every rewritten row.
          // Until #17 PR B this was hardcoded `null`, and `derive.ts` reads a null winner as
          // *undecided* by design, so every dossier's W/L read 0-0 with all matches undecided
          // (test/ingest-winner-side.test.ts).
          winnerSide: record.result === "W" ? "home" : "visiting",
          score: setsToScore(record),
          leagueContext: record.leagueContext,
          playedOn: record.playedOn,
          sourceMatchId: record.sourceMatchId,
        });

        upsertCourtMatchPlayers(tx, { courtMatchId: courtMatch.id, playerId: updated.id, side: "home" });

        if (record.partner !== null) {
          const partner = resolvePlayer(tx, { name: record.partner.name });
          if (partner.kind === "ambiguous") {
            throw new AmbiguousIdentityError(record.partner.name, partner.candidates.map((p) => p.canonicalName), "match partner");
          }
          upsertCourtMatchPlayers(tx, { courtMatchId: courtMatch.id, playerId: partner.row.id, side: "home" });
        }
        for (const opponent of record.opponents) {
          const resolvedOpponent = resolvePlayer(tx, { name: opponent.name });
          if (resolvedOpponent.kind === "ambiguous") {
            throw new AmbiguousIdentityError(opponent.name, resolvedOpponent.candidates.map((p) => p.canonicalName), "match opponent");
          }
          upsertCourtMatchPlayers(tx, {
            courtMatchId: courtMatch.id,
            playerId: resolvedOpponent.row.id,
            side: "visiting",
          });
        }
      }

      return updated;
    });

    return { kind: "ok", player, courtMatchCount: matches.length, archivedPath };
  } catch (err) {
    if (err instanceof AmbiguousIdentityError)
      return { kind: "ambiguous", candidates: err.candidates, incoming: err.incoming, context: err.context };
    return { kind: "error", message: errorMessage(err) };
  }
}
