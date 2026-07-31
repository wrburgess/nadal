// The scorecard payload contract (Task 1, #18). Spec § Ingestion path 4: extraction runs through
// agent vision, never in-process image decoding (no OCR/image/LLM dependency in this repo — see
// the posted assessment). The agent looks at a photo and produces THIS shape; `tn match add
// <file>` reads the identical shape from a JSON file. One zod schema behind both surfaces is what
// keeps the CLI and the `match_add` MCP tool from silently drifting on what counts as valid.
//
// Player entries (`homePlayers`/`visitingPlayers`) are bare names OR prefix-IDs (`usta:` / `tr:` /
// `wtn:`) — the grammar's existing disambiguation idiom (`resolvePlayerTarget` in
// src/query/player-profile.ts uses the same three prefixes). Validated here as plain non-empty
// strings only: which spelling a name takes is a RESOLUTION concern (Task 2's
// `resolveRosterPlayer`), not a parse-time one — this schema's job is shape, not identity.

import { z } from "zod";
import { isIsoDay } from "../query/iso-day.js";

/** singles ⇒ exactly one player per side, doubles ⇒ exactly two — the cross-field invariant zod's
 * object shape alone does not get for free, enforced below in `superRefine`. */
function expectedPlayerCount(discipline: "singles" | "doubles"): number {
  return discipline === "singles" ? 1 : 2;
}

const scorecardCourtSchema = z
  .object({
    slot: z.string().min(1),
    discipline: z.enum(["singles", "doubles"]),
    homePlayers: z.array(z.string().min(1)),
    visitingPlayers: z.array(z.string().min(1)),
    winnerSide: z.enum(["home", "visiting"]).optional(),
    score: z.string().min(1).optional(),
    /** True when nobody played this court (a walkover/no-show). Relaxes the cardinality invariant
     * below entirely — mirrors the TennisRecord parser's own exemption for the identical case
     * (src/parsers/tennisrecord/match-history.ts: "the participant check enforces cardinality by
     * discipline ... except on an explicit default"). Not persisted: `court_matches` has no column
     * for it, and an empty/short player list plus a null score already says "nobody played" to
     * every downstream reader. */
    defaulted: z.boolean().optional(),
  })
  .superRefine((court, ctx) => {
    if (court.defaulted === true) return;
    const expected = expectedPlayerCount(court.discipline);
    if (court.homePlayers.length !== expected) {
      ctx.addIssue({
        code: "custom",
        message: `court "${court.slot}": ${court.discipline} requires exactly ${expected} home player(s), got ${court.homePlayers.length}`,
        path: ["homePlayers"],
      });
    }
    if (court.visitingPlayers.length !== expected) {
      ctx.addIssue({
        code: "custom",
        message: `court "${court.slot}": ${court.discipline} requires exactly ${expected} visiting player(s), got ${court.visitingPlayers.length}`,
        path: ["visitingPlayers"],
      });
    }
  });

export const scorecardPayloadSchema = z.object({
  /** Name of an existing event to link the parent TeamMatch to — never-create (Task 3); a payload
   * naming no event writes a parent with `event_id` null. */
  event: z.string().min(1).optional(),
  /** ISO date; validated as a REAL calendar date (`isIsoDay`), not merely the `YYYY-MM-DD` pattern —
   * the same rule `addEvent`/`setAvailability` share, since SQLite compares this column lexically. */
  playedOn: z.string().refine(isIsoDay, { message: "playedOn must be a real YYYY-MM-DD calendar date" }),
  homeTeam: z.string().min(1),
  visitingTeam: z.string().min(1),
  scheduledTime: z.string().min(1).optional(),
  site: z.string().min(1).optional(),
  /** A local path to the source photo, archived (Task 4/5/6) before anything else touches it. */
  sourceImage: z.string().min(1).optional(),
  /** At least one court. The slot set is NOT hardcoded to Springfield's four (S1/D1-D3): Tulsa
   * 2025 ran S1 + D1-D4, and a court-slot format is per-event data, never a constant (spec:13). */
  courts: z.array(scorecardCourtSchema).min(1),
});

export type ScorecardCourt = z.infer<typeof scorecardCourtSchema>;
export type ScorecardPayload = z.infer<typeof scorecardPayloadSchema>;
