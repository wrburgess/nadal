import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { ambiguousMessage } from "../../ingest/errors.js";
import { resolvePlayerTarget } from "../../query/player-profile.js";
import {
  AmbiguousEventForDayError,
  EventDoesNotCoverDayError,
  InvalidAvailabilityDayError,
  InvalidAvailabilityStatusError,
  NoEventForDayError,
  NoHomeTeamError,
  PlayerNotOnHomeRosterError,
  UnknownEventError,
  setAvailability,
} from "../../query/availability.js";
import { sanitizeValue } from "../../sanitize.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitSummary } from "../emit.js";

/** Every error `setAvailability` can throw for a caller-fixable reason — as opposed to a genuine
 * bug, which should still surface as an uncaught throw rather than a tidy `status=error` line. */
function isAvailabilityRefusal(
  err: unknown,
): err is
  | InvalidAvailabilityStatusError
  | InvalidAvailabilityDayError
  | NoHomeTeamError
  | PlayerNotOnHomeRosterError
  | NoEventForDayError
  | AmbiguousEventForDayError
  | UnknownEventError
  | EventDoesNotCoverDayError {
  return (
    err instanceof InvalidAvailabilityStatusError ||
    err instanceof InvalidAvailabilityDayError ||
    err instanceof NoHomeTeamError ||
    err instanceof PlayerNotOnHomeRosterError ||
    err instanceof NoEventForDayError ||
    err instanceof AmbiguousEventForDayError ||
    err instanceof UnknownEventError ||
    err instanceof EventDoesNotCoverDayError
  );
}

/**
 * `tn player avail <name|usta:…> <YYYY-MM-DD> <status>` (Task 3 decision 2) — payload positionals,
 * no new flags, matching GRAMMAR.md's stated exception list (`team pull`/`player pull` are the ONLY
 * commands with flags beyond the global three). The event is resolved from the day, not passed
 * explicitly; `resolvePlayerTarget` (reused unchanged) never creates a player, so an unknown or
 * ambiguous name refuses exactly like every other command's target resolution.
 *
 * #129: a season-roster player who has not registered for the resolved event still succeeds here —
 * see `setAvailability`'s `onEventRoster` doc comment — but prints an unconditional stderr warning
 * below, since the row will not appear on that event's dossier until they register.
 */
export const playerAvail: Command = {
  noun: "player",
  verb: "avail",
  summary: "Record a home-team player's availability for an event day",
  run: async (args) => {
    // Three payload positionals, the last OPTIONAL: `<day> <status> [event]`. The event name is
    // needed only when the day falls inside more than one event's range, which overlapping league
    // and tournament seasons make ordinary — see `setAvailability`'s `eventName` doc comment.
    const parsed = parsePayloadArgs(args, 3);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player avail", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player avail", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [day, status, eventName] = parsed.payload;
    if (day === undefined || status === undefined) {
      emitSummary(
        "player avail",
        "error",
        [["message", "usage: tn player avail <name> <YYYY-MM-DD> <status> [event]"]],
        opts,
      );
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const resolution = resolvePlayerTarget(db, parsed.target);
      if (resolution.kind === "not-found") {
        emitSummary("player avail", "error", [["message", `unknown target "${parsed.target}"`]], opts);
        return 1;
      }
      if (resolution.kind === "ambiguous") {
        emitSummary(
          "player avail",
          "error",
          [["message", ambiguousMessage({ incoming: parsed.target, candidates: resolution.candidates, context: "player name target" })]],
          opts,
        );
        return 1;
      }

      try {
        const result = setAvailability(db, { playerId: resolution.playerId, day, status, eventName });
        emitSummary(
          "player avail",
          "ok",
          [
            ["player", parsed.target],
            ["day", day],
            ["availability", result.status],
            ["event", result.eventName],
            // #129: "true"/"false" as a STRING field, matching `player distinct`'s `created=` and
            // `player alias`'s `recorded=` — SummaryField has no boolean kind, and this codebase's
            // existing answer to that is `String(bool)`, not widening the type.
            ["onEventRoster", String(result.onEventRoster)],
          ],
          opts,
        );
        // #129: a MISSING SIGNAL, never a refusal — the write above already committed, so this is a
        // warning, not an error. GRAMMAR.md/emit.ts's own contract for `--quiet` is "suppresses the
        // stdout summary line; does not touch stderr" (errors AND warnings, its own wording) — so
        // this prints unconditionally, the same posture `cascadeFailureWarning`'s `console.warn`
        // already takes in `team-pull.ts` for an ok-ish outcome with a caveat.
        if (!result.onEventRoster) {
          console.warn(
            sanitizeValue(
              `player avail: warning: "${parsed.target}" is not registered for "${result.eventName}" — ` +
                `this row will not appear on that event's dossier until they register`,
            ),
          );
        }
        return 0;
      } catch (err) {
        if (!isAvailabilityRefusal(err)) throw err;
        emitSummary("player avail", "error", [["message", err.message]], opts);
        return 1;
      }
    } finally {
      sqlite.close();
    }
  },
};
