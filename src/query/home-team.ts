// "Our team" designation (nadal ADR 0001: docs/adr/nadal/0001-our-team-is-a-team-level-flag.md).
// This is the ONLY writer of `teams.is_home` — every other reader of the flag (dossier assembly,
// availability, captain notes) goes through `resolveHomeTeam`, never a raw column read, so the
// "at most one home team" invariant has exactly one place that can break it.

import { eq } from "drizzle-orm";
import { teams } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";

type TeamRow = typeof teams.$inferSelect;

/** Thrown by `setHomeTeam` when `teamId` does not name an existing team. `setHomeTeam` never
 * creates a team (that stays `pull`'s job — spec § Ingestion), so an unknown id is a caller error,
 * not an instruction to designate a placeholder. */
export class HomeTeamNotFoundError extends Error {}

/** Thrown by `requireHomeTeam` — shared by every write service that is "our team only, by design"
 * (spec § Domain model: Availability, CaptainNote) — when no home team has been designated at all. */
export class NoHomeTeamError extends Error {}

/** The currently-designated home team, or `null` if none has been set. Never throws on "none
 * designated" — that is the normal state of a fresh database, not an error. */
export function resolveHomeTeam(db: Db): TeamRow | null {
  const row = db.select().from(teams).where(eq(teams.isHome, true)).all()[0];
  return row ?? null;
}

/** Same as `resolveHomeTeam`, but throws `NoHomeTeamError` instead of returning `null` — for a
 * caller (availability, captain notes) that cannot proceed at all without one, so it doesn't have
 * to repeat its own null check and error message at every call site. */
export function requireHomeTeam(db: Db): TeamRow {
  const home = resolveHomeTeam(db);
  if (home === null) {
    throw new NoHomeTeamError("no home team is designated — run `tn team home <name>` first");
  }
  return home;
}

/**
 * Designates `teamId` as the home team, clearing any prior designation first — both in ONE
 * transaction, so `teams.is_home`'s partial unique index (`WHERE is_home = 1`) can never observe
 * two set rows, even transiently (rules/backend.md: "a validation is not a guarantee under
 * concurrency" — the DB constraint is the real guarantee; this transaction is what keeps the
 * application's own writes from ever attempting to violate it).
 *
 * Throws `HomeTeamNotFoundError` — and leaves any prior designation completely untouched, since the
 * whole transaction rolls back — when `teamId` does not exist. Checking existence explicitly rather
 * than relying on the UPDATE's zero-rows-affected outcome matters here: without it, designating a
 * bogus id would silently clear the real home team and set nothing, leaving the database with NO
 * home team at all and no error to say why.
 */
export function setHomeTeam(db: Db, teamId: number): void {
  db.transaction((tx) => {
    const target = tx.select().from(teams).where(eq(teams.id, teamId)).all()[0];
    if (target === undefined) {
      throw new HomeTeamNotFoundError(`setHomeTeam: no team with id ${teamId}`);
    }
    tx.update(teams).set({ isHome: null }).where(eq(teams.isHome, true)).run();
    tx.update(teams).set({ isHome: true }).where(eq(teams.id, teamId)).run();
  });
}
