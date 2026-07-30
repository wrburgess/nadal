import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  canonicalName: text("canonical_name").notNull(),
  ustaUaid: text("usta_uaid").unique(),
  wtnTennisId: text("wtn_tennis_id").unique(),
  trNameKey: text("tr_name_key"),
  ageRange: text("age_range"),
  gender: text("gender"),
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
});

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
}, (t) => [uniqueIndex("membership_unique").on(t.playerId, t.teamId, t.eventId)]);

export const teamMatches = sqliteTable("team_matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").references(() => events.id),
  homeTeamId: integer("home_team_id").notNull().references(() => teams.id),
  visitingTeamId: integer("visiting_team_id").notNull().references(() => teams.id),
  playedOn: text("played_on"),
  sourceMatchId: text("source_match_id"),         // TennisLink match id when known
  homeCourtsWon: integer("home_courts_won"),
  visitingCourtsWon: integer("visiting_courts_won"),
});

export const courtMatches = sqliteTable("court_matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamMatchId: integer("team_match_id").references(() => teamMatches.id),
  slot: text("slot").notNull(),                   // S1 | D1 | D2 | D3 | D4
  discipline: text("discipline").notNull(),       // singles | doubles
  winnerSide: text("winner_side"),                // home | visiting
  score: text("score"),                           // e.g. "6-3 1-6 1-0"
  leagueContext: text("league_context"),          // source league/flight when outside a known event
  playedOn: text("played_on"),
});

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
  outcome: text("outcome"),                       // ok | error:<class>
});
