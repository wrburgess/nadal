import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  canonicalName: text("canonical_name").notNull(),
  ustaUaid: text("usta_uaid").unique(),
  wtnTennisId: text("wtn_tennis_id").unique(),
  trNameKey: text("tr_name_key"),
  ageRange: text("age_range"),
  gender: text("gender"),
  tennisrecordUrl: text("tennisrecord_url"),       // durable re-pull handle (spec § Ingestion)
});

export const playerAliases = sqliteTable("player_aliases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  alias: text("alias").notNull(),
}, (t) => [uniqueIndex("player_alias_unique").on(t.playerId, t.alias)]);

export const teams = sqliteTable("teams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),          // e.g. IA/Versteeg/40&Over3.5M
  section: text("section"),
  district: text("district"),
  tennislinkUrl: text("tennislink_url"),
  tennisrecordUrl: text("tennisrecord_url"),       // durable re-pull handle (spec § Ingestion)
  // "Our team" designation (nadal ADR 0001) — nullable rather than a plain boolean default-false,
  // so a partial unique index (below) can enforce "at most one true row" at the DATABASE level,
  // not just in application code (rules/backend.md: "a validation is not a guarantee under
  // concurrency"). `src/query/home-team.ts` is the only writer; it always clears any prior flag
  // and sets the new one inside a single transaction, so the index can never observe two set rows.
  isHome: integer("is_home", { mode: "boolean" }),
}, (t) => [uniqueIndex("team_home_unique").on(t.isHome).where(sql`is_home = 1`)]);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),          // e.g. Sectionals 2026 (Springfield)
  kind: text("kind").notNull(),                   // league | tournament
  format: text("format", { mode: "json" }),       // court slots, pools/rr, per spec: format is data
  startsOn: text("starts_on"),
  endsOn: text("ends_on"),
});

export const teamMemberships = sqliteTable("team_memberships", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  teamId: integer("team_id").notNull().references(() => teams.id),
  eventId: integer("event_id").references(() => events.id),
}, (t) => [
  uniqueIndex("membership_unique").on(t.playerId, t.teamId, t.eventId),
  // SQLite treats NULLs as distinct even under a UNIQUE index/constraint, so the 3-column index
  // above fails open when event_id is NULL — the NORMAL path for a roster pulled outside an
  // event, not an edge case. A partial unique index scoped to `event_id IS NULL` closes that gap
  // without changing behavior for the non-NULL (event-scoped) case, which the index above still
  // covers.
  uniqueIndex("membership_unique_no_event").on(t.teamId, t.playerId).where(sql`event_id IS NULL`),
]);

export const teamMatches = sqliteTable("team_matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").references(() => events.id),
  homeTeamId: integer("home_team_id").notNull().references(() => teams.id),
  visitingTeamId: integer("visiting_team_id").notNull().references(() => teams.id),
  playedOn: text("played_on"),
  // Scheduled time + site, carried so an id-less fixture has a discriminator finer than its date.
  // Without them, two same-day fixtures between the same two teams (a doubleheader) collapse into
  // one row and the second is lost undetectably — `played_on` alone is not an identity.
  scheduledTime: text("scheduled_time"),
  site: text("site"),
  sourceMatchId: text("source_match_id"),         // TennisLink/TennisRecord match id when known
  homeCourtsWon: integer("home_courts_won"),
  visitingCourtsWon: integer("visiting_courts_won"),
}, (t) => [
  // `source_match_id` (the `mid=` query param) identifies the TEAM match, so it alone is the
  // idempotency key here. Partial predicate for the same reason as `membership_unique_no_event`:
  // SQLite treats NULLs as distinct under a UNIQUE index, and most team_matches rows outside a
  // TennisRecord pull legitimately have no source_match_id at all.
  uniqueIndex("team_match_source_unique").on(t.sourceMatchId).where(sql`source_match_id IS NOT NULL`),
]);

export const courtMatches = sqliteTable("court_matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamMatchId: integer("team_match_id").references(() => teamMatches.id),
  slot: text("slot").notNull(),                   // S1 | D1 | D2 | D3 | D4
  discipline: text("discipline").notNull(),       // singles | doubles
  winnerSide: text("winner_side"),                // home | visiting
  score: text("score"),                           // e.g. "6-3 1-6 1-0"
  leagueContext: text("league_context"),          // source league/flight when outside a known event
  playedOn: text("played_on"),
  sourceMatchId: text("source_match_id"),         // the `mid=` param identifying the TEAM match;
                                                   // paired with `slot` below, it identifies the court
}, (t) => [
  // The `mid=` id identifies the team match, not the court within it — `slot` completes the pair.
  // Partial predicate: same NULLs-are-distinct reasoning as `membership_unique_no_event` above.
  uniqueIndex("court_match_source_unique")
    .on(t.sourceMatchId, t.slot)
    .where(sql`source_match_id IS NOT NULL`),
]);

export const courtMatchPlayers = sqliteTable("court_match_players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  courtMatchId: integer("court_match_id").notNull().references(() => courtMatches.id),
  playerId: integer("player_id").notNull().references(() => players.id),
  side: text("side").notNull(),                   // home | visiting
}, (t) => [uniqueIndex("court_match_player_unique").on(t.courtMatchId, t.playerId)]);

export const ratingObservations = sqliteTable("rating_observations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  source: text("source").notNull(),               // ntrp | wtn_singles | wtn_doubles | tr_dynamic
  value: real("value").notNull(),
  ratingType: text("rating_type"),                // NTRP: C | S | A | D | M
  observedOn: text("observed_on").notNull(),
}, (t) => [uniqueIndex("rating_obs_unique").on(t.playerId, t.source, t.observedOn)]);

export const availability = sqliteTable("availability", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  eventId: integer("event_id").notNull().references(() => events.id),
  day: text("day").notNull(),                     // ISO date
  status: text("status").notNull(),               // available | unavailable | uncertain
}, (t) => [uniqueIndex("availability_unique").on(t.playerId, t.eventId, t.day)]);

export const captainNotes = sqliteTable("captain_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  pairPlayerId: integer("pair_player_id").references(() => players.id), // set = note about a pairing
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
});

export const requestLog = sqliteTable("request_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  surface: text("surface").notNull(),             // cli | mcp
  command: text("command").notNull(),             // e.g. "player pull"
  args: text("args"),                             // sanitized JSON
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  outcome: text("outcome"),                       // ok | error:<class> | error:exit-<code>
});
