// Shared fixture for every test that needs a designated home team plus a minimal roster on an
// event — availability and captain notes (Tasks 3-4) are both "our team only, by design" (spec §
// Domain model), so their write-service tests need a real home team, event, and rostered player
// rather than re-deriving this setup at each call site.

import { events, players, teamMemberships, teams } from "../../src/db/schema.js";
import type { Db } from "../../src/ingest/db-types.js";
import { setHomeTeam } from "../../src/query/home-team.js";

export type HomeTeamFixture = {
  homeTeamId: number;
  homeTeamName: string;
  eventId: number;
  eventStartsOn: string;
  eventEndsOn: string;
  playerId: number;
  playerName: string;
};

export type SeedHomeTeamFixtureOptions = {
  homeTeamName?: string;
  eventName?: string;
  eventStartsOn?: string;
  eventEndsOn?: string;
  playerName?: string;
};

/** Seeds a home team (designated via `setHomeTeam`, the real writer — never a raw `isHome: true`
 * insert), an event with an explicit date range, and one rostered player on that team for that
 * event. Every option has a default so a caller that doesn't care about the exact values can just
 * call `seedHomeTeamFixture(db)`. */
export function seedHomeTeamFixture(db: Db, options: SeedHomeTeamFixtureOptions = {}): HomeTeamFixture {
  const homeTeamName = options.homeTeamName ?? "HOA/Burgess-Zingg/40&over3.5M";
  const eventStartsOn = options.eventStartsOn ?? "2026-08-28";
  const eventEndsOn = options.eventEndsOn ?? "2026-08-30";
  const playerName = options.playerName ?? "Randy Rostered";

  const team = db.insert(teams).values({ name: homeTeamName }).returning().get();
  setHomeTeam(db, team.id);

  const event = db
    .insert(events)
    .values({
      name: options.eventName ?? "Springfield Sectionals 2026",
      kind: "tournament",
      startsOn: eventStartsOn,
      endsOn: eventEndsOn,
    })
    .returning()
    .get();

  const player = db.insert(players).values({ canonicalName: playerName }).returning().get();
  db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: event.id }).run();

  return {
    homeTeamId: team.id,
    homeTeamName,
    eventId: event.id,
    eventStartsOn,
    eventEndsOn,
    playerId: player.id,
    playerName,
  };
}
