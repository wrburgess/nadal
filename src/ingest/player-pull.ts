import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { openDb } from "../db/client.js";
import type { Db as IngestDb } from "./db-types.js";
import { errorMessage } from "../error-message.js";
import { players, teamMatches } from "../db/schema.js";
import { archivePage } from "./archive.js";
import {
  AmbiguousIdentityError,
  ambiguousMessage,
  type AmbiguousIdentities,
  type AmbiguousIdentity,
} from "./errors.js";
import { dispositionOfThrown, type FailureDisposition } from "./failure-disposition.js";
import type { PageFetcher } from "./fetch.js";
import { findPlayerByName, resolvePlayer } from "./identity.js";
import { genderWrite } from "./normalize-gender.js";
import { ParseError, parseMatchHistory, parseTennisRecordHeader, type CourtMatchRecord } from "../parsers/index.js";
import { upsertCourtMatch, upsertCourtMatchPlayers, upsertPlayer, upsertRatingObservation } from "./upsert.js";

type Db = ReturnType<typeof openDb>["db"];
type PlayerRow = typeof players.$inferSelect;

const TENNISRECORD_HOST = "https://www.tennisrecord.com";

/** A TennisRecord namesake index is a small ordinal — `&s=5` is "the 5th player called this". */
const NAMESAKE_INDEX_PATTERN = /^\d{1,4}$/;

/** Thrown for an `&s=` that is present on a roster link but not an ordinal. Refused rather than
 * dropped: dropping it is precisely the #167 defect, and silently fetching the default namesake is
 * a wrong HUMAN, not a missing field. */
export class UnusableNamesakeIndexError extends Error {}

/**
 * `/adult/profile.aspx?playername=Ellis+Eastwick` → the match-history URL for the same player.
 *
 * `namesakeIndex` is TennisRecord's `&s=` parameter, which selects BETWEEN people who share a name
 * (issue #167). It is not decoration and it is not optional when the roster link carries one:
 * without it the request resolves to that name's default profile, which is a different person whose
 * page parses perfectly. Measured 2026-08-14 — `playername=Andy+Wang` is a 5.5 player in Lorton VA;
 * `&s=15` is the 3.5 player in Papillion NE who is actually on the roster.
 *
 * `undefined`/`null` means the roster link carried no index, which is TennisRecord's own way of
 * saying the name is unique — so the parameter is omitted rather than defaulted to any value.
 */
export function matchHistoryUrlFor(playername: string, year: string, namesakeIndex?: string | null): string {
  const params = new URLSearchParams({ year, playername, mt: "0", lt: "0", yr: "0" });
  if (namesakeIndex !== undefined && namesakeIndex !== null && namesakeIndex !== "") {
    if (!NAMESAKE_INDEX_PATTERN.test(namesakeIndex)) {
      throw new UnusableNamesakeIndexError(`unusable namesake index "${namesakeIndex}"`);
    }
    params.set("s", namesakeIndex);
  }
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
  /**
   * How this pull may claim `players.tennisrecord_url` — the durable handle
   * `tn player pull "<name>"` later RESOLVES, and which `resolveTargetUrl` treats as
   * `unknown-target` when it is null.
   *
   * - `"always"` (default) — write this pull's URL, as every caller outside the cascade does.
   * - `"only-if-missing"` — write it **only** when the player has no handle yet.
   *
   * `team-pull`'s multi-season cascade (#108) passes `"only-if-missing"` for every season but the
   * newest, and the policy has to be exactly this, for two failures pulled in opposite directions by
   * two review rounds:
   *
   * - An unconditional write let the LAST write — the oldest season, since the cascade runs
   *   newest-first — win, silently pinning every future refresh of that player to the oldest season
   *   in the range. (Codex round 1, rated high.)
   * - Suppressing the write outright then left a player CREATED by this pull with a null handle
   *   whenever their newest season failed and an older one succeeded: matches and ratings landed, but
   *   `tn player pull "<name>"` answered `unknown-target` and there was no way back to them by name.
   *   (Codex round 2, rated high — a defect in the round-1 fix.)
   *
   * "Only if missing" satisfies both: a successful newest-season pull claims the handle first and
   * older seasons cannot downgrade it, while a player whose newest season failed still ends up with
   * the best handle actually obtained rather than none.
   */
  storeProfileUrl?: "always" | "only-if-missing";
};

/**
 * The ambiguous outcome, in the shape every reporting surface already reads (#96).
 *
 * `identities` is the whole pass — every ambiguity it met, in encounter order, each once. The three
 * FLAT fields are `identities[0]`, kept so that every reader written against #94's shape keeps
 * working unchanged: both CLI commands and both MCP pull tools hand this object straight to
 * `ambiguousMessage`, which now reports all of them BECAUSE the object carries them, with no edit
 * to those files (they belong to a parallel change). Built only through `ambiguousOutcome` below,
 * so the flat fields cannot disagree with the list.
 */
type AmbiguousPullOutcome = { kind: "ambiguous"; disposition: "permanent" } & AmbiguousIdentity & AmbiguousIdentities;

function ambiguousOutcome(identities: readonly [AmbiguousIdentity, ...AmbiguousIdentity[]]): AmbiguousPullOutcome {
  const [first] = identities;
  // Set HERE, in the one constructor of this outcome, for the same reason the flat fields are derived
  // here: a disposition assigned at each call site is one a future site can forget or contradict.
  // Always `permanent` — a re-run refuses identically until a human rules with `tn player distinct` /
  // `tn player alias`, which is a decision no retry can make.
  return { kind: "ambiguous", disposition: "permanent", ...first, identities };
}

/**
 * Every non-`ok` variant carries a `disposition` (#98), so a consumer can act on the outcome without
 * branching on `kind` first and without parsing `message`. That uniformity is the point: `pullTeam`'s
 * cascade reads `result.disposition` for whatever came back, and a variant added later that forgets
 * the field is a compile error rather than a silently unclassified failure.
 *
 * `unknown-target` and `ambiguous` are `permanent` by construction — a player with no stored handle
 * and an unruled identity are both states a retry cannot leave. Only `error` is classified from the
 * caught value, at the three sites in `pullPlayer` where the typed error still exists.
 */
export type PlayerPullResult =
  | {
      kind: "ok";
      player: PlayerRow;
      courtMatchCount: number;
      archivedPath: string;
    }
  | { kind: "unknown-target"; message: string; disposition: "permanent" }
  | AmbiguousPullOutcome
  | { kind: "error"; message: string; disposition: FailureDisposition };

function resolveTargetUrl(
  db: Db,
  target: string,
): { kind: "url"; url: string } | { kind: "unknown-target" } | AmbiguousPullOutcome {
  if (/^https?:\/\//i.test(target)) return { kind: "url", url: target };
  if (target.startsWith("tr:")) return { kind: "url", url: target.slice(3) };

  const found = findPlayerByName(db, target);
  if (found.kind === "found") {
    if (found.row.tennisrecordUrl === null) return { kind: "unknown-target" };
    return { kind: "url", url: found.row.tennisrecordUrl };
  }
  if (found.kind === "ambiguous") {
    // The target the caller typed IS the incoming name here — this tier reports the same three
    // facts as every deeper one rather than the candidates alone, so a reader never has to know
    // which layer refused to know what they were being asked about.
    //
    // Exactly one identity, always: this tier refuses before a page is even fetched, so there is no
    // second name in play. The collecting pass below is the one that can meet several.
    return ambiguousOutcome([
      {
        incoming: target,
        candidates: found.candidates.map((p) => p.canonicalName),
        context: "player name target",
      },
    ]);
  }
  return { kind: "unknown-target" };
}

function setsToScore(record: CourtMatchRecord): string {
  return record.sets.map((s) => `${s.matchWinnerGames}-${s.matchLoserGames}`).join(" ");
}

/** One match record with its participants already resolved to ids — the output of pass 1 below. */
type ResolvedMatch = { record: CourtMatchRecord; partnerId: number | null; opponentIds: number[] };

/**
 * PASS 1 of a pull: resolve every partner and opponent the match history names, handing each
 * ambiguity to `note` instead of throwing at the first (#96). Resolution is what DISCOVERS an
 * ambiguity, so it has to keep going to find the rest; it also CREATES rows for names not yet on
 * file, exactly as it did before, and the caller's refusal discards them with everything else when
 * anything was noted.
 *
 * Called from both of `pullPlayer`'s paths — including the one whose profile name is itself
 * ambiguous, which used to refuse before a single history name was looked at.
 */
function resolveHistory(
  tx: IngestDb,
  matches: CourtMatchRecord[],
  note: (identity: AmbiguousIdentity) => void,
): ResolvedMatch[] {
  const resolvedMatches: ResolvedMatch[] = [];
  for (const record of matches) {
    let partnerId: number | null = null;
    if (record.partner !== null) {
      const partner = resolvePlayer(tx, { name: record.partner.name });
      if (partner.kind === "ambiguous") {
        note({
          incoming: record.partner.name,
          candidates: partner.candidates.map((p) => p.canonicalName),
          context: "match partner",
        });
      } else {
        partnerId = partner.row.id;
      }
    }

    const opponentIds: number[] = [];
    for (const opponent of record.opponents) {
      const resolvedOpponent = resolvePlayer(tx, { name: opponent.name });
      if (resolvedOpponent.kind === "ambiguous") {
        note({
          incoming: opponent.name,
          candidates: resolvedOpponent.candidates.map((p) => p.canonicalName),
          context: "match opponent",
        });
      } else {
        opponentIds.push(resolvedOpponent.row.id);
      }
    }

    resolvedMatches.push({ record, partnerId, opponentIds });
  }
  return resolvedMatches;
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
 *
 * The abort is unchanged; what changed (#96) is that ONE pass now reports EVERY ambiguity it met
 * rather than the first. Aborting at the first cost one slow network round trip per remaining one —
 * `Dale Dixon` took four attempts live, and a team's `--players` cascade re-fetches every roster
 * member to reach the next one, which is what made `NE/Penland` a three-run job. So the pass keeps
 * RESOLVING after the first refusal (resolution is what discovers an ambiguity) and stops WRITING,
 * because every remaining write needs an id the ambiguity denied us and the transaction is going to
 * roll back regardless.
 *
 * One caveat worth stating rather than implying: the collected set is what THIS pass met, in the
 * database as it stood. Ruling on one ambiguity adds a row, which can change how a later name
 * resolves — so the set is a reliable list of decisions to make, not a promise that the next run
 * meets none. It is strictly more than the one identity a run used to surface.
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
        return {
          kind: "unknown-target",
          message: `unknown player target "${options.target}"`,
          disposition: "permanent",
        };
      }
      if (resolved.kind === "ambiguous") return resolved;
      resolvedUrl = resolved.url;
    } else {
      // A caller-shape mistake, not a runtime fault: no retry supplies an argument that was never
      // passed. Named `permanent` directly rather than run through the classifier, which reads a
      // caught value and there is none here.
      return {
        kind: "error",
        message: "pullPlayer: one of target, url, or from is required",
        disposition: "permanent",
      };
    }
    url = resolvedUrl;
    try {
      const page = await fetchPage(url);
      body = page.body;
      httpStatus = page.status;
    } catch (err) {
      // The fetch `catch`: `err` is still the FetchError / timeout / socket failure here, and this is
      // the only place its status and code exist. One line down it is a string (#98).
      return { kind: "error", message: errorMessage(err), disposition: dispositionOfThrown(err) };
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
    if (err instanceof ParseError)
      return { kind: "error", message: err.message, disposition: dispositionOfThrown(err) };
    throw err;
  }

  try {
    const player = db.transaction((tx) => {
      // Every ambiguity this pass meets, in encounter order. Recorded rather than thrown at, so one
      // pass surfaces every decision a human has to make instead of the first (#96).
      const ambiguities: AmbiguousIdentity[] = [];
      // Deduped on the RENDERED facts: the fixture case is a partner named in three of one player's
      // fourteen matches, which is one decision, not three lines of report. Comparing the rendering
      // rather than the object is what makes "the same reported fact" the key — two encounters that
      // read identically to a human ARE the same decision.
      const note = (identity: AmbiguousIdentity): void => {
        const rendered = ambiguousMessage(identity);
        if (ambiguities.some((seen) => ambiguousMessage(seen) === rendered)) return;
        ambiguities.push(identity);
      };

      const resolved = resolvePlayer(tx, { tennisrecordUrl: url, name: header.name });
      if (resolved.kind === "ambiguous") {
        // The pull cannot proceed without knowing whose page this is — but the history's OWN
        // identities resolve against the database, not against this row, and they used to be hidden
        // behind this refusal. Scan for them, then refuse once with everything.
        const profileIdentity: AmbiguousIdentity = {
          incoming: header.name,
          candidates: resolved.candidates.map((p) => p.canonicalName),
          context: "player profile name",
        };
        note(profileIdentity);
        resolveHistory(tx, matches, note);
        // `profileIdentity` was the first thing noted, so this IS `ambiguities` — spelled as a
        // literal tuple because that is what proves non-emptiness to the type, and refusing here
        // (rather than falling through to a shared exit) is what keeps `profiled` below a plain
        // non-null const with no unreachable guard standing behind it.
        throw new AmbiguousIdentityError([profileIdentity, ...ambiguities.slice(1)]);
      }

      const profiled = upsertPlayer(tx, {
        id: resolved.row.id,
        canonicalName: header.name,
        // `undefined` LEAVES the stored handle alone (`upsertPlayer` only writes fields that are
        // defined) rather than nulling it — which is what lets an older-season cascade pull enrich
        // matches and ratings without downgrading the durable URL. The `!== null` half is what keeps
        // a player who has NO handle yet from being left unreachable by name. See `storeProfileUrl`.
        tennisrecordUrl:
          options.storeProfileUrl === "only-if-missing" && resolved.row.tennisrecordUrl !== null ? undefined : url,
        // `header.gender` is already `"Male" | "Female" | null` — `genderOf()` in
        // `src/parsers/tennisrecord/header.ts` normalizes at parse time, so this is a no-op today.
        // Routed through `normalizeGender` anyway (issue #130): it is the ONE place every writer of
        // `players.gender` meets, and leaving this site out is exactly how the column ended up with
        // two writers that disagreed in the first place (`src/ingest/archived.ts` wrote raw).
        gender: genderWrite(header.gender),
      });

      if (header.ntrp !== null) {
        upsertRatingObservation(tx, {
          playerId: profiled.id,
          source: "ntrp",
          value: header.ntrp.value,
          ratingType: header.ntrp.ratingType,
          observedOn: header.ntrp.observedOn,
        });
      }
      if (header.dynamicRating !== null) {
        upsertRatingObservation(tx, {
          playerId: profiled.id,
          source: "tr_dynamic",
          value: header.dynamicRating.value,
          ratingType: null,
          observedOn: header.dynamicRating.observedOn,
        });
      }

      // PASS 1 — resolve every identity the page names, noting each ambiguity. The profile upsert
      // above stays AHEAD of this call, as it always was: a rename applies to `players` before a
      // history name is fuzzy-matched against it, and moving the write after the scan would quietly
      // change which row a near-name matches.
      const resolvedMatches = resolveHistory(tx, matches, note);

      // ONE refusal for the whole pass, thrown inside the transaction exactly as before: better-
      // sqlite3/drizzle roll back on a thrown error, which IS the no-partial-write guarantee spec §
      // Ingestion requires. Nothing about that changed — only how much the refusal can tell you.
      const [firstAmbiguity, ...furtherAmbiguities] = ambiguities;
      if (firstAmbiguity !== undefined) {
        throw new AmbiguousIdentityError([firstAmbiguity, ...furtherAmbiguities]);
      }

      // PASS 2 — nothing was ambiguous, so every id below exists and every write lands.
      for (const { record, partnerId, opponentIds } of resolvedMatches) {
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

        upsertCourtMatchPlayers(tx, { courtMatchId: courtMatch.id, playerId: profiled.id, side: "home" });

        // Null here means SINGLES — the ambiguous partner case never reaches this loop.
        if (partnerId !== null) {
          upsertCourtMatchPlayers(tx, { courtMatchId: courtMatch.id, playerId: partnerId, side: "home" });
        }
        for (const opponentId of opponentIds) {
          upsertCourtMatchPlayers(tx, { courtMatchId: courtMatch.id, playerId: opponentId, side: "visiting" });
        }
      }

      return profiled;
    });

    return { kind: "ok", player, courtMatchCount: matches.length, archivedPath };
  } catch (err) {
    if (err instanceof AmbiguousIdentityError) return ambiguousOutcome(err.identities);
    // The write transaction's `catch`. NOT uniformly permanent: `SQLITE_BUSY` from a concurrent
    // writer is exactly the failure a re-run clears, and collapsing it into `permanent` would send an
    // operator to investigate contention that had already resolved.
    return { kind: "error", message: errorMessage(err), disposition: dispositionOfThrown(err) };
  }
}
