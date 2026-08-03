import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { openDb } from "../db/client.js";
import { teams } from "../db/schema.js";
import { hrefParam } from "../parsers/dom.js";
import { ParseError, parseTennisRecordTeam } from "../parsers/index.js";
import { archivePage } from "./archive.js";
import { AmbiguousIdentityError } from "./errors.js";
import type { PageFetcher } from "./fetch.js";
import { findTeamByName, resolvePlayer, resolveTeam } from "./identity.js";
import { matchHistoryUrlFor, pullPlayer, slugFromUrl } from "./player-pull.js";
import { retireAbsentMemberships, upsertMembership, upsertTeam, upsertTeamMatch } from "./upsert.js";
import { errorMessage } from "../error-message.js";
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
      /** Issue #49: how many pre-existing roster rows this pull just soft-retired (present before,
       * absent from this parse). Surfaced on the result — not only in the database — because
       * retirement removes a player from every current-roster read/write, and a caller relying on
       * `rosterCount` alone would have no way to notice a roster shrank rather than merely failed
       * to grow. */
      retiredCount: number;
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
  // When the ROSTER IN `body` WAS OBSERVED — the fetch's own stamp, not a later local clock read.
  // Null on the `--from` replay path, which has no observation time at all (an archived file's
  // vintage is unknowable) and which therefore never reconciles. See the monotonic guard below.
  let observedAt: string | null = null;

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
      // The FETCH's timestamp, taken when the bytes arrived (src/ingest/fetch.ts). Reading a fresh
      // `new Date()` further down would stamp this snapshot with the moment we got round to writing
      // it, which is exactly the value that cannot order two concurrent pulls.
      observedAt = page.fetchedAt;
    } catch (err) {
      return { kind: "error", message: errorMessage(err) };
    }
  }

  const archivedPath = archivePage({ sourceSet: "tennisrecord", slug: slugFromUrl(url), url, body, httpStatus });

  const source = { url, fetchedAt: observedAt ?? new Date().toISOString() };
  let parsed;
  try {
    parsed = parseTennisRecordTeam(body, source);
  } catch (err) {
    if (err instanceof ParseError) return { kind: "error", message: err.message };
    throw err;
  }

  let team: TeamRow;
  let retiredCount: number;
  try {
    const txResult = db.transaction((tx) => {
      const upserted = upsertTeam(tx, {
        name: parsed.teamName,
        section: parsed.section,
        district: null,
        tennisrecordUrl: url,
      });

      const lastObserved = upserted.rosterObservedAt;
      const lastUrl = upserted.rosterObservedUrl;

      // NOT-NEWER, not merely older: `<=` fails CLOSED on an equal stamp. `fetchedAt` has
      // millisecond precision, so two snapshots with DIFFERENT content can carry the same string,
      // and nothing then orders them — retiring on a coin flip is the one outcome worth ruling out.
      // Skipping costs at most a delay: memberships are still upserted, and the next pull (with a
      // later stamp) reconciles. (Codex round 3, rated medium — my first cut used `<` on the
      // reasoning that a same-millisecond re-pull should still apply, which weighed the harmless
      // case over the harmful one.)
      const staleSnapshot = observedAt !== null && lastObserved !== null && observedAt <= lastObserved;

      // A snapshot from a DIFFERENT source cannot be ordered against this team's watermark at all.
      // TennisRecord team URLs carry a `year` and `tn team pull` accepts an arbitrary URL, so
      // freshly fetching a PRIOR SEASON's page produces a valid roster with a brand-new fetch time
      // — newer than the watermark, and authoritative-looking, while describing a roster that is a
      // year out of date. It would retire everyone who joined since.
      //
      // Such a pull RE-BASELINES rather than being ignored forever: it refreshes memberships,
      // retires nobody, and records the new (url, observedAt) pair, so the NEXT pull from that same
      // source reconciles normally. That matters because the canonical URL legitimately changes
      // when a season rolls over — a rule that merely refused a new source would silently disable
      // retirement for that team for good. (Codex round 3, rated high.)
      const differentSource = lastUrl !== null && lastUrl !== url;

      if (staleSnapshot) {
        console.warn(
          `team pull: roster snapshot observed ${sanitizeValue(observedAt ?? "")} is not newer than the ` +
            `applied ${sanitizeValue(lastObserved ?? "")} — memberships refreshed, retirement skipped`,
        );
      } else if (differentSource) {
        console.warn(
          `team pull: roster came from ${sanitizeValue(url)}, not the source that last reconciled ` +
            `(${sanitizeValue(lastUrl ?? "")}) — memberships refreshed, retirement skipped, baseline moved`,
        );
      }

      // Computed BEFORE the roster loop, because the loop's `upsertMembership` decides whether to
      // clear `retired_at` and that decision needs the same trust verdict the retirement below uses.
      // Computing it afterwards left the guard ASYMMETRIC: an untrusted snapshot could not remove a
      // member, but could still REVIVE one the authoritative roster had correctly retired — the very
      // defect this issue exists to fix, arriving through the opposite door.
      // (Codex adversarial review of PR #53, round 4, rated high.)
      //
      // NO BASELINE = NOT TRUSTED. A NULL `rosterObservedUrl` means no snapshot has ever established
      // what this team's roster source IS — which is the state of EVERY team in a database upgraded
      // from before this change, since 0007/0008 add both columns as NULL. Without this, the first
      // pull after an upgrade is trusted by default, so a single `tn team pull <prior-season URL>`
      // would retire legacy members on the strength of a year-old roster. That needs only ONE pull,
      // so it is not the two-pull re-baselining residual deferred to the team-identity issue.
      //
      // Uniform rather than a legacy special case: a brand-new team's first pull has no baseline
      // either, and suppressing reconciliation there costs nothing (it has no memberships to
      // retire). So the rule is simply "the first snapshot establishes the baseline and asserts
      // nothing about departures", and the watermark update below still runs.
      // (Codex adversarial review of PR #53, round 5, rated high.)
      const noBaseline = lastUrl === null;

      const trustedSnapshot =
        from === undefined && !staleSnapshot && !differentSource && !noBaseline;

      const observedPlayerIds: number[] = [];
      for (const entry of parsed.roster) {
        const resolved = resolvePlayer(tx, { name: entry.name });
        if (resolved.kind === "ambiguous") {
          throw new AmbiguousIdentityError(entry.name, resolved.candidates.map((p) => p.canonicalName), "team roster row");
        }
        upsertMembership(
          tx,
          { playerId: resolved.row.id, teamId: upserted.id, eventId: null },
          { unretire: trustedSnapshot },
        );
        observedPlayerIds.push(resolved.row.id);
      }

      // Issue #49: reconcile departures against the JUST-PARSED roster, still inside this same
      // transaction — a mid-pull failure (the ambiguous-identity throw above, or the schedule loop
      // below) must never retire against a partial roster.
      //
      // This is what makes the abort-on-ambiguity behavior a few lines up NEWLY load-bearing: an
      // ambiguous roster entry throws and rolls back the whole transaction before this line ever
      // runs, so `retireAbsentMemberships` only ever sees a COMPLETE `observedPlayerIds`. If a
      // future change ever made an ambiguous entry non-fatal (skip-and-continue, say), this call
      // would silently retire real members whose names merely came later in page order than the
      // skipped one — a partial-roster hazard the empty-set guard INSIDE `retireAbsentMemberships`
      // cannot see, because a partial roster is not an empty one.
      // A REPLAYED page (`--from`) never reconciles. Retirement is a claim about the roster *now*,
      // and `--from` reads an arbitrary saved file whose vintage nothing establishes: replaying an
      // archive captured before a newer live pull would retire every player who joined since, and
      // the transaction's atomicity does no work against an out-of-order snapshot — it makes the
      // wrong write atomically. The stamp would compound it, since `source.fetchedAt` is `new
      // Date()` even here, so the row would record a departure "observed" at a moment the page it
      // came from long predates.
      //
      // The replay path keeps doing its real job either way: the roster loop above still upserts
      // (and un-retires) everyone the archived page DOES list. Only the destructive half is
      // withheld — a replay can add and refresh, never remove.
      //
      // Deliberately NOT a flag: an "authoritative replay" mode would need provenance the archive
      // does not carry. If one is ever wanted, it needs a captured-at timestamp compared against
      // the memberships it would retire, not a caller's assertion that this file is current.
      // (Found by the independent Codex adversarial review of this PR, rated high.)
      //
      // MONOTONIC IN OBSERVATION TIME, not in commit order. SQLite serializes the two writers, but
      // serialization orders the *writes* and this reconcile is a claim about the *inputs*: process
      // A fetches a complete roster omitting P, process B then fetches a NEWER complete roster
      // listing P and commits first, and A — committing second, correctly serialized — retires P
      // anyway. Both pages are valid and complete, so this is a different defect from the accepted
      // truncated-page limitation, and it is reachable inside ONE process: the MCP server awaits
      // `fetchPage`, so two overlapping `team_pull` calls interleave exactly this way whenever the
      // earlier request's response is the slower one. Comparing the incoming snapshot's OBSERVATION
      // time against the last one actually applied is what SQLite cannot do for us.
      //
      // A NULL `rosterObservedAt` means no snapshot has ever been applied, which must read as
      // "apply this one", never as an infinitely-old one. ISO-8601 UTC strings compare
      // lexicographically in chronological order, so `<` is a real time comparison here. Strictly
      // older is skipped; an equal stamp still applies, so a same-millisecond re-pull is not
      // mistaken for a stale one.
      // (Found by the independent Codex adversarial review of this PR, round 2, rated high.)
      const observedRetiredCount = !trustedSnapshot
        ? 0
        : retireAbsentMemberships(tx, {
              teamId: upserted.id,
              observedPlayerIds,
              // The pull's single already-computed timestamp (`source.fetchedAt` above), not a fresh
              // `new Date()` — every retirement this pull records shares one instant, so a re-run a
              // moment later cannot introduce clock skew between memberships that were, in truth, all
              // last (not) observed by the same fetch.
              retiredAt: source.fetchedAt,
            });

      // Advance the watermark only when this snapshot actually reconciled. A replay (`--from`) has
      // no observation time to record, and a stale snapshot must not move the mark forward — doing
      // either would let the NEXT genuinely-newer pull be rejected as stale.
      // Recorded as a PAIR — the stamp is meaningless without the source it came from. Advanced on
      // a normal reconcile AND on a re-baseline (a different source), but never by a stale snapshot,
      // which must not move the mark and cause the next genuinely-newer pull to be rejected in turn.
      // `--from` records nothing at all: a replayed archive has no observation time to offer.
      if (from === undefined && !staleSnapshot && observedAt !== null) {
        tx.update(teams)
          .set({ rosterObservedAt: observedAt, rosterObservedUrl: url })
          .where(eq(teams.id, upserted.id))
          .run();
      }

      for (const row of parsed.schedule) {
        const opponent = resolveTeam(tx, { name: row.opponentTeamName });
        if (opponent.kind === "ambiguous") {
          throw new AmbiguousIdentityError(row.opponentTeamName, opponent.candidates.map((t) => t.name), "schedule opponent team");
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

      return { team: upserted, retiredCount: observedRetiredCount };
    });
    team = txResult.team;
    retiredCount = txResult.retiredCount;
  } catch (err) {
    if (err instanceof AmbiguousIdentityError)
      return { kind: "ambiguous", candidates: err.candidates, incoming: err.incoming, context: err.context };
    return { kind: "error", message: errorMessage(err) };
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
        // Name the identity that actually failed, not the player we happened to be cascading.
        // A real report read `cascading "John Jennings" failed (ambiguous) — skipped` when John
        // resolved exactly and the ambiguity was a name inside HIS match history — so it pointed
        // at the wrong person, and omitted both the incoming name and what it was near (#94).
        const detail =
          result.kind === "ambiguous"
            ? ` — "${sanitizeValue(result.incoming ?? "")}" (${sanitizeValue(result.context ?? "unknown")}) is near: ${sanitizeValue(result.candidates.join(", "))}`
            : "";
        console.warn(
          `team pull: cascading "${sanitizeValue(entry.name)}" failed (${result.kind})${detail} — skipped`,
        );
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
    retiredCount,
  };
}
