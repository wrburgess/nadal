// The ingest service for a scorecard payload (Task 3, #18). Both `tn match add` (a JSON file on
// disk) and the `match_add` MCP tool (the agent's inline extraction) call THIS function — the same
// service behind two presenters, so the two surfaces cannot drift on what a valid ingest does.

import { and, eq, isNull, or } from "drizzle-orm";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { courtMatchPlayers, events, teamMatches, teams } from "../db/schema.js";
import { assertInputPathSafe } from "../fs/output-root.js";
import { archivePage } from "./archive.js";
import type { Db } from "./db-types.js";
import { findTeamByName, resolveRosterPlayer } from "./identity.js";
import { slugFromUrl } from "./player-pull.js";
import type { ScorecardPayload } from "./scorecard.js";
import { normalizeSiteKey, normalizeTimeKey, upsertCourtMatch, upsertCourtMatchPlayers } from "./upsert.js";

type TeamRow = typeof teams.$inferSelect;
type TeamMatchRow = typeof teamMatches.$inferSelect;

export type MatchAddPlayerFlag = {
  name: string;
  /** `off-roster` (Codex adversarial review of PR #54, High finding 1) is distinct from
   * `unresolved`: the name/id resolved to a REAL player, just not one on the payload's OWN team
   * roster — worth telling apart from a true miss in the refusal message. */
  reason: "unresolved" | "ambiguous" | "off-roster";
  /** Every candidate `resolveRosterPlayer` saw for this name — empty for a true `unresolved` miss,
   * exactly one entry (the off-roster player's own name) for `off-roster`. */
  candidates: string[];
};

/** One payload occurrence — a side plus the exact name/prefix-ID as given — that resolved to a
 * player ALREADY seen elsewhere in the same court (PR #54 verify findings 1a-1d). */
export type MatchAddDuplicateOccurrence = { side: "home" | "visiting"; name: string };

export type MatchAddDuplicatePlayerFlag = {
  slot: string;
  playerId: number;
  /** Every occurrence of this player within this one court, in payload order — always 2 or more. */
  occurrences: MatchAddDuplicateOccurrence[];
};

/** One pre-existing, source-less `team_matches` row that is lenient-COMPATIBLE with the incoming
 * payload but not an EXACT match for it (Codex adversarial review of PR #54 round 3, High finding
 * 2) — named so the operator can supply the missing discriminator and pick the right one. */
export type MatchAddAmbiguousParentCandidate = { teamMatchId: number; scheduledTime: string | null; site: string | null };

export type AddMatchFromScorecardResult =
  | { ok: true; teamMatchId: number; courts: number }
  | { ok: false; kind: "unknown-team"; team: string; candidates: string[] }
  | { ok: false; kind: "unknown-event"; event: string }
  | { ok: false; kind: "unresolved-players"; flags: MatchAddPlayerFlag[] }
  | { ok: false; kind: "same-team"; team: string }
  | { ok: false; kind: "duplicate-players"; duplicates: MatchAddDuplicatePlayerFlag[] }
  | { ok: false; kind: "duplicate-slots"; slots: string[] }
  | { ok: false; kind: "ambiguous-parent-match"; candidates: MatchAddAmbiguousParentCandidate[] }
  | {
      ok: false;
      kind: "conflicting-parent-event";
      teamMatchId: number;
      existingEventId: number;
      incomingEventId: number;
    };

/** Thrown inside the transaction to abort it — better-sqlite3/drizzle roll back automatically on a
 * thrown error, same "no partial write" precedent as `AmbiguousIdentityError`
 * (`src/ingest/archived.ts:66-67`). Caught right outside `db.transaction`, below, and translated
 * into the matching `AddMatchFromScorecardResult` failure variant. */
class UnknownTeamRefusal extends Error {
  constructor(
    readonly team: string,
    readonly candidates: string[] = [],
  ) {
    super(`unknown team "${team}"`);
  }
}
class UnknownEventRefusal extends Error {
  constructor(readonly event: string) {
    super(`unknown event "${event}"`);
  }
}
class UnresolvedPlayersRefusal extends Error {
  constructor(readonly flags: MatchAddPlayerFlag[]) {
    super(`unresolved player name(s): ${flags.map((f) => f.name).join(", ")}`);
  }
}
class SameTeamRefusal extends Error {
  constructor(readonly team: string) {
    super(`homeTeam and visitingTeam both resolve to the same team "${team}"`);
  }
}
class DuplicatePlayersRefusal extends Error {
  constructor(readonly duplicates: MatchAddDuplicatePlayerFlag[]) {
    super(`duplicate participant(s) across ${duplicates.length} court(s)`);
  }
}
class DuplicateSlotsRefusal extends Error {
  constructor(readonly slots: string[]) {
    super(`duplicate court slot(s): ${slots.join(", ")}`);
  }
}
class AmbiguousParentMatchRefusal extends Error {
  constructor(readonly candidates: MatchAddAmbiguousParentCandidate[]) {
    super(`ambiguous parent match: ${candidates.length} lenient-compatible candidates`);
  }
}
class ConflictingParentEventRefusal extends Error {
  constructor(
    readonly teamMatchId: number,
    readonly existingEventId: number,
    readonly incomingEventId: number,
  ) {
    super(
      `conflicting event for existing team match ${teamMatchId}: stored event ${existingEventId} vs incoming event ${incomingEventId}`,
    );
  }
}

/**
 * Resolve one side's team by name — NEVER creates (a team is created by `team pull`, not here).
 * An ambiguous name is refused the same way an unknown one is: this ingest cannot safely guess
 * between two similarly-named teams any more than it can guess a player, so both collapse to the
 * one `"unknown-team"` result kind, carrying whatever candidates were seen (empty for a true miss).
 */
function requireTeam(db: Db, name: string): TeamRow {
  const found = findTeamByName(db, name);
  if (found.kind === "found") return found.row;
  throw new UnknownTeamRefusal(name, found.kind === "ambiguous" ? found.candidates.map((t) => t.name) : []);
}

/**
 * The lenient, MATCH-ADD-ONLY parent-match resolver (HC decision on Codex adversarial review of
 * PR #54 round 2, High finding B — "fill in blanks", scoped to this service; `upsertTeamMatch` and
 * the `team-pull`/TennisRecord scraping path that calls it are UNTOUCHED). `upsertTeamMatch`'s own
 * id-less branch requires `scheduledTime`/`site` to compare EQUAL (after normalization) before
 * treating two rows as the same fixture — correct for a scraped re-pull of an already-complete
 * page, too strict for a photo-correction workflow, where an early, hurried capture commonly omits
 * a detail (the time, say) that a later, careful transcription supplies.
 *
 * Per discriminator, independently: a BLANK value on EITHER side (stored or incoming) is
 * compatible with anything on the other — never a mismatch — and `stored ?? incoming` is what gets
 * written, so a later blank re-ingest can never null out a detail an earlier one supplied, and an
 * earlier blank is filled in by a later ingest that supplies one. This is symmetric by
 * construction: which of the two ingests happens to be missing the detail does not matter. Two
 * SUPPLIED values that disagree after normalization are still a genuinely DIFFERENT fixture — the
 * doubleheader guard PR #31 added survives intact, because "supplied and different" is a real
 * conflict, never treated as blank. Shares `normalizeTimeKey`/`normalizeSiteKey` with
 * `upsertTeamMatch` rather than a second hand-rolled notion of "the same time"/"the same site" —
 * the exact class of defect #32 already closed once for names ("one ladder, two notions of a
 * name"). Mirrors `upsertTeamMatch`'s own id-less candidate query (unordered team pair + exact
 * `playedOn`, no `sourceMatchId`) and, like it, never rewrites `homeTeamId`/`visitingTeamId`
 * on an update — an existing row's stored orientation is left exactly as first written.
 * `homeCourtsWon`/`visitingCourtsWon` are likewise left untouched on an update: this service never
 * computes them (always null on insert), so it has nothing honest to write over whatever another
 * writer (e.g. `team-pull`, on a fixture this same photo also happens to match) already recorded.
 *
 * ACCEPTED RISK (HC-approved trade — record here, and see `docs/findings.md`): a genuine SECOND
 * same-day fixture between the same two teams whose FIRST ingest omitted a discriminator (say, no
 * time was captured) can be silently absorbed into that first match on a later ingest, rather than
 * creating the second match a strict comparison would have. This risk runs in BOTH directions —
 * corrected from an earlier, narrower claim (Codex adversarial review of PR #54 round 3, High
 * finding 1: the original wording here said "ONLY when the STORED side is blank", which is FALSE,
 * since `compatible` accepts a blank on EITHER side). A later fixture that OMITS a discriminator
 * can just as easily be absorbed into an EARLIER one that SUPPLIED it, as an earlier blank can be
 * filled in by a later supplied value — `compatible` does not know or care which ingest came first,
 * only which side (if either) is blank right now. The ONLY case that reliably discriminates two
 * genuinely different fixtures is BOTH sides SUPPLIED and DIFFERENT after normalization (a real
 * conflict still inserts a new row, per the doubleheader-guard test) — every other combination
 * involving a blank on either side is, by this function's own design, treated as the same match.
 * The HC accepted this for in-event ergonomics: a scorekeeper correcting a scorecard mid-event
 * should not also have to know whether every discriminator was captured perfectly on the first
 * photo, on either the first or a later submission.
 */
function upsertLenientTeamMatchForScorecard(
  db: Db,
  values: {
    eventId: number | null;
    homeTeamId: number;
    visitingTeamId: number;
    playedOn: string;
    scheduledTime: string | null;
    site: string | null;
  },
): TeamMatchRow {
  const candidates = db
    .select()
    .from(teamMatches)
    .where(
      and(
        isNull(teamMatches.sourceMatchId),
        eq(teamMatches.playedOn, values.playedOn),
        or(
          and(eq(teamMatches.homeTeamId, values.homeTeamId), eq(teamMatches.visitingTeamId, values.visitingTeamId)),
          and(eq(teamMatches.homeTeamId, values.visitingTeamId), eq(teamMatches.visitingTeamId, values.homeTeamId)),
        ),
      ),
    )
    .all();

  const compatible = (
    stored: string | null,
    incoming: string | null,
    normalize: (v: string | null | undefined) => string,
  ): boolean => stored === null || incoming === null || normalize(stored) === normalize(incoming);

  // An EXACT discriminator match always wins over a merely blank-compatible one, so the strict pass
  // runs first and the lenient pass is the fallback. Without the ordering, `find` would take
  // whichever row the query happened to return first: given a blank-timed row AND a row whose time
  // equals the incoming one, an incoming ingest could merge into the BLANK row and leave its true
  // match untouched — reachable because `team-pull` writes `team_matches` too, so a scraped row
  // carrying a time can coexist with a match-add row that never captured one. Leniency is meant to
  // fill a gap when nothing better exists, never to outrank an exact fixture match.
  const exact = (
    stored: string | null,
    incoming: string | null,
    normalize: (v: string | null | undefined) => string,
  ): boolean =>
    (stored === null && incoming === null) ||
    (stored !== null && incoming !== null && normalize(stored) === normalize(incoming));

  // FILTERED, not `.find()` (Codex adversarial review of PR #54 round 4, High finding 2 — the
  // FOURTH occurrence of this exact class in this PR: a set that could hold more than one row,
  // picked from with no ambiguity check). There is no DB uniqueness constraint on the id-less
  // natural key `(unordered team pair, playedOn, normalized time, normalized site)`, so two rows
  // that are BOTH an exact match for the same incoming payload are representable — the prior round
  // fixed this for the LENIENT fallback below and left the exact pass, three lines above it, on
  // the identical unguarded `.find()`.
  const exactMatches = candidates.filter(
    (row) =>
      exact(row.scheduledTime, values.scheduledTime, normalizeTimeKey) &&
      exact(row.site, values.site, normalizeSiteKey),
  );
  if (exactMatches.length > 1) {
    throw new AmbiguousParentMatchRefusal(
      exactMatches.map((row) => ({ teamMatchId: row.id, scheduledTime: row.scheduledTime, site: row.site })),
    );
  }

  let existing = exactMatches[0];
  if (existing === undefined) {
    // The lenient fallback, only reached when NO exact match exists. If MORE THAN ONE candidate is
    // lenient-compatible (Codex adversarial review of PR #54 round 3, High finding 2), a silent
    // `.find()` would attach this payload's courts to whichever row the query happens to return
    // first and leave the OTHER equally-compatible row stranded, half-filled, with no error at
    // all. Concretely: a blank-time row and a blank-site row for the same team pair and date can
    // coexist today — `team-pull`'s own matching is STRICT, so it never merges them into one — and
    // an incoming payload supplying BOTH fields is lenient-compatible with both, exact with
    // neither. Refuse instead, naming every candidate so the operator can supply the missing
    // discriminator and disambiguate explicitly — the same "error with candidates, never guess"
    // posture every other ambiguity in this service already takes.
    const lenientMatches = candidates.filter(
      (row) =>
        compatible(row.scheduledTime, values.scheduledTime, normalizeTimeKey) &&
        compatible(row.site, values.site, normalizeSiteKey),
    );
    if (lenientMatches.length > 1) {
      throw new AmbiguousParentMatchRefusal(
        lenientMatches.map((row) => ({ teamMatchId: row.id, scheduledTime: row.scheduledTime, site: row.site })),
      );
    }
    existing = lenientMatches[0];
  }

  if (existing === undefined) {
    return db
      .insert(teamMatches)
      .values({
        eventId: values.eventId,
        homeTeamId: values.homeTeamId,
        visitingTeamId: values.visitingTeamId,
        playedOn: values.playedOn,
        scheduledTime: values.scheduledTime,
        site: values.site,
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      })
      .returning()
      .get();
  }

  // Codex adversarial review of PR #54 round 4, High finding 1: `eventId` used to be written
  // UNCONDITIONALLY on an update, ignoring what was already stored — so a correction submitted
  // with no `event` silently DETACHED an already-linked match (overwritten with NULL), and a
  // correction naming a DIFFERENT event silently MOVED it. Fixed with the SAME symmetric
  // fill-in-blanks idiom already used for `scheduledTime`/`site` just below: an omitted incoming
  // event (`values.eventId === null`) PRESERVES the stored one; a stored-null is FILLED IN by a
  // supplied incoming one; and two DIFFERENT non-null event ids are a genuine CONFLICT — refused,
  // naming both, rather than silently deciding which one wins. Deliberately a DISTINCT result kind
  // from `ambiguous-parent-match`: "which parent row" and "which event to link it to" are
  // different questions for the operator to answer.
  if (existing.eventId !== null && values.eventId !== null && existing.eventId !== values.eventId) {
    throw new ConflictingParentEventRefusal(existing.id, existing.eventId, values.eventId);
  }

  return db
    .update(teamMatches)
    .set({
      eventId: existing.eventId ?? values.eventId,
      // Fill in a blank; NEVER null out an already-stored value — the whole point of this function.
      scheduledTime: existing.scheduledTime ?? values.scheduledTime,
      site: existing.site ?? values.site,
    })
    .where(eq(teamMatches.id, existing.id))
    .returning()
    .get();
}

/**
 * Ingests one scorecard payload: refuses if two courts share a `slot` (Codex adversarial review of
 * PR #54, High finding 2 — see the check itself, below, for why WITHIN one payload `slot` alone is
 * the only thing that can tell two courts apart); resolves both teams and the named event
 * (never-create — see `requireTeam` above), refuses if both teams resolve to the SAME row
 * (comparing the resolved id, never the input strings — two spellings/aliases of one team count);
 * resolves EVERY player on both sides through the roster-scoped, never-create ladder
 * (`resolveRosterPlayer`, Task 2), refuses if any RESOLVED player appears more than once across a
 * single court's two sides (PR #54 verify findings 1-2 — same reasoning as the team check:
 * compared by resolved `playerId`, never by the input name, since a duplicate can arrive as an
 * identical string, two names sharing an alias, a `usta:` id duplicating a bare name, or the same
 * player rostered on both teams at once per bug #49's append-only `team_memberships`) — and if ANY
 * of these checks fails, collects every violation of that kind before refusing, rolling the WHOLE
 * ingest back rather than writing a partial match (mirrors the `AmbiguousIdentityError`-inside-a-
 * transaction precedent at `src/ingest/archived.ts:66-67`). Every one of these invariants lives
 * HERE, in the service, not only on `scorecardPayloadSchema` — a cross-field check declared on the
 * schema object itself would not survive `src/mcp/tools.ts` spreading `scorecardPayloadSchema.shape`
 * into `match_add`'s `inputShape` (see that file's own comment), so putting it there would protect
 * the CLI and silently skip the MCP surface. On success: `upsertTeamMatch` for the parent —
 * MANDATORY, since `upsertCourtMatch`'s id-less branch dedupes on `(slot, playedOn, teamMatchId)`
 * (`upsert.ts:302-334`); without a parent, two different same-day courts at the same slot would
 * silently collapse into one row — then one `upsertCourtMatch` + `upsertCourtMatchPlayers` per
 * court, the LATTER now preceded by a delete of that one court's stale participants (Codex
 * adversarial review of PR #54 round 2, High finding A — a re-ingested correction is a COMPLETE
 * REPLACEMENT for every court it names, never a merge with what was there before; see the delete
 * call itself for why `upsertCourtMatchPlayers`'s own "never deletes" contract is untouched). Both
 * writers are the id-less branch: a screenshot carries no `mid=` TennisRecord id.
 *
 * On the recurring shape (three rounds now: within a court, across courts in one payload, across
 * CALLS for the same court): for `court_match_players` specifically, its write key is
 * `(court_match_id, player_id)`, and every route to a colliding write on that table now goes
 * through either the within-court dedup check above or the delete-before-insert here — I don't see
 * a further axis for THIS table. That is not a claim about `team_matches`/`court_matches` beyond
 * what was already swept in the prior round, and not a claim that a future presenter writing to
 * this table some other way couldn't reopen it.
 */
export function addMatchFromScorecard(db: Db, payload: ScorecardPayload): AddMatchFromScorecardResult {
  try {
    return db.transaction((tx) => {
      // PR #54 verify finding 2: the schema requires only a non-empty `slot` — never distinctness —
      // and `upsertCourtMatch`'s id-less write key is `(slot, playedOn, teamMatchId)`. WITHIN one
      // payload every court shares the same `playedOn` and the same freshly-resolved `teamMatchId`,
      // so `slot` alone is the only discriminator across courts here; two schema-valid courts
      // sharing a slot would otherwise silently collapse — the second `upsertCourtMatch` call
      // UPDATES the first court's row, and `upsertCourtMatchPlayers` only ever ADDS participants,
      // never removes, leaving one row with every player from BOTH courts and the SECOND court's
      // score, no refusal anywhere. Checked first, before any DB lookup: it is pure payload-shape
      // analysis, so there is no reason to spend a team/player resolution query on a payload that is
      // already structurally broken.
      const slotCounts = new Map<string, number>();
      for (const court of payload.courts) slotCounts.set(court.slot, (slotCounts.get(court.slot) ?? 0) + 1);
      const duplicateSlots = Array.from(slotCounts.entries())
        .filter(([, count]) => count > 1)
        .map(([slot]) => slot);
      if (duplicateSlots.length > 0) throw new DuplicateSlotsRefusal(duplicateSlots);

      const homeTeam = requireTeam(tx, payload.homeTeam);
      const visitingTeam = requireTeam(tx, payload.visitingTeam);

      // Compared by resolved ID, not by the two input strings — two spellings or an alias of the
      // SAME team must refuse just as readily as an identical string would (PR #54 finding 2).
      if (homeTeam.id === visitingTeam.id) throw new SameTeamRefusal(homeTeam.name);

      let eventId: number | null = null;
      if (payload.event !== undefined) {
        const eventRow = tx.select().from(events).where(eq(events.name, payload.event)).all()[0];
        if (eventRow === undefined) throw new UnknownEventRefusal(payload.event);
        eventId = eventRow.id;
      }

      // Every (teamId, name) pair across every court, deduplicated — a player appearing at more
      // than one court (a rare doubles-and-singles day) is resolved once, not once per occurrence.
      const pairs = new Map<string, { name: string; teamId: number }>();
      for (const court of payload.courts) {
        for (const name of court.homePlayers) pairs.set(`${homeTeam.id}:${name}`, { name, teamId: homeTeam.id });
        for (const name of court.visitingPlayers) {
          pairs.set(`${visitingTeam.id}:${name}`, { name, teamId: visitingTeam.id });
        }
      }

      const resolvedPlayerIds = new Map<string, number>();
      const flags: MatchAddPlayerFlag[] = [];
      for (const [key, { name, teamId }] of pairs) {
        const resolution = resolveRosterPlayer(tx, { name, teamId, eventId });
        if (resolution.kind === "matched") {
          resolvedPlayerIds.set(key, resolution.row.id);
        } else if (resolution.kind === "off-roster") {
          // The id/name resolved to a REAL player — just not one on THIS team's roster (Codex
          // adversarial review of PR #54, High finding 1). Named distinctly from a true miss, and
          // carries the player it actually found so the refusal message can say who and why.
          flags.push({ name, reason: "off-roster", candidates: [resolution.row.canonicalName] });
        } else {
          flags.push({
            name,
            reason: resolution.kind,
            candidates: resolution.candidates.map((c) => c.canonicalName),
          });
        }
      }
      // Collected ALL flags above before refusing, so one round trip reports every bad name rather
      // than the first (Task 3) — never thrown inline inside the resolution loop.
      if (flags.length > 0) throw new UnresolvedPlayersRefusal(flags);

      // PR #54 verify findings 1a-1d: `upsertCourtMatchPlayers` conflicts on `(court_match_id,
      // player_id)` and updates `side` in place on a repeat — so writing the SAME resolved player
      // twice for one court (either side, or split across both) would silently leave ONE
      // participant row where the schema's cardinality check just promised two. Grouped by
      // RESOLVED playerId, never by the input name string, because none of the four ways a
      // duplicate actually arrives (an identical string repeated, two names sharing an alias, a
      // `usta:` id duplicating a bare name, or the same player rostered on both teams per #49) are
      // distinguishable from each other, or from a genuine two-distinct-player court, by comparing
      // strings — only the id two different lookups resolved to tells them apart.
      const duplicates: MatchAddDuplicatePlayerFlag[] = [];
      for (const court of payload.courts) {
        const occurrencesByPlayerId = new Map<number, MatchAddDuplicateOccurrence[]>();
        const sides: { side: "home" | "visiting"; teamId: number; names: string[] }[] = [
          { side: "home", teamId: homeTeam.id, names: court.homePlayers },
          { side: "visiting", teamId: visitingTeam.id, names: court.visitingPlayers },
        ];
        for (const { side, teamId, names } of sides) {
          for (const name of names) {
            // Safe: every name here was resolved above, and the `flags.length > 0` throw already
            // returned for any resolution that was not `matched`.
            const playerId = resolvedPlayerIds.get(`${teamId}:${name}`)!;
            const occurrences = occurrencesByPlayerId.get(playerId) ?? [];
            occurrences.push({ side, name });
            occurrencesByPlayerId.set(playerId, occurrences);
          }
        }
        for (const [playerId, occurrences] of occurrencesByPlayerId) {
          if (occurrences.length > 1) duplicates.push({ slot: court.slot, playerId, occurrences });
        }
      }
      // Collected across EVERY court before refusing, same "one round trip reports everything"
      // rule as the player-name flags above.
      if (duplicates.length > 0) throw new DuplicatePlayersRefusal(duplicates);

      const teamMatch = upsertLenientTeamMatchForScorecard(tx, {
        eventId,
        homeTeamId: homeTeam.id,
        visitingTeamId: visitingTeam.id,
        playedOn: payload.playedOn,
        scheduledTime: payload.scheduledTime ?? null,
        site: payload.site ?? null,
      });

      for (const court of payload.courts) {
        const courtMatch = upsertCourtMatch(tx, {
          teamMatchId: teamMatch.id,
          slot: court.slot,
          discipline: court.discipline,
          winnerSide: court.winnerSide ?? null,
          score: court.score ?? null,
          leagueContext: null,
          playedOn: payload.playedOn,
          sourceMatchId: null,
        });

        // A scorecard payload is a COMPLETE REPLACEMENT for every court it names (Codex adversarial
        // review of PR #54 round 2, High finding A). `upsertCourtMatch`'s id-less branch reuses this
        // SAME court row on a re-ingest/correction, but `upsertCourtMatchPlayers` deliberately never
        // deletes (docs/findings.md #15) — that invariant is for `src/ingest/player-pull.ts`'s own
        // re-pull path (whose `derive.ts` consumer is written to tolerate a variable participant
        // count for exactly that reason) and stays untouched HERE too: this does not change
        // `upsertCourtMatchPlayers` itself. Instead this service clears the stale rows for THIS ONE
        // court, immediately before writing the fresh set the current payload actually names, so a
        // corrected extraction (the runbook's whole loop: photo → payload → fix a misread name →
        // re-submit) can retract a superseded, roster-valid-but-wrong participant instead of
        // accumulating them forever. Scoped to `courtMatch.id` alone: a court this payload does NOT
        // name is never reached by this loop at all, so "the payload omitted this court" (leave it
        // alone) is never conflated with "the payload said this court now has zero participants"
        // (which would be a different claim this code does not make).
        tx.delete(courtMatchPlayers).where(eq(courtMatchPlayers.courtMatchId, courtMatch.id)).run();

        for (const name of court.homePlayers) {
          // Safe: every name in `pairs` was resolved above, and the `flags.length > 0` throw
          // already returned for any resolution that was not `matched`.
          const playerId = resolvedPlayerIds.get(`${homeTeam.id}:${name}`)!;
          upsertCourtMatchPlayers(tx, { courtMatchId: courtMatch.id, playerId, side: "home" });
        }
        for (const name of court.visitingPlayers) {
          const playerId = resolvedPlayerIds.get(`${visitingTeam.id}:${name}`)!;
          upsertCourtMatchPlayers(tx, { courtMatchId: courtMatch.id, playerId, side: "visiting" });
        }
      }

      return { ok: true, teamMatchId: teamMatch.id, courts: payload.courts.length };
    });
  } catch (err) {
    if (err instanceof UnknownTeamRefusal) {
      return { ok: false, kind: "unknown-team", team: err.team, candidates: err.candidates };
    }
    if (err instanceof UnknownEventRefusal) return { ok: false, kind: "unknown-event", event: err.event };
    if (err instanceof UnresolvedPlayersRefusal) return { ok: false, kind: "unresolved-players", flags: err.flags };
    if (err instanceof SameTeamRefusal) return { ok: false, kind: "same-team", team: err.team };
    if (err instanceof DuplicatePlayersRefusal) {
      return { ok: false, kind: "duplicate-players", duplicates: err.duplicates };
    }
    if (err instanceof DuplicateSlotsRefusal) return { ok: false, kind: "duplicate-slots", slots: err.slots };
    if (err instanceof AmbiguousParentMatchRefusal) {
      return { ok: false, kind: "ambiguous-parent-match", candidates: err.candidates };
    }
    if (err instanceof ConflictingParentEventRefusal) {
      return {
        ok: false,
        kind: "conflicting-parent-event",
        teamMatchId: err.teamMatchId,
        existingEventId: err.existingEventId,
        incomingEventId: err.incomingEventId,
      };
    }
    throw err;
  }
}

/** One human-readable line for any `AddMatchFromScorecardResult` failure — shared by the CLI
 * command and the MCP tool so the two surfaces cannot drift on refusal wording either. */
export function describeMatchAddRefusal(result: Extract<AddMatchFromScorecardResult, { ok: false }>): string {
  if (result.kind === "unknown-team") {
    return result.candidates.length > 0
      ? `ambiguous team "${result.team}": ${result.candidates.join(", ")}`
      : `unknown team "${result.team}"`;
  }
  if (result.kind === "unknown-event") return `unknown event "${result.event}"`;
  if (result.kind === "same-team") {
    return `homeTeam and visitingTeam both resolve to the same team ("${result.team}") — a team cannot play itself`;
  }
  if (result.kind === "duplicate-players") {
    return `duplicate participant(s): ${result.duplicates
      .map(
        (d) =>
          `court "${d.slot}": the same player (id ${d.playerId}) listed as ${d.occurrences
            .map((o) => `${o.side}:"${o.name}"`)
            .join(" and ")}`,
      )
      .join("; ")}`;
  }
  if (result.kind === "duplicate-slots") {
    return `duplicate court slot(s) in one payload: ${result.slots.join(", ")}`;
  }
  if (result.kind === "ambiguous-parent-match") {
    return `ambiguous parent match — ${result.candidates.length} existing team matches are each compatible: ${result.candidates
      .map((c) => `id ${c.teamMatchId} (scheduledTime=${c.scheduledTime ?? "blank"}, site=${c.site ?? "blank"})`)
      .join("; ")} — supply the missing scheduledTime/site to disambiguate`;
  }
  if (result.kind === "conflicting-parent-event") {
    return `conflicting event for existing team match id ${result.teamMatchId}: stored event id ${result.existingEventId} vs incoming event id ${result.incomingEventId} — supply the same event, or omit it, rather than a different one`;
  }
  return `unresolved player name(s): ${result.flags
    .map((f) => {
      if (f.reason === "ambiguous") return `"${f.name}" ambiguous (${f.candidates.join(", ")})`;
      if (f.reason === "off-roster") {
        return `"${f.name}" resolved to ${f.candidates[0]}, who is not on this team's roster`;
      }
      return `"${f.name}" unresolved`;
    })
    .join("; ")}`;
}

const DEFAULT_SCORECARD_PHOTOS_DIR = "scorecard-photos";

/**
 * Mirrors `dbPath()`/`rawRoot()`/`reportsRoot()`: an explicit env var when set, a repo-relative
 * default otherwise — no new flag, matching the existing `TN_DB_PATH`/`TN_RAW_PATH`/
 * `TN_REPORTS_PATH` idiom. Deliberately NOT named "intake" anywhere in this: that word already
 * names the Generic Baseline's own Intake Pipeline (Watchlist voices, `scout`/`clip` — see
 * AGENTS.md), an unrelated subsystem, and reusing it here for "where scorecard photos wait to be
 * read" would be exactly the kind of same-word-different-meaning collision that idiom already
 * warns against.
 */
export function scorecardPhotosRoot(): string {
  return process.env.TN_SCORECARD_PHOTOS_PATH ?? DEFAULT_SCORECARD_PHOTOS_DIR;
}

/**
 * A generous ceiling for a single phone photo (even an uncompressed, high-resolution one) while
 * still bounding what `archiveScorecardImage` will read wholesale into memory and copy — the
 * concrete defense against a `sourceImage` naming an arbitrarily large file (Codex adversarial
 * review, rated Critical).
 */
export const MAX_SCORECARD_IMAGE_BYTES = 25 * 1024 * 1024;

/** Extension allow-list — belt to the magic-byte sniff's suspenders below, never a substitute for
 * it: an extension is just a string the payload supplies and proves nothing about the bytes
 * actually on disk. JPEG and PNG only; HEIC/WEBP are a stated, deliberate gap (docs/findings.md),
 * not a silent omission. */
const ALLOWED_SCORECARD_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Sniffs the actual bytes rather than trusting the extension (Codex adversarial review, rated
 * Critical): a `.png`-named file whose content is not real image bytes must still refuse. JPEG's
 * signature is its first 3 bytes (`FF D8 FF`); PNG's is the full 8-byte magic number above.
 */
function looksLikeSupportedImage(body: Buffer): boolean {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return true;
  if (body.length >= PNG_SIGNATURE.length && body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return true;
  return false;
}

/** Every reason `archiveScorecardImage` refuses a `sourceImage` — a bad path (see
 * `assertInputPathSafe`), an oversized file, an extension outside the allow-list, or content that
 * does not sniff as a supported image regardless of what the extension claims. */
export class ScorecardImageValidationError extends Error {}

/**
 * Archives a scorecard photo exactly like every other raw capture (Task 4/5/6, #18), into the same
 * `raw/` substrate, so a re-parse or a dispute has the original bytes on file. Shared by the CLI
 * command and the MCP tool so the two surfaces cannot drift (mirrors `addMatchFromScorecard` itself,
 * called identically by both).
 *
 * `sourceImagePath` is caller-supplied — over MCP, an agent's own claim about where it saved a
 * photo — and, before this fix, was `readFileSync`'d with NO validation at all: a syntactically
 * valid payload naming `/Users/x/.ssh/id_rsa` or `/etc/hosts` was read and persisted into
 * `raw/scorecard/` regardless of what the rest of the payload said (Codex adversarial review, rated
 * CRITICAL — raised from the reviewer's own High under PROJECT.md's Review Severity Framework,
 * "security hole" ⇒ Critical). Four checks now run, in order, before a single byte of CONTENT is
 * read: containment (`assertInputPathSafe` — the same real-path/symlink-safe primitive
 * `assertOutputPathSafe` uses on the write side, generalized rather than re-hand-rolled), size (via
 * `statSync`, BEFORE reading — an oversized file is refused without ever being loaded into memory),
 * extension (an allow-list — cheap, and never trusted alone), and content (a magic-byte sniff of
 * the bytes actually on disk, independent of what the extension claims). Returns the archived path.
 *
 * Ordering note: this function does not know whether the surrounding ingest will succeed — that is
 * `addMatchFromScorecardWithArchive`'s job (below), which is what both presenters actually call now.
 */
export function archiveScorecardImage(sourceImagePath: string): string {
  const resolvedPath = assertInputPathSafe(sourceImagePath, scorecardPhotosRoot());

  const size = statSync(resolvedPath).size;
  if (size > MAX_SCORECARD_IMAGE_BYTES) {
    throw new ScorecardImageValidationError(
      `refusing to archive "${sourceImagePath}": ${size} bytes exceeds the ${MAX_SCORECARD_IMAGE_BYTES}-byte limit`,
    );
  }

  const extension = extname(resolvedPath);
  if (!ALLOWED_SCORECARD_IMAGE_EXTENSIONS.has(extension.toLowerCase())) {
    throw new ScorecardImageValidationError(
      `refusing to archive "${sourceImagePath}": "${extension || "(no extension)"}" is not a supported scorecard image type`,
    );
  }

  const body = readFileSync(resolvedPath);
  if (!looksLikeSupportedImage(body)) {
    throw new ScorecardImageValidationError(
      `refusing to archive "${sourceImagePath}": its content does not match a supported image format (the extension alone is not trusted)`,
    );
  }

  return archivePage({
    sourceSet: "scorecard",
    slug: slugFromUrl(sourceImagePath),
    url: sourceImagePath,
    body,
    httpStatus: 200,
    extension: extension === "" ? undefined : extension,
  });
}

/** What both presenters need from one combined call: the service outcome, plus whatever happened
 * with the photo. `archivedPath` and `archiveError` are mutually exclusive — set only when
 * `serviceResult.ok` is true AND `sourceImage` was supplied. */
export type MatchAddWithArchiveOutcome = {
  serviceResult: AddMatchFromScorecardResult;
  archivedPath?: string;
  archiveError?: string;
};

/**
 * Both presenters (`tn match add`, `match_add`) need the SAME two steps in the SAME order, so this
 * is the one place that order lives, rather than being duplicated (and risking drift) in each.
 *
 * Order, and why (Codex adversarial review, rated Critical — raised from the reviewer's own High):
 * archiving used to run BEFORE `addMatchFromScorecard`, so a payload that named a real, readable,
 * validly-imaged `sourceImage` but then refused for an unrelated reason (an unknown team, an
 * unresolved player) still persisted the photo — "a refused ingest must persist nothing" did not
 * hold for it. Archiving now runs AFTER the service call, and only when it succeeded.
 *
 * The interaction this reorder creates, stated rather than left implicit (per review): the database
 * write can no longer share a single failure boundary with the archive step, because by the time
 * archiving runs, the write has ALREADY COMMITTED. If `archiveScorecardImage` then throws — a bad
 * path, an oversized or non-image file, anything — there is no transaction left to roll back into;
 * the match rows exist whether or not the photo does. Two shapes were available: surface that as an
 * opaque thrown error (the caller sees only "failed", loses the fact that `teamMatchId` already
 * exists, and might reasonably conclude a retry is required to record the match at all), or report
 * the outcome exactly as it happened — a successful ingest, PLUS a named archive failure. This
 * function takes the second: `serviceResult` is exactly what `addMatchFromScorecard` returned
 * (including `ok: true`), and a post-commit archive failure is surfaced as `archiveError` alongside
 * it, never swallowed and never inflated into an overall failure — mirroring the existing
 * `TeamPullResult` shape, whose `ok` variant already carries `skippedRosterEntries` (an imperfect
 * detail WITHIN an overall-successful pull, `status=partial` at the CLI, never `status=error`)
 * rather than converting it into an unrelated failure. A caller that fixes the path (or drops
 * `sourceImage` entirely) and re-runs the identical payload is safe either way: the ingest is
 * idempotent on `(playedOn, the team pair, slot)`, so the retry updates/no-ops the existing match
 * rather than creating a second one.
 */
export function addMatchFromScorecardWithArchive(db: Db, payload: ScorecardPayload): MatchAddWithArchiveOutcome {
  const serviceResult = addMatchFromScorecard(db, payload);
  if (!serviceResult.ok || payload.sourceImage === undefined) return { serviceResult };
  try {
    return { serviceResult, archivedPath: archiveScorecardImage(payload.sourceImage) };
  } catch (err) {
    return { serviceResult, archiveError: err instanceof Error ? err.message : String(err) };
  }
}
