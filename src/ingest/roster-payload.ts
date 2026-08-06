// The `tn roster set` payload contract (Task 4, #113). One zod schema shared by both doors — `tn
// roster set <payload.json>` and the `roster_set` MCP tool — exactly as `scorecardPayloadSchema`
// (src/ingest/scorecard.ts) is shared by `tn match add` and `match_add`. The registration page is a
// login-gated screenshot, so the primary door is an agent reading it and calling the MCP tool
// inline; the CLI file path is the re-runnable, auditable fallback.

import { z } from "zod";

export const rosterPayloadSchema = z.object({
  team: z.string().min(1),
  event: z.string().min(1),
  /** Bare names or prefix-IDs (`usta:`/`wtn:`/`tr:`) — the same grammar
   * `scorecardPayloadSchema`'s player fields use; which spelling a name takes is a RESOLUTION
   * concern (`resolveRosterPlayer`), not a parse-time one. At least one: an empty list refuses HERE,
   * at the schema boundary, rather than being treated as "clear the roster" — the HC's ruling is
   * that a hand-supplied list emptying to zero is far more likely a mistake than an intentional
   * "everyone left" (unlike a scraped roster page parsing to zero, which is `team-pull`'s own
   * `retireAbsentMemberships` guard, a different signal this one does not inherit). Clearing an
   * event roster to nothing is not a capability this issue asks for.
   */
  players: z.array(z.string().min(1)).min(1),
});

export type RosterPayload = z.infer<typeof rosterPayloadSchema>;
