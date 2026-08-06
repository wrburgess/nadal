// The event-scoped roster writer (Task 4, #113). Both `tn roster set <payload.json>` and the
// `roster_set` MCP tool call THIS function — the same service behind two presenters, mirroring
// `addMatchFromScorecard`'s shape (src/ingest/match-add.ts) exactly: a discriminated
// `{ ok: false, kind }` refusal union, one transaction, collect-every-bad-name-before-refusing.
//
// The HC's 2026-08-05 ruling: the registration page is a SNAPSHOT, so this writer REPLACES an
// event's roster on every call rather than accumulating across calls — a player named in a prior
// run but absent from this one is retired (event-scoped only), and a re-added name un-retires
// rather than duplicating (`upsertMembership`'s existing conflict-target behavior, unchanged). That
// replacement is a NEW event-scoped reconcile, not a reuse of `retireAbsentMemberships`
// (src/ingest/upsert.ts): that function is hardcoded `event_id IS NULL` and mutation-tested to stay
// that way (`test/ingest-upsert-membership-retirement.test.ts`), and widening it would let a
// `tn team pull` retire an EVENT roster it never observed.

import { and, eq, isNull, notInArray } from "drizzle-orm";
import { events, teamMemberships, teams } from "../db/schema.js";
import { resolveTeamTarget } from "../query/team-profile.js";
import type { Db } from "./db-types.js";
import { resolveRosterPlayer } from "./identity.js";
import type { RosterPayload } from "./roster-payload.js";
import { upsertMembership } from "./upsert.js";

/** One payload name that did not resolve to a player on the team's roster — mirrors
 * `MatchAddPlayerFlag` (src/ingest/match-add.ts) exactly: the same three ways
 * `resolveRosterPlayer`'s never-create ladder can fail to name a single player. */
export type RosterPlayerFlag = {
  name: string;
  reason: "unresolved" | "ambiguous" | "off-roster";
  candidates: string[];
};

export type SetEventRosterResult =
  | {
      ok: true;
      teamId: number;
      teamName: string;
      eventId: number;
      eventName: string;
      registered: number;
      retired: number;
    }
  | { ok: false; kind: "unknown-team"; team: string; candidates: string[] }
  | { ok: false; kind: "unknown-event"; event: string }
  | { ok: false; kind: "duplicate-names"; names: string[] }
  | { ok: false; kind: "duplicate-players"; duplicates: DuplicateRosterPlayer[] }
  | { ok: false; kind: "unresolved-players"; flags: RosterPlayerFlag[] };

/** Two or more DIFFERENT payload strings that resolved to one person — an alias beside a canonical
 * name, or a prefix-ID beside the name it names. Distinct from `duplicate-names` (the same string
 * twice), which is a pure payload-shape fault needing no database at all: this one is only
 * knowable after resolution, and its message has to name both spellings for the operator to fix. */
export type DuplicateRosterPlayer = { canonicalName: string; names: string[] };

/** Thrown inside the transaction to abort it — better-sqlite3/drizzle roll back automatically on a
 * thrown error, the same `addMatchFromScorecard` precedent. Caught right outside `db.transaction`,
 * below, and translated into the matching `SetEventRosterResult` failure variant. */
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
class DuplicateNamesRefusal extends Error {
  constructor(readonly names: string[]) {
    super(`duplicate name(s) in one payload: ${names.join(", ")}`);
  }
}
class DuplicatePlayersRefusal extends Error {
  constructor(readonly duplicates: DuplicateRosterPlayer[]) {
    super(`one player named more than once: ${duplicates.map((d) => d.canonicalName).join(", ")}`);
  }
}
class UnresolvedPlayersRefusal extends Error {
  constructor(readonly flags: RosterPlayerFlag[]) {
    super(`unresolved player name(s): ${flags.map((f) => f.name).join(", ")}`);
  }
}

/**
 * Retires every non-retired `(team_id, event_id)` membership NOT in `observedPlayerIds` — the
 * event-scoped sibling `retireAbsentMemberships` (src/ingest/upsert.ts) deliberately is NOT (see
 * this module's own header comment). `eq(teamMemberships.eventId, eventId)` alone excludes every
 * season row (`event_id IS NULL`) without a separate `isNotNull` guard, since SQLite's `=` never
 * matches `NULL` — a season roster is therefore untouched by construction, not by a second check.
 *
 * Unlike `retireAbsentMemberships`, an EMPTY `observedPlayerIds` is never special-cased here on
 * purpose: `rosterPayloadSchema`'s `players.min(1)` already refuses an empty payload at the
 * boundary (this module's own header comment explains why that differs from a scraped roster
 * parsing to zero), so every id set this function is called with has at least one member — there is
 * no "maybe everyone genuinely left" signal here for a guard to protect against.
 */
function retireAbsentEventMemberships(
  db: Db,
  options: { teamId: number; eventId: number; observedPlayerIds: number[]; retiredAt: string },
): number {
  const { teamId, eventId, observedPlayerIds, retiredAt } = options;
  const result = db
    .update(teamMemberships)
    .set({ retiredAt })
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.eventId, eventId),
        isNull(teamMemberships.retiredAt),
        notInArray(teamMemberships.playerId, observedPlayerIds),
      ),
    )
    .run();
  return result.changes;
}

/**
 * Sets `payload.team`'s registered roster for `payload.event` to EXACTLY `payload.players`, in one
 * transaction:
 *
 *  1. Resolves the team (`resolveTeamTarget`) and the event (`resolveEvent`) — NEVER creating
 *     either, matching `addMatchFromScorecard`'s identical posture.
 *  2. Refuses a payload naming the same name twice (a pure payload-shape check, run before any DB
 *     lookup — mirrors `addMatchFromScorecard`'s duplicate-slot check for the same reason).
 *  3. Resolves every name via `resolveRosterPlayer(tx, { name, teamId, eventId })` — never-create,
 *     roster-scoped (season-roster scoped: `eventId` stays accepted-and-unused there by design, see
 *     that function's own doc comment) — COLLECTING every unresolved/ambiguous/off-roster name
 *     before refusing, never stopping at the first.
 *  4. `upsertMembership(tx, { playerId, teamId, eventId })` per resolved player — no change to
 *     `upsert.ts`, the 3-column-index branch already exists and already un-retires on conflict.
 *  5. Retires every OTHER non-retired `(team_id, event_id)` membership via
 *     `retireAbsentEventMemberships` above — the HC's "replaces, does not accumulate".
 *
 * Any name-resolution failure, an unknown team, or an unknown event rolls back the WHOLE write —
 * nothing is ever half-registered.
 */
export function setEventRoster(db: Db, payload: RosterPayload): SetEventRosterResult {
  try {
    return db.transaction((tx) => {
      // Structural, payload-shape check FIRST — mirrors `addMatchFromScorecard`'s duplicate-slot
      // check, which is pure payload analysis run before any DB lookup, for the identical reason: a
      // payload this malformed needs no team/event/player resolution to already be refusable.
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const name of payload.players) {
        if (seen.has(name)) duplicates.add(name);
        seen.add(name);
      }
      if (duplicates.size > 0) throw new DuplicateNamesRefusal([...duplicates]);

      const teamResolution = resolveTeamTarget(tx, payload.team);
      if (teamResolution.kind !== "ok") {
        throw new UnknownTeamRefusal(
          payload.team,
          teamResolution.kind === "ambiguous" ? teamResolution.candidates : [],
        );
      }
      const teamId = teamResolution.teamId;

      // The event row read DIRECTLY by name, not through `resolveEvent` — the same lookup
      // `addMatchFromScorecard` does (src/ingest/match-add.ts), for the same reason. Registering a
      // roster needs the event's IDENTITY and nothing else: `resolveEvent` additionally decodes
      // `format` and `leagueScope`, so it throws `InvalidEventFormatError` /
      // `InvalidLeagueScopeError` on a corrupted stored value — two refusal classes this operation
      // has no use for, that no presenter here catches, and that would therefore surface as an
      // uncaught throw rather than a refusal. A corrupt court format is a real problem for
      // `tn lineup plan`; it is none of this writer's business.
      const eventRow = tx.select().from(events).where(eq(events.name, payload.event)).all()[0];
      if (eventRow === undefined) throw new UnknownEventRefusal(payload.event);
      const eventId = eventRow.id;

      // Every name resolved BEFORE anything is written, collecting every failure — the same
      // "one round trip reports everything" discipline `addMatchFromScorecard` uses.
      const resolvedPlayerIds: number[] = [];
      const resolvedRowsById = new Map<number, { canonicalName: string }>();
      const flags: RosterPlayerFlag[] = [];
      for (const name of payload.players) {
        const resolution = resolveRosterPlayer(tx, { name, teamId, eventId });
        if (resolution.kind === "matched") {
          resolvedPlayerIds.push(resolution.row.id);
          resolvedRowsById.set(resolution.row.id, { canonicalName: resolution.row.canonicalName });
        } else if (resolution.kind === "off-roster") {
          // The name resolved to a REAL player — just not one on THIS team's (season) roster.
          flags.push({ name, reason: "off-roster", candidates: [resolution.row.canonicalName] });
        } else {
          flags.push({
            name,
            reason: resolution.kind,
            candidates: resolution.candidates.map((c) => c.canonicalName),
          });
        }
      }
      if (flags.length > 0) throw new UnresolvedPlayersRefusal(flags);

      // Duplicates again, now by RESOLVED ID — the string check above cannot see two DIFFERENT
      // spellings of one person (a canonical name beside an alias, or a prefix-ID beside the name
      // it names), which is exactly what an agent transcribing a registration screenshot produces.
      // `addMatchFromScorecard` compares by resolved id for the identical reason (PR #54 finding
      // 2). Left unchecked the write is still correct in the DATABASE — `upsertMembership` is
      // idempotent, so one person yields one row — but `registered` counts payload entries, so it
      // would report more people than registered. A count that does not describe what happened is
      // the same silent misstatement class the disclosure work in this issue exists to remove.
      const namesByPlayerId = new Map<number, string[]>();
      resolvedPlayerIds.forEach((playerId, index) => {
        const list = namesByPlayerId.get(playerId) ?? [];
        list.push(payload.players[index]!);
        namesByPlayerId.set(playerId, list);
      });
      const duplicatePlayers = [...namesByPlayerId.entries()]
        .filter(([, names]) => names.length > 1)
        .map(([playerId, names]) => ({
          canonicalName: resolvedRowsById.get(playerId)!.canonicalName,
          names,
        }));
      if (duplicatePlayers.length > 0) throw new DuplicatePlayersRefusal(duplicatePlayers);

      for (const playerId of resolvedPlayerIds) {
        upsertMembership(tx, { playerId, teamId, eventId });
      }

      const retiredAt = new Date().toISOString();
      const retired = retireAbsentEventMemberships(tx, {
        teamId,
        eventId,
        observedPlayerIds: resolvedPlayerIds,
        retiredAt,
      });

      const teamRow = tx.select().from(teams).where(eq(teams.id, teamId)).all()[0]!;

      return {
        ok: true,
        teamId,
        teamName: teamRow.name,
        eventId,
        eventName: eventRow.name,
        registered: resolvedPlayerIds.length,
        retired,
      };
    });
  } catch (err) {
    if (err instanceof UnknownTeamRefusal) {
      return { ok: false, kind: "unknown-team", team: err.team, candidates: err.candidates };
    }
    if (err instanceof UnknownEventRefusal) return { ok: false, kind: "unknown-event", event: err.event };
    if (err instanceof DuplicateNamesRefusal) return { ok: false, kind: "duplicate-names", names: err.names };
    if (err instanceof DuplicatePlayersRefusal) {
      return { ok: false, kind: "duplicate-players", duplicates: err.duplicates };
    }
    if (err instanceof UnresolvedPlayersRefusal) {
      return { ok: false, kind: "unresolved-players", flags: err.flags };
    }
    throw err;
  }
}

/** One human-readable line for any `SetEventRosterResult` failure — shared by the CLI command and
 * the MCP tool so the two surfaces cannot drift on refusal wording, mirroring
 * `describeMatchAddRefusal` (src/ingest/match-add.ts). */
export function describeSetEventRosterRefusal(result: Extract<SetEventRosterResult, { ok: false }>): string {
  if (result.kind === "unknown-team") {
    return result.candidates.length > 0
      ? `ambiguous team "${result.team}": ${result.candidates.join(", ")}`
      : `unknown team "${result.team}"`;
  }
  if (result.kind === "unknown-event") return `unknown event "${result.event}"`;
  if (result.kind === "duplicate-names") {
    return `duplicate name(s) in one payload: ${result.names.join(", ")}`;
  }
  if (result.kind === "duplicate-players") {
    return `one player named more than once: ${result.duplicates
      .map((d) => `${d.canonicalName} (as ${d.names.map((n) => `"${n}"`).join(", ")})`)
      .join("; ")}`;
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
