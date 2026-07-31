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
  reason: "unresolved" | "ambiguous";
  /** Every candidate `resolveRosterPlayer` saw for this name — empty for a true `unresolved` miss. */
  candidates: string[];
};

export type AddMatchFromScorecardResult =
  | { ok: true; teamMatchId: number; courts: number }
  | { ok: false; kind: "unknown-team"; team: string; candidates: string[] }
  | { ok: false; kind: "unknown-event"; event: string }
  | { ok: false; kind: "unresolved-players"; flags: MatchAddPlayerFlag[] };

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
 * Ingests one scorecard payload: resolves both teams and the named event (never-create — see
 * `requireTeam` above), resolves EVERY player on both sides through the roster-scoped, never-create
 * ladder (`resolveRosterPlayer`, Task 2) — and if ANY name is unresolved or ambiguous, collects
 * every flag before refusing, rolling the WHOLE ingest back rather than writing a partial match
 * (mirrors the `AmbiguousIdentityError`-inside-a-transaction precedent at
 * `src/ingest/archived.ts:66-67`). On success: `upsertTeamMatch` for the parent — MANDATORY, since
 * `upsertCourtMatch`'s id-less branch dedupes on `(slot, playedOn, teamMatchId)`
 * (`upsert.ts:302-334`); without a parent, two different same-day courts at the same slot would
 * silently collapse into one row — then one `upsertCourtMatch` + `upsertCourtMatchPlayers` per
 * court. Both writers are the id-less branch: a screenshot carries no `mid=` TennisRecord id.
 */
export function addMatchFromScorecard(db: Db, payload: ScorecardPayload): AddMatchFromScorecardResult {
  try {
    return db.transaction((tx) => {
      const homeTeam = requireTeam(tx, payload.homeTeam);
      const visitingTeam = requireTeam(tx, payload.visitingTeam);

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
  return `unresolved player name(s): ${result.flags
    .map((f) =>
      f.reason === "ambiguous" ? `"${f.name}" ambiguous (${f.candidates.join(", ")})` : `"${f.name}" unresolved`,
    )
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
