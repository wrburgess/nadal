import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { resolvePlayerTarget } from "../../query/player-profile.js";
import {
  AmbiguousEventForDayError,
  InvalidAvailabilityDayError,
  InvalidAvailabilityStatusError,
  NoEventForDayError,
  NoHomeTeamError,
  PlayerNotOnHomeRosterError,
  setAvailability,
} from "../../query/availability.js";
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
  | AmbiguousEventForDayError {
  return (
    err instanceof InvalidAvailabilityStatusError ||
    err instanceof InvalidAvailabilityDayError ||
    err instanceof NoHomeTeamError ||
    err instanceof PlayerNotOnHomeRosterError ||
    err instanceof NoEventForDayError ||
    err instanceof AmbiguousEventForDayError
  );
}

/**
 * `tn player avail <name|usta:…> <YYYY-MM-DD> <status>` (Task 3 decision 2) — payload positionals,
 * no new flags, matching GRAMMAR.md's stated exception list (`team pull`/`player pull` are the ONLY
 * commands with flags beyond the global three). The event is resolved from the day, not passed
 * explicitly; `resolvePlayerTarget` (reused unchanged) never creates a player, so an unknown or
 * ambiguous name refuses exactly like every other command's target resolution.
 */
export const playerAvail: Command = {
  noun: "player",
  verb: "avail",
  summary: "Record a home-team player's availability for an event day",
  run: async (args) => {
    const parsed = parsePayloadArgs(args, 2);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player avail", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player avail", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [day, status] = parsed.payload;
    if (day === undefined || status === undefined) {
      emitSummary(
        "player avail",
        "error",
        [["message", "usage: tn player avail <name> <YYYY-MM-DD> <status>"]],
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
          [["message", `ambiguous target: ${resolution.candidates.join(", ")}`]],
          opts,
        );
        return 1;
      }

      try {
        const result = setAvailability(db, { playerId: resolution.playerId, day, status });
        emitSummary(
          "player avail",
          "ok",
          [
            ["player", parsed.target],
            ["day", day],
            ["availability", result.status],
            ["event", result.eventName],
          ],
          opts,
        );
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
