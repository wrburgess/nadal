import { z } from "zod";

/**
 * Where a parsed page came from. Passed in rather than inferred, because some source ids exist
 * ONLY in the URL: a USTA profile is served from `profile.html#uaid=<id>` and the uaid appears
 * nowhere in the document body. A parser that had to dig it out of an analytics payload would be
 * reading a field that can be removed without notice; the URL cannot.
 */
export const sourceRefSchema = z.object({
  url: z.string().min(1),
  fetchedAt: z.string().min(1),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * A page did not have the shape the parser requires.
 *
 * This is deliberately distinct from an absent optional field. "This player has no singles WTN"
 * is a fact about the player and returns `null`; "the match table is gone" is a fact about the
 * SITE, and every downstream pull would otherwise write zero rows and report success. courtgrab2
 * returned `""` for both, which is how a scouting sheet goes stale without anyone noticing.
 */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly selector: string,
    readonly url?: string,
  ) {
    super(`${message} (selector: ${selector}${url === undefined ? "" : `, url: ${url}`})`);
    this.name = "ParseError";
  }
}

/** NTRP rating type letter — Computer, Self, Appeal, Dynamic-disqualified, Mixed (spec § Deliverables). */
export const ntrpRatingTypeSchema = z.enum(["C", "S", "A", "D", "M", "T", "B", "E", "P"]);

/**
 * A dated, source-attributed rating. `source` and `ratingType` mirror `rating_observations` in
 * `src/db/schema.ts` so Phase 3 writes the record through without translating it.
 */
export const ratingObservationSchema = z.object({
  source: z.enum(["ntrp", "wtn_singles", "wtn_doubles", "tr_dynamic"]),
  value: z.number(),
  ratingType: z.union([ntrpRatingTypeSchema, z.null()]),
  observedOn: z.string(),
});
export type RatingObservation = z.infer<typeof ratingObservationSchema>;

/**
 * A person named on a page, exactly as the page spelled them.
 *
 * Names are NOT normalized here. `PATRICK TURNER` stays `PATRICK TURNER`: spec § Ingestion puts
 * identity resolution at ingest — source ids first, alias table second, fuzzy match with HC
 * confirmation third, never a silent merge — so a parser that quietly title-cased names would be
 * making the first half of that decision where nobody can see it.
 */
export const playerRefSchema = z.object({
  name: z.string().min(1),
  dynamicRating: z.union([z.number(), z.null()]),
});
export type PlayerRef = z.infer<typeof playerRefSchema>;

/** One set. `matchTiebreak` marks the 10-point tiebreak a third set is replaced by (`1-0`). */
export const setScoreSchema = z.object({
  games: z.tuple([z.number().int(), z.number().int()]),
  matchTiebreak: z.boolean(),
});
export type SetScore = z.infer<typeof setScoreSchema>;

/**
 * One court of one team match, from the perspective of the player whose history was parsed.
 * Field names track `court_matches` / `court_match_players` in `src/db/schema.ts`.
 */
export const courtMatchRecordSchema = z.object({
  playedOn: z.string(),
  leagueContext: z.string(),
  teamName: z.string(),
  teamSection: z.union([z.string(), z.null()]),
  opponentTeamName: z.union([z.string(), z.null()]),
  opponentTeamSection: z.union([z.string(), z.null()]),
  slot: z.string(),
  discipline: z.enum(["singles", "doubles"]),
  partner: z.union([playerRefSchema, z.null()]),
  opponents: z.array(playerRefSchema),
  result: z.enum(["W", "L"]),
  sets: z.array(setScoreSchema),
  defaulted: z.boolean(),
  matchRating: z.union([z.number(), z.null()]),
  selfRated: z.boolean(),
  resultingRating: z.union([z.number(), z.null()]),
  sourceMatchId: z.union([z.string(), z.null()]),
});
export type CourtMatchRecord = z.infer<typeof courtMatchRecordSchema>;

/** The identity + ratings block TennisRecord repeats at the top of every one of its player pages. */
export const tennisRecordHeaderSchema = z.object({
  name: z.string().min(1),
  location: z.union([z.string(), z.null()]),
  gender: z.union([z.enum(["Male", "Female"]), z.null()]),
  ntrp: z.union([ratingObservationSchema, z.null()]),
  dynamicRating: z.union([ratingObservationSchema, z.null()]),
  projectedYearEndRating: z.union([z.number(), z.null()]),
});
export type TennisRecordHeader = z.infer<typeof tennisRecordHeaderSchema>;

/** A team a player has appeared for, from the "Recent Team" table on a TennisRecord profile. */
export const recentTeamSchema = z.object({
  teamName: z.string().min(1),
  leagueType: z.union([z.string(), z.null()]),
  section: z.union([z.string(), z.null()]),
  gender: z.union([z.string(), z.null()]),
  ratingLevel: z.union([z.string(), z.null()]),
  matchStartOn: z.union([z.string(), z.null()]),
});
export type RecentTeam = z.infer<typeof recentTeamSchema>;

/** One row of the per-year win/loss aggregate table. `year` is `"Total"` on the totals row. */
export const seasonRecordSchema = z.object({
  year: z.string(),
  matches: z.object({ total: z.number(), wins: z.number(), losses: z.number() }),
  sets: z.object({ total: z.number(), wins: z.number(), losses: z.number() }),
  games: z.object({ total: z.number(), wins: z.number(), losses: z.number() }),
  defaults: z.number(),
});
export type SeasonRecord = z.infer<typeof seasonRecordSchema>;

export const tennisRecordProfileSchema = z.object({
  header: tennisRecordHeaderSchema,
  playingAreas: z.array(z.string()),
  recentTeams: z.array(recentTeamSchema),
  seasonRecords: z.array(seasonRecordSchema),
});
export type TennisRecordProfile = z.infer<typeof tennisRecordProfileSchema>;

export const winLossSchema = z.object({ wins: z.number().int(), losses: z.number().int() });
export type WinLoss = z.infer<typeof winLossSchema>;

export const teamRosterEntrySchema = z.object({
  name: z.string().min(1),
  location: z.union([z.string(), z.null()]),
  ntrp: z.union([z.number(), z.null()]),
  seasonRecord: z.union([winLossSchema, z.null()]),
  localSingles: z.union([winLossSchema, z.null()]),
  localDoubles: z.union([winLossSchema, z.null()]),
  localRecord: z.union([winLossSchema, z.null()]),
  dynamicRating: z.union([z.number(), z.null()]),
});
export type TeamRosterEntry = z.infer<typeof teamRosterEntrySchema>;

export const tennisRecordTeamSchema = z.object({
  teamName: z.string().min(1),
  leagueType: z.union([z.string(), z.null()]),
  section: z.union([z.string(), z.null()]),
  gender: z.union([z.string(), z.null()]),
  ratingLevel: z.union([z.string(), z.null()]),
  seasonName: z.union([z.string(), z.null()]),
  roster: z.array(teamRosterEntrySchema),
});
export type TennisRecordTeam = z.infer<typeof tennisRecordTeamSchema>;

/** A player's USTA profile: the identity + NTRP half of the page (the WTN half is `wtn/widget`). */
export const ustaProfileSchema = z.object({
  name: z.string().min(1),
  uaid: z.string().min(1),
  gender: z.union([z.string(), z.null()]),
  location: z.union([z.string(), z.null()]),
  section: z.union([z.string(), z.null()]),
  district: z.union([z.string(), z.null()]),
  wtnTennisId: z.union([z.string(), z.null()]),
  ntrp: z.union([ratingObservationSchema, z.null()]),
});
export type UstaProfile = z.infer<typeof ustaProfileSchema>;

/** One half of the WTN widget. `zone` is the "GAME ZONE 30.87 TO 27.40" band the widget prints. */
export const wtnRatingSchema = z.object({
  value: z.number(),
  confidence: z.union([z.string(), z.null()]),
  zone: z.union([z.object({ from: z.number(), to: z.number() }), z.null()]),
});
export type WtnRating = z.infer<typeof wtnRatingSchema>;

export const wtnProfileSchema = z.object({
  tennisId: z.union([z.string(), z.null()]),
  singles: z.union([wtnRatingSchema, z.null()]),
  doubles: z.union([wtnRatingSchema, z.null()]),
});
export type WtnProfile = z.infer<typeof wtnProfileSchema>;
