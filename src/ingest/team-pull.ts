import { readFileSync } from "node:fs";
import type { openDb } from "../db/client.js";
import { teams } from "../db/schema.js";
import { hrefParam } from "../parsers/dom.js";
import { ParseError, parseTennisRecordTeam } from "../parsers/index.js";
import { archivePage } from "./archive.js";
import { AmbiguousIdentityError } from "./errors.js";
import type { PageFetcher } from "./fetch.js";
import { findTeamByName, resolvePlayer, resolveTeam } from "./identity.js";
import { matchHistoryUrlFor, pullPlayer, slugFromUrl } from "./player-pull.js";
import { upsertMembership, upsertTeam, upsertTeamMatch } from "./upsert.js";
import { sanitizeValue } from "../sanitize.js";

type Db = ReturnType<typeof openDb>["db"];
type TeamRow = typeof teams.$inferSelect;

export type TeamPullOptions = {
  db: Db;
  fetchPage: PageFetcher;
  /** A CLI-style target: a full URL, a `tr:`-prefixed URL, or a known team's name. */
  target?: string;
  /** Read `path` instead of fetching; `sourceUrl` is the page's real URL for provenance/parsing. */
  from?: { path: string; sourceUrl: string };
  /** `--players`: cascade each roster entry with a profile link through `pullPlayer`. */
  cascadePlayers?: boolean;
};

export type TeamPullResult =
  | {
      kind: "ok";
      team: TeamRow;
      rosterCount: number;
      matchCount: number;
      archivedPath: string;
      skippedRosterEntries: string[];
    }
  | { kind: "unknown-target"; message: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "error"; message: string };

function resolveTargetUrl(
  db: Db,
  target: string,
): { kind: "url"; url: string } | { kind: "unknown-target" } | { kind: "ambiguous"; candidates: string[] } {
  if (/^https?:\/\//i.test(target)) return { kind: "url", url: target };
  if (target.startsWith("tr:")) return { kind: "url", url: target.slice(3) };

  const found = findTeamByName(db, target);
  if (found.kind === "found") {
    if (found.row.tennisrecordUrl === null) return { kind: "unknown-target" };
    return { kind: "url", url: found.row.tennisrecordUrl };
  }
  if (found.kind === "ambiguous") {
    return { kind: "ambiguous", candidates: found.candidates.map((t) => t.name) };
  }
  return { kind: "unknown-target" };
}

/** `"3-2"` → `[3, 2]`; anything else (a bye, a blank result) → `[null, null]`. */
function parseResultCounts(result: string | null): [number | null, number | null] {
  const match = result === null ? null : /^(\d+)\s*-\s*(\d+)$/.exec(result);
  if (match === null) return [null, null];
  return [Number(match[1]), Number(match[2])];
}

/**
 * Pull one team: resolve the target, fetch (or read `--from`), archive the raw page BEFORE
 * parsing, then `parseTennisRecordTeam` and upsert the team, its roster memberships, and its local
 * schedule as `team_matches`. With `cascadePlayers`, every roster entry with a profile link is
 * pulled in turn through `pullPlayer` — a roster entry with NO link is skipped with a warning
 * rather than failing the whole team (it is still recorded as a member; only the enrichment step
 * is skipped).
 *
 * All roster/schedule writes happen inside ONE `sqlite.transaction`; the `--players` cascade runs
 * AFTER that transaction commits, since each cascaded pull is its own independent transaction (a
 * failure enriching one player must not roll back the team roster that was already committed).
 *
 * Known limitation (documented, not a defect): an ambiguous identity for a roster player or a
 * schedule opponent team aborts the WHOLE team pull, same as `pullPlayer`'s own opponents — spec §
 * Ingestion forbids a silent merge, and every roster/schedule row shares one transaction.
 */
export async function pullTeam(options: TeamPullOptions): Promise<TeamPullResult> {
  const { db, fetchPage, from, cascadePlayers = false } = options;

  let url: string;
  let body: string;
  let httpStatus: number;

  if (from !== undefined) {
    url = from.sourceUrl;
    body = readFileSync(from.path, "utf8");
    httpStatus = 200;
  } else {
    if (options.target === undefined) {
      return { kind: "error", message: "pullTeam: one of target or from is required" };
    }
    const resolved = resolveTargetUrl(db, options.target);
    if (resolved.kind === "unknown-target") {
      return { kind: "unknown-target", message: `unknown team target "${options.target}"` };
    }
    if (resolved.kind === "ambiguous") return { kind: "ambiguous", candidates: resolved.candidates };
    url = resolved.url;
    try {
      const page = await fetchPage(url);
      body = page.body;
      httpStatus = page.status;
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  const archivedPath = archivePage({ sourceSet: "tennisrecord", slug: slugFromUrl(url), url, body, httpStatus });

  const source = { url, fetchedAt: new Date().toISOString() };
  let parsed;
  try {
    parsed = parseTennisRecordTeam(body, source);
  } catch (err) {
    if (err instanceof ParseError) return { kind: "error", message: err.message };
    throw err;
  }

  let team: TeamRow;
  try {
    team = db.transaction((tx) => {
      const upserted = upsertTeam(tx, {
        name: parsed.teamName,
        section: parsed.section,
        district: null,
        tennisrecordUrl: url,
      });

      for (const entry of parsed.roster) {
        const resolved = resolvePlayer(tx, { name: entry.name });
        if (resolved.kind === "ambiguous") {
          throw new AmbiguousIdentityError(resolved.candidates.map((p) => p.canonicalName));
        }
        upsertMembership(tx, { playerId: resolved.row.id, teamId: upserted.id, eventId: null });
      }

      for (const row of parsed.schedule) {
        const opponent = resolveTeam(tx, { name: row.opponentTeamName });
        if (opponent.kind === "ambiguous") {
          throw new AmbiguousIdentityError(opponent.candidates.map((t) => t.name));
        }
        const [homeCourtsWon, visitingCourtsWon] = parseResultCounts(row.result);
        upsertTeamMatch(tx, {
          eventId: null,
          homeTeamId: upserted.id,
          visitingTeamId: opponent.row.id,
          playedOn: row.playedOn,
          scheduledTime: row.scheduledTime,
          site: row.site,
          sourceMatchId: row.sourceMatchId,
          homeCourtsWon,
          visitingCourtsWon,
        });
      }

      return upserted;
    });
  } catch (err) {
    if (err instanceof AmbiguousIdentityError) return { kind: "ambiguous", candidates: err.candidates };
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const skippedRosterEntries: string[] = [];
  if (cascadePlayers) {
    const year = hrefParam(url, "year") ?? String(new Date().getUTCFullYear());
    for (const entry of parsed.roster) {
      const playername = entry.profilePath === null ? null : hrefParam(entry.profilePath, "playername");
      if (playername === null || playername === "") {
        skippedRosterEntries.push(entry.name);
        // `entry.name` is parsed from a fetched roster page, so it is attacker-influenced and this
        // is a raw stderr write with no summary formatter in front of it (`emitSummary` sanitizes;
        // a bare `console.warn` does not). Found by the independent Codex review of PR #47.
        console.warn(`team pull: roster entry "${sanitizeValue(entry.name)}" has no profile link — skipped`);
        continue;
      }
      const playerUrl = matchHistoryUrlFor(playername, year);
      const result = await pullPlayer({ db, fetchPage, url: playerUrl });
      if (result.kind !== "ok") {
        skippedRosterEntries.push(entry.name);
        console.warn(`team pull: cascading "${sanitizeValue(entry.name)}" failed (${result.kind}) — skipped`);
      }
    }
  }

  return {
    kind: "ok",
    team,
    rosterCount: parsed.roster.length,
    matchCount: parsed.schedule.length,
    archivedPath,
    skippedRosterEntries,
  };
}
