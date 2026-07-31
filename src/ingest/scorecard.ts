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
    // `.trim().toUpperCase()` BEFORE `.min(1)` (Codex adversarial review, PR #54 round 7 rated
    // Medium, extended round 8 also rated Medium): `slot` is a write key — the duplicate-slot count
    // in `src/ingest/match-add.ts` and the id-less court upsert's dedup both compare it by raw
    // equality — so accepting it as any non-empty string let `"D1"`/`"D1 "` (round 7, whitespace)
    // and `"D1"`/`"d1"` (round 8, case) each count as two DIFFERENT courts, evading the
    // duplicate-slot refusal within one payload and creating a second row on a re-ingest correction
    // that changed only whitespace or case. Canonicalized ONCE, here, rather than at each consumer,
    // so every downstream reader (CLI and MCP alike — both parse through this one schema) sees the
    // identical canonical value — the same "one ladder, one notion of a name" shape `nameKey` and
    // `normalizeTimeKey`/`normalizeSiteKey` already close for names and parent-match discriminators.
    // Deliberately NOT a slot grammar (an S/D token allow-list), even though one would also close
    // this: spec:13 states court-slot format is per-event data, never a constant (Tulsa 2025 ran
    // S1+D1-D4 against Springfield's four courts) — canonicalizing the REPRESENTATION of whatever
    // string a court names must not slide into constraining the VOCABULARY of what it may be.
    // Trimming runs before the length check, so a whitespace-only slot (nothing left after trimming)
    // still fails validation rather than silently becoming a court with no real label; case-folding
    // uses `.toUpperCase()` specifically (not a bespoke fold) so the canonical form stays a real,
    // displayable slot label ("D1", not a lowercase or otherwise-transformed variant) — this is
    // storage-key canonicalization, not name-comparison folding, so it need not survive Unicode
    // case-folding edge cases the way `nameKey` does for real people's names.
    slot: z.string().trim().toUpperCase().min(1),
    discipline: z.enum(["singles", "doubles"]),
    homePlayers: z.array(z.string().min(1)),
    visitingPlayers: z.array(z.string().min(1)),
    winnerSide: z.enum(["home", "visiting"]).optional(),
    score: z.string().min(1).optional(),
    /** True when nobody played this court (a walkover/no-show). Replaces the per-discipline COUNT
     * invariant below with a stricter one — both sides must be EMPTY, not merely a different count
     * (Codex adversarial review of PR #54 round 3, High finding 3: the original version returned
     * before checking anything at all, so a schema-valid `defaulted: true` court could still carry
     * a full, roster-valid participant list — a claim of "nobody played" alongside a persisted
     * 3-vs-1 doubles court). Mirrors the TennisRecord parser's own exemption for the identical case
     * (src/parsers/tennisrecord/match-history.ts: "the participant check enforces cardinality by
     * discipline ... except on an explicit default"), but that precedent exempts a default from the
     * COUNT rule, not from having a rule at all. Not persisted: `court_matches` has no column for
     * it, so an empty player list is what tells a downstream reader "nobody played" — a non-empty
     * one would read as an ordinary, incomplete court instead. `winnerSide`/`score` are left
     * unconstrained here deliberately: a walkover still has a winner by rule, and some sources record
     * the score cell as literal text like "Default", so neither field contradicts "nobody played". */
    defaulted: z.boolean().optional(),
  })
  .superRefine((court, ctx) => {
    if (court.defaulted === true) {
      if (court.homePlayers.length !== 0) {
        ctx.addIssue({
          code: "custom",
          message: `court "${court.slot}": a defaulted court must have no home players (nobody played), got ${court.homePlayers.length}`,
          path: ["homePlayers"],
        });
      }
      if (court.visitingPlayers.length !== 0) {
        ctx.addIssue({
          code: "custom",
          message: `court "${court.slot}": a defaulted court must have no visiting players (nobody played), got ${court.visitingPlayers.length}`,
          path: ["visitingPlayers"],
        });
      }
      return;
    }
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
