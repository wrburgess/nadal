// Shared fixture for every test that needs a team carrying BOTH a season roster and, optionally, an
// event-registered subset — exactly the shape `tn roster set` produces and `src/query/roster.ts`'s
// `resolveRoster` (#113) reads. Three ad-hoc local `seedTeamWithRoster` copies already existed
// (test/cli-report-build-command.test.ts, test/cli-team-show-command.test.ts,
// test/report-write.test.ts) and none of them can seed both scopes on one team — which is exactly
// the fixture every reader/writer test #113 adds needs. Modelled on OK/Dickason (20 season, 9
// registered) so the fixture matches the case the issue was filed for, beside
// `test/helpers/home-team.ts`.

import { backfillNameKeys } from "../../src/db/name-key.js";
import { events, players, teamMemberships, teams } from "../../src/db/schema.js";
import type { Db } from "../../src/ingest/db-types.js";

export type SeedTeamWithRostersOptions = {
  teamName: string;
  /** Season-roster player names — one CURRENT (`retired_at IS NULL`) `event_id IS NULL` membership
   * row per name. */
  season: string[];
  /** An optional event-scoped registration on the SAME team. A name already in `season` reuses that
   * player's id rather than minting a second player row — a registration payload names people
   * already on the season roster far more often than not, and reusing the id is what lets a test
   * assert "counted once, not twice" (the resolver's no-union guarantee) without constructing two
   * distinct players who happen to share a name. A name absent from `season` gets its own fresh
   * player, for the "registered but never on the season roster" case. */
  registered?: { eventName: string; names: string[] };
};

export type TeamWithRostersFixture = {
  teamId: number;
  teamName: string;
  /** Every season-roster player's id, by name. */
  seasonPlayerIds: Map<string, number>;
  /** `null` when `options.registered` was omitted. */
  eventId: number | null;
  /** Every registered player's id, by name — empty when `options.registered` was omitted. */
  registeredPlayerIds: Map<string, number>;
};

/**
 * Seeds a team with a season roster and, optionally, an event-scoped registered subset, both via
 * direct inserts — this is a FIXTURE, not the writer under test; `test/ingest-roster-set.test.ts`
 * drives the real `setEventRoster` path instead, so a defect in that path is never masked by this
 * helper reproducing its effect. `backfillNameKeys` runs last, the same reason
 * `seedHomeTeamFixture` (test/helpers/home-team.ts) does: every direct insert here bypasses the real
 * writers that populate `name_key` on the way in, and `resolveRosterPlayer`/`resolveTeamTarget` fail
 * closed (`NameKeyNotBackfilledError`) against an unkeyed row rather than silently missing it.
 */
export function seedTeamWithRosters(db: Db, options: SeedTeamWithRostersOptions): TeamWithRostersFixture {
  const team = db.insert(teams).values({ name: options.teamName }).returning().get();

  const seasonPlayerIds = new Map<string, number>();
  for (const name of options.season) {
    const player = db.insert(players).values({ canonicalName: name }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    seasonPlayerIds.set(name, player.id);
  }

  let eventId: number | null = null;
  const registeredPlayerIds = new Map<string, number>();
  if (options.registered !== undefined) {
    const event = db
      .insert(events)
      .values({ name: options.registered.eventName, kind: "tournament" })
      .returning()
      .get();
    eventId = event.id;
    for (const name of options.registered.names) {
      const existingId = seasonPlayerIds.get(name);
      const playerId = existingId ?? db.insert(players).values({ canonicalName: name }).returning().get().id;
      db.insert(teamMemberships).values({ playerId, teamId: team.id, eventId: event.id }).run();
      registeredPlayerIds.set(name, playerId);
    }
  }

  backfillNameKeys(db);

  return { teamId: team.id, teamName: options.teamName, seasonPlayerIds, eventId, registeredPlayerIds };
}
