// Captain-note write service (Task 4). Spec § Domain model: CaptainNote is "Randy's subjective
// layer on a player or pairing. Populated for our team only, by design." Unlike availability
// (Task 3, an idempotent upsert), notes are APPEND-ONLY — a journal, not a current-state table —
// so two calls about the same player produce two rows, deliberately, never a merge.

import { and, eq, isNull } from "drizzle-orm";
import { captainNotes, players, teamMemberships } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import { requireHomeTeam } from "./home-team.js";

// Re-exported so both write services expose the identical class for the identical refusal —
// captain notes and availability are BOTH "our team only, by design" (spec § Domain model).
export { NoHomeTeamError } from "./home-team.js";

type CaptainNoteRow = typeof captainNotes.$inferSelect;

export class EmptyCaptainNoteError extends Error {}
export class SelfPairingCaptainNoteError extends Error {}
export class PlayerNotOnHomeRosterError extends Error {}

export type AddCaptainNoteInput = {
  playerId: number;
  /** Set = this note is about a PAIRING (playerId + pairPlayerId together), not the player alone. */
  pairPlayerId?: number;
  text: string;
};

// Issue #49: shared by BOTH call sites below (the subject player and the pairing partner) — a
// retired row is not a CURRENT roster row, so a note about (or paired with) someone the last
// successful pull did not see refuses exactly like a note about a stranger, at both call sites at
// once, since both go through this one function.
function isOnHomeRoster(db: Db, playerId: number, homeTeamId: number): boolean {
  return (
    db
      .select({ id: teamMemberships.id })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.playerId, playerId),
          eq(teamMemberships.teamId, homeTeamId),
          isNull(teamMemberships.retiredAt),
        ),
      )
      .all().length > 0
  );
}

/**
 * Appends one captain note. Never upserts — see the module doc comment above; the append-only
 * behavior is what `test/query-captain-notes.test.ts` asserts against availability's own upsert to
 * pin the deliberate difference.
 *
 * Refuses (distinct error class per reason, asserted by class rather than message text): text that
 * is empty or whitespace-only — trimmed BEFORE this guard runs (rules/security.md: "a
 * whitespace-only string still reads as present"), though the text stored is the CALLER'S original,
 * untrimmed — a write service has no business silently mangling arbitrary text on the way to
 * storage, only rejecting what fails its own guard; a pairing note whose pair equals the player
 * themselves; a note about a player (or pairing partner) not on the home team's roster; or no home
 * team designated at all.
 */
export function addCaptainNote(db: Db, input: AddCaptainNoteInput): CaptainNoteRow {
  if (input.text.trim().length === 0) {
    throw new EmptyCaptainNoteError("captain note text may not be empty or whitespace-only");
  }
  if (input.pairPlayerId !== undefined && input.pairPlayerId === input.playerId) {
    throw new SelfPairingCaptainNoteError("a pairing note's pair may not be the player themselves");
  }

  const homeTeam = requireHomeTeam(db);
  if (!isOnHomeRoster(db, input.playerId, homeTeam.id)) {
    throw new PlayerNotOnHomeRosterError(`player ${input.playerId} is not on the home team's roster`);
  }
  if (input.pairPlayerId !== undefined && !isOnHomeRoster(db, input.pairPlayerId, homeTeam.id)) {
    throw new PlayerNotOnHomeRosterError(`player ${input.pairPlayerId} is not on the home team's roster`);
  }

  return db
    .insert(captainNotes)
    .values({
      playerId: input.playerId,
      pairPlayerId: input.pairPlayerId ?? null,
      note: input.text,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export type CaptainNoteEntry = {
  noteId: number;
  playerId: number;
  canonicalName: string;
  note: string;
  createdAt: string;
};

/** A note about two players TOGETHER — never about either one alone. */
export type CaptainPairingNote = CaptainNoteEntry & {
  pairPlayerId: number;
  pairCanonicalName: string;
};

export type CaptainNotesView = {
  player: CaptainNoteEntry[];
  pairing: CaptainPairingNote[];
};

/**
 * Reads back what `addCaptainNote` appended, as content rather than as a count (#126).
 *
 * **Player notes and pairing notes are returned separately**, split on `pair_player_id`. Folding a
 * pairing note into each partner's list would print one observation twice and strip the very thing
 * it records — that these two play well (or badly) *together*, which is a fact about the pair and
 * about neither player alone.
 *
 * Ordering is newest-first on `created_at`, tie-broken by descending id. The tiebreak is not
 * decorative: `addCaptainNote` stamps `created_at` from the wall clock, so two notes appended in the
 * same millisecond carry identical timestamps and would otherwise come back in whatever order SQLite
 * felt like — a journal that reorders itself between reads.
 *
 * Roster scoping matches `getAvailabilityForEvent` and both write services: a non-retired
 * `team_memberships` row for (player, team), any `event_id` (docs/findings.md #15), `retiredAt IS
 * NULL` per issue #49. For a pairing note BOTH partners must be on the roster, mirroring
 * `addCaptainNote`'s own two-call check — a pairing whose partner has since left the team is no
 * longer a pairing this team can field.
 *
 * Unlike the write service this takes an explicit `teamId` rather than calling `requireHomeTeam` —
 * same reason as the availability read: the caller has already resolved it, and a second read of
 * that row is the defect class #97 and #125 closed.
 */
export function getCaptainNotes(db: Db, input: { teamId: number }): CaptainNotesView {
  const roster = db
    .select({ playerId: players.id, canonicalName: players.canonicalName })
    .from(teamMemberships)
    .innerJoin(players, eq(players.id, teamMemberships.playerId))
    .where(and(eq(teamMemberships.teamId, input.teamId), isNull(teamMemberships.retiredAt)))
    .all();
  // One entry per player, not per membership row — a player legitimately holds both a season and an
  // event membership for the same team (docs/findings.md #15).
  const nameOf = new Map<number, string>();
  for (const member of roster) nameOf.set(member.playerId, member.canonicalName);

  const all = db.select().from(captainNotes).all();

  // Newest first, ties broken by descending id so the order is total and stable. Sorting ISO-8601
  // strings lexically is correct here precisely BECAUSE `addCaptainNote` writes
  // `new Date().toISOString()` — fixed-width, UTC, zero-padded. A local-time or offset-bearing
  // stamp would not sort chronologically as text, so this comparison and that writer have to stay
  // together.
  const ordered = [...all].sort((a, b) => (a.createdAt === b.createdAt ? b.id - a.id : b.createdAt < a.createdAt ? -1 : 1));

  const player: CaptainNoteEntry[] = [];
  const pairing: CaptainPairingNote[] = [];

  for (const row of ordered) {
    const canonicalName = nameOf.get(row.playerId);
    if (canonicalName === undefined) continue; // not on this team's current roster

    if (row.pairPlayerId === null) {
      player.push({ noteId: row.id, playerId: row.playerId, canonicalName, note: row.note, createdAt: row.createdAt });
      continue;
    }

    const pairCanonicalName = nameOf.get(row.pairPlayerId);
    // BOTH partners must still be on the roster — see the doc comment above.
    if (pairCanonicalName === undefined) continue;

    pairing.push({
      noteId: row.id,
      playerId: row.playerId,
      canonicalName,
      pairPlayerId: row.pairPlayerId,
      pairCanonicalName,
      note: row.note,
      createdAt: row.createdAt,
    });
  }

  return { player, pairing };
}
