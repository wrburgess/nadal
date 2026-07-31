// The ingest service for a scorecard payload (Task 3, #18). Both `tn match add` (a JSON file on
// disk) and the `match_add` MCP tool (the agent's inline extraction) call THIS function — the same
// service behind two presenters, so the two surfaces cannot drift on what a valid ingest does.

import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { events, teams } from "../db/schema.js";
import { archivePage } from "./archive.js";
import type { Db } from "./db-types.js";
import { findTeamByName, resolveRosterPlayer } from "./identity.js";
import { slugFromUrl } from "./player-pull.js";
import type { ScorecardPayload } from "./scorecard.js";
import { upsertCourtMatch, upsertCourtMatchPlayers, upsertTeamMatch } from "./upsert.js";

type TeamRow = typeof teams.$inferSelect;

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

export type AddMatchFromScorecardResult =
  | { ok: true; teamMatchId: number; courts: number }
  | { ok: false; kind: "unknown-team"; team: string; candidates: string[] }
  | { ok: false; kind: "unknown-event"; event: string }
  | { ok: false; kind: "unresolved-players"; flags: MatchAddPlayerFlag[] }
  | { ok: false; kind: "same-team"; team: string }
  | { ok: false; kind: "duplicate-players"; duplicates: MatchAddDuplicatePlayerFlag[] }
  | { ok: false; kind: "duplicate-slots"; slots: string[] };

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
 * court. Both writers are the id-less branch: a screenshot carries no `mid=` TennisRecord id.
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

      const teamMatch = upsertTeamMatch(tx, {
        eventId,
        homeTeamId: homeTeam.id,
        visitingTeamId: visitingTeam.id,
        playedOn: payload.playedOn,
        scheduledTime: payload.scheduledTime ?? null,
        site: payload.site ?? null,
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
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

/**
 * Archives a scorecard photo exactly like every other raw capture (Task 4/5/6, #18) — BEFORE
 * anything else touches it, into the same `raw/` substrate, so a re-parse or a dispute has the
 * original bytes on file. Shared by the CLI command and the MCP tool so the two surfaces cannot
 * drift (mirrors `addMatchFromScorecard` itself, called identically by both). Returns the archived
 * path.
 */
export function archiveScorecardImage(sourceImagePath: string): string {
  const body = readFileSync(sourceImagePath);
  const extension = extname(sourceImagePath);
  return archivePage({
    sourceSet: "scorecard",
    slug: slugFromUrl(sourceImagePath),
    url: sourceImagePath,
    body,
    httpStatus: 200,
    extension: extension === "" ? undefined : extension,
  });
}
