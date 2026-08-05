import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { openDb } from "../db/client.js";
import { teams } from "../db/schema.js";
import { hrefParam } from "../parsers/dom.js";
import { ParseError, parseTennisRecordTeam } from "../parsers/index.js";
import { archivePage } from "./archive.js";
import { AmbiguousIdentityError, ambiguousMessage, type AmbiguousIdentity } from "./errors.js";
import type { Clock, PageFetcher } from "./fetch.js";
import { findTeamByName, resolvePlayer, resolveTeam } from "./identity.js";
import { matchHistoryUrlFor, pullPlayer, slugFromUrl, type PlayerPullResult } from "./player-pull.js";
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
  /**
   * `--since`: the EARLIEST season the `--players` cascade fetches. Omitted, it defaults to the
   * season before the team page's own — see `cascadeYears`, which owns the whole rule.
   */
  since?: string;
  /**
   * Injectable so the "team URL carries no `year=`" fallback is testable without a wall-clock read.
   * Defaults to the real clock. Same `Clock` shape `fetchPage` already injects.
   */
  clock?: Clock;
};

export type TeamPullResult =
  | {
      kind: "ok";
      team: TeamRow;
      rosterCount: number;
      matchCount: number;
      archivedPath: string;
      /**
       * Issue #108: each entry is `"<name> (year=<Y>)"`, not a bare name. The cascade now spans
       * several seasons, and the SAME player can fail one season and succeed another — a bare name
       * cannot say which, so an operator reading only this list could not tell a player with no data
       * at all from one missing a single year. Empty when nothing was skipped.
       */
      skippedRosterEntries: string[];
      /**
       * Issue #108: the seasons the `--players` cascade actually fetched, newest first — empty when
       * no cascade ran. Reported so a reader of the summary line can tell a one-year pull from a
       * range pull without inspecting archive filenames, which is how this defect stayed invisible.
       * This is the SAME list the cascade looped over, never a second computation of it.
       */
      years: string[];
      /** Issue #49: how many pre-existing roster rows this pull just soft-retired (present before,
       * absent from this parse). Surfaced on the result — not only in the database — because
       * retirement removes a player from every current-roster read/write, and a caller relying on
       * `rosterCount` alone would have no way to notice a roster shrank rather than merely failed
       * to grow. */
      retiredCount: number;
    }
  | { kind: "unknown-target"; message: string }
  | ({ kind: "ambiguous" } & AmbiguousIdentity)
  | { kind: "error"; message: string };

function resolveTargetUrl(
  db: Db,
  target: string,
): { kind: "url"; url: string } | { kind: "unknown-target" } | ({ kind: "ambiguous" } & AmbiguousIdentity) {
  if (/^https?:\/\//i.test(target)) return { kind: "url", url: target };
  if (target.startsWith("tr:")) return { kind: "url", url: target.slice(3) };

  const found = findTeamByName(db, target);
  if (found.kind === "found") {
    if (found.row.tennisrecordUrl === null) return { kind: "unknown-target" };
    return { kind: "url", url: found.row.tennisrecordUrl };
  }
  if (found.kind === "ambiguous") {
    // Same as `player pull`'s own target tier: the typed target IS the incoming name, reported
    // alongside the candidates rather than left for the reader to infer.
    return {
      kind: "ambiguous",
      incoming: target,
      candidates: found.candidates.map((t) => t.name),
      context: "team name target",
    };
  }
  return { kind: "unknown-target" };
}

/**
 * The one stderr line a failed cascade prints. `console.warn` is a RAW write with no summary
 * formatter in front of it, so this function is the only place that line's shape exists.
 *
 * Every non-`ok` kind reports its reason (#96). Before, only `ambiguous` did, and the other two
 * printed the bare kind name:
 *
 *   team pull: cascading "Jim Vanderveen" failed (error) — skipped
 *
 * `(error)` was the whole diagnosis, while `PlayerPullResult` carried a populated `message` the line
 * discarded — so a network timeout, an HTTP 404 and a `ParseError`, which want three different
 * responses from an operator, were indistinguishable. That is the same defect class #94 was opened
 * for, one branch over, and it survived #94 because those two branches were pinned by no test.
 *
 * Exported for `test/ingest-team-pull.test.ts`, which is the only way to assert the
 * `unknown-target` branch at all: the cascade calls `pullPlayer` with a `url` and never a name
 * target, so that kind — produced only by `resolveTargetUrl` — is unreachable through `pullTeam`.
 * An unreachable branch left unasserted is exactly how this one shipped reporting nothing.
 *
 * SANITIZED ONCE, over the WHOLE rendered line. Both interpolated values are attacker-influenced —
 * `entryName` is parsed from a fetched roster page, and a reason can quote the document a parser
 * choked on — and sanitizing the finished line rather than each field is what keeps either of them
 * from forging the punctuation that separates the facts.
 */
export function cascadeFailureWarning(entryName: string, result: Exclude<PlayerPullResult, { kind: "ok" }>): string {
  const reason = result.kind === "ambiguous" ? ambiguousMessage(result) : result.message;
  // A reason that renders to nothing but spaces — an `Error("")`, or a message made entirely of
  // control characters the sanitizer replaces — would print as ` —  — skipped`, which reads as a
  // truncated line rather than as "this failure carried no reason", and is indistinguishable at a
  // glance from the defect above. Say the kind and stop.
  const detail = sanitizeValue(reason).trim() === "" ? "" : ` — ${reason}`;
  return sanitizeValue(`team pull: cascading "${entryName}" failed (${result.kind})${detail} — skipped`);
}

/**
 * How many seasons one cascade may span. A typo bound, not a policy: `--since 1990` against a 2026
 * team page would otherwise launch ~37 match-history requests PER ROSTER ENTRY against a source
 * already observed rate-limiting (#98 measured four transient failures in a single 20-player run).
 */
export const MAX_CASCADE_YEARS = 10;

const FOUR_DIGIT_YEAR = /^\d{4}$/;

/**
 * The seasons one `--players` cascade fetches, newest first — issue #108.
 *
 * **One derivation, read once.** `team-pull` fetches the list it reports and reports the list it
 * fetched, because there is only ever one list. #90 / PR #91 spent two review rounds on the opposite
 * shape — a filter bound and its printed label carried as separate values, which a caller could set
 * to disagree so the code filtered 2025 and printed 2026 — and the thing that finally closed it was
 * *read the value once into a local, validate it, derive everything from that primitive*. This
 * function is that read; nothing else in the pull may recompute a year.
 *
 * **Newest-first is deliberate**, not incidental ordering. Rate-limiting is a live failure mode, so
 * a run that dies partway should have completed the MOST RECENT season across the whole roster —
 * comparable evidence for every player — rather than an arbitrary prefix of players across every
 * season. The caller's loop is year-outer for the same reason.
 *
 * **Returns a refusal rather than throwing.** `pullTeam`'s transaction try/catch closes above the
 * cascade, so a throw here would escape the function entirely; every caller already reports a
 * `{ kind: "error" }` as `status=error`.
 */
export function cascadeYears(
  teamYear: string,
  since?: string,
): { kind: "ok"; years: string[] } | { kind: "error"; message: string } {
  if (!FOUR_DIGIT_YEAR.test(teamYear)) {
    return {
      kind: "error",
      message: `team page season "${sanitizeValue(teamYear)}" is not a four-digit year`,
    };
  }
  const newest = Number(teamYear);
  // The DEFAULT is the fix. A caller who never learns `--since` exists still gets the two-season
  // pull, so a forgotten flag cannot silently reintroduce the one-year cascade this issue closes.
  const oldestRaw = since ?? String(newest - 1);
  if (!FOUR_DIGIT_YEAR.test(oldestRaw)) {
    // Blame the value the CALLER actually supplied, never one this function derived. A team page at
    // `year=1000` with no `--since` at all derives `"999"`, and reporting that as
    // `--since "999" is not a four-digit year` accuses the operator of passing a flag they never
    // typed — the #94 defect class exactly (report the value that actually failed), and unactionable
    // besides, since there is no `--since` for them to go and correct.
    return {
      kind: "error",
      message:
        since === undefined
          ? `the season before the team page's ${newest} is not a four-digit year — pass an explicit --since`
          : `--since "${sanitizeValue(oldestRaw)}" is not a four-digit year`,
    };
  }
  const oldest = Number(oldestRaw);
  if (oldest > newest) {
    return {
      kind: "error",
      message: `--since ${oldest} is later than the team page's season ${newest} — that range holds no seasons`,
    };
  }
  const span = newest - oldest + 1;
  if (span > MAX_CASCADE_YEARS) {
    return {
      kind: "error",
      message: `--since ${oldest} spans ${span} seasons back from ${newest}; the cascade fetches at most ${MAX_CASCADE_YEARS}`,
    };
  }
  const years: string[] = [];
  for (let year = newest; year >= oldest; year -= 1) years.push(String(year));
  return { kind: "ok", years };
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
  const clock = options.clock ?? { now: () => Date.now() };

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
    if (resolved.kind === "ambiguous") return resolved;
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

  // Derived HERE — after `url` is known, before the archive and before the team transaction — so a
  // bad `--since` refuses without leaving a committed write or an archived page behind. It costs one
  // already-completed GET on the refusal path, and that is the deliberate price of having exactly
  // ONE derivation site: a cheap shape-check up here plus the real rule further down would be two
  // spellings of one predicate, which is how a guard rots sideways one edit at a time.
  //
  // `teamYear` is read from the TEAM page's own URL and is NEVER used to re-fetch a team page. A
  // `year=<older>` team profile is a stale roster snapshot, and `retireAbsentMemberships` below
  // would retire every player who joined since — silent roster loss. The range is a property of the
  // PLAYER match-history cascade alone; the team page stays exactly one fetch at its own season.
  const teamYear = hrefParam(url, "year") ?? String(new Date(clock.now()).getUTCFullYear());
  const cascade = cascadePlayers ? cascadeYears(teamYear, options.since) : { kind: "ok" as const, years: [] };
  if (cascade.kind === "error") return { kind: "error", message: cascade.message };

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
          // ONE identity, refused at the first — deliberately NOT collected the way `pullPlayer`
          // now collects (#96). Continuing this loop past an ambiguous row would leave
          // `observedPlayerIds` partial, and `retireAbsentMemberships` below reconciles departures
          // against exactly that list, in this same transaction: the partial-roster hazard the
          // comment on that call names. The measured cost of one-at-a-time was in the CASCADE
          // (NE/Penland, three full runs), and the cascade is a `pullPlayer` concern.
          throw new AmbiguousIdentityError([
            {
              incoming: entry.name,
              candidates: resolved.candidates.map((p) => p.canonicalName),
              context: "team roster row",
            },
          ]);
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
          throw new AmbiguousIdentityError([
            {
              incoming: row.opponentTeamName,
              candidates: opponent.candidates.map((t) => t.name),
              context: "schedule opponent team",
            },
          ]);
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
    // YEAR-OUTER, roster-inner — see `cascadeYears` for why the list is newest-first. Together they
    // mean an interrupted run has completed the most recent season for EVERY player (comparable
    // evidence across the field) rather than every season for an arbitrary prefix of players.
    // A missing profile link is a property of the ROSTER ENTRY, not of any season — no season was
    // ever attempted for it — so it is recorded ONCE, here, before the season loop begins, and
    // without a `year=` qualifier. Hoisted out rather than guarded inside the loop with a
    // "first season only" condition: that condition would be a value comparison standing in for an
    // iteration index, and no fixture could distinguish it from the wrong index, leaving a branch in
    // new code that no test can kill (`rules/testing.md`).
    for (const entry of parsed.roster) {
      const linked = entry.profilePath === null ? null : hrefParam(entry.profilePath, "playername");
      if (linked === null || linked === "") {
        skippedRosterEntries.push(entry.name);
        // `entry.name` is parsed from a fetched roster page, so it is attacker-influenced and this
        // is a raw stderr write with no summary formatter in front of it (`emitSummary` sanitizes;
        // a bare `console.warn` does not). Found by the independent Codex review of PR #47.
        console.warn(`team pull: roster entry "${sanitizeValue(entry.name)}" has no profile link — skipped`);
      }
    }

    for (const year of cascade.years) {
      for (const entry of parsed.roster) {
        const playername = entry.profilePath === null ? null : hrefParam(entry.profilePath, "playername");
        if (playername === null || playername === "") continue;
        const playerUrl = matchHistoryUrlFor(playername, year);
        const result = await pullPlayer({ db, fetchPage, url: playerUrl });
        if (result.kind !== "ok") {
          // Qualified by season (#108): the same player can fail one year and succeed another, and a
          // bare name in this list could not tell an operator which — or whether a retry should
          // re-fetch one season or all of them.
          skippedRosterEntries.push(`${entry.name} (year=${year})`);
          // Names the identity that actually failed, not the player we happened to be cascading, and
          // says WHY for every failure kind — see `cascadeFailureWarning` for both defects and for
          // why its shape lives in one function rather than inline here.
          console.warn(cascadeFailureWarning(`${entry.name} (year=${year})`, result));
        }
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
    // The list the loop above actually iterated — not a recomputation. See `cascadeYears`.
    years: cascade.years,
  };
}
