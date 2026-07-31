// Captain-note write service (Task 4). Spec § Domain model: CaptainNote is "Randy's subjective
// layer on a player or pairing. Populated for our team only, by design." Unlike availability
// (Task 3, an idempotent upsert), notes are APPEND-ONLY — a journal, not a current-state table —
// so two calls about the same player produce two rows, deliberately, never a merge.

import { and, eq } from "drizzle-orm";
import { captainNotes, teamMemberships } from "../db/schema.js";
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

function isOnHomeRoster(db: Db, playerId: number, homeTeamId: number): boolean {
  return (
    db
      .select({ id: teamMemberships.id })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.playerId, playerId), eq(teamMemberships.teamId, homeTeamId)))
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
