import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { ambiguousMessage } from "../../ingest/errors.js";
import {
  AmbiguousEventForDayError,
  EventDoesNotCoverDayError,
  InvalidAvailabilityDayError,
  InvalidAvailabilityStatusError,
  NoEventForDayError,
  // NAME COLLISION, aliased deliberately. `src/query/availability.ts` and `src/query/lineup.ts` BOTH
  // export a class literally named `UnknownEventError`, they are two different classes, and BOTH are
  // reachable from one `getLineupBuild` call — the first when a supplied `[event]` names nothing on
  // file, the second if the resolved event disappears between the day lookup and the resolution.
  // Importing both under one name is not a compile error in any obvious way; it would simply shadow,
  // so the guard below would list one class twice and silently stop recognizing the other. The alias
  // is what makes both real, and `test/cli-lineup-build-command.test.ts` asserts they are distinct
  // classes and that the guard claims each of them.
  UnknownEventError as UnknownEventForDayError,
} from "../../query/availability.js";
import { EmptySlotSetError } from "../../query/derive-lineup-build.js";
import { InvalidEventFormatError } from "../../query/event-format.js";
import { NoHomeTeamError } from "../../query/home-team.js";
import { InvalidLeagueScopeError } from "../../query/league-scope.js";
import { EventHasNoFormatError, UnknownEventError } from "../../query/lineup.js";
import { getLineupBuild } from "../../query/lineup-build.js";
import { InvalidPlaysError } from "../../query/player-plays.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitJson, emitSummary } from "../emit.js";
import { formatLineupBuild } from "../format-lineup-build.js";

/**
 * Every error `getLineupBuild` throws for a CALLER-FIXABLE reason — a bad day, an unnamed or
 * unknown event, a missing home team, a court list or stored column that needs re-recording. Each
 * exits 1 with a diagnostic; anything else is a genuine bug and is rethrown untouched, so it is
 * recorded by class in `request_log` rather than laundered into a tidy `status=error` line that
 * would tell an operator to fix input they cannot fix.
 *
 * Two entries are unreachable through this command today and are listed anyway, since the guard's
 * contract is "every refusal `getLineupBuild` declares", not "every one a fixture can reach":
 * `UnknownEventError` (lineup.ts) needs a concurrent `tn event add`/delete between the day lookup
 * and the resolution, and `EmptySlotSetError` needs a court list `readEventFormat` already refuses
 * to hand back. Both are pinned directly on this function instead.
 */
export function isLineupBuildRefusal(
  err: unknown,
): err is
  | NoHomeTeamError
  | InvalidAvailabilityDayError
  | NoEventForDayError
  | AmbiguousEventForDayError
  | EventDoesNotCoverDayError
  | UnknownEventForDayError
  | InvalidAvailabilityStatusError
  | EventHasNoFormatError
  | UnknownEventError
  | InvalidEventFormatError
  | InvalidLeagueScopeError
  | InvalidPlaysError
  | EmptySlotSetError {
  return (
    err instanceof NoHomeTeamError ||
    err instanceof InvalidAvailabilityDayError ||
    err instanceof NoEventForDayError ||
    err instanceof AmbiguousEventForDayError ||
    err instanceof EventDoesNotCoverDayError ||
    err instanceof UnknownEventForDayError ||
    err instanceof InvalidAvailabilityStatusError ||
    err instanceof EventHasNoFormatError ||
    err instanceof UnknownEventError ||
    err instanceof InvalidEventFormatError ||
    err instanceof InvalidLeagueScopeError ||
    // #149: `readPlays`'s fail-closed throw. Omitted in the first cut, which made two claims false
    // at once — `getLineupBuild`'s own doc comment declaring the class, and GRAMMAR.md's refusal
    // list naming a corrupted `plays` value — while the command actually died uncaught.
    err instanceof InvalidPlaysError ||
    err instanceof EmptySlotSetError
  );
}

/**
 * `tn lineup build <YYYY-MM-DD> [event] [--json]` (#127) — our own lineup for one event day, built
 * from who has said they are available.
 *
 * **The target is the DAY, not a team**, which is the one thing about this grammar worth stating
 * twice. Availability and captain notes are our-team-only by design (spec § Domain model), so the
 * team comes from `requireHomeTeam` and there is deliberately no way to ask this question about an
 * opponent — that question is `tn lineup plan`, which this leaves untouched. Accepting a team target
 * here would have invited "build a lineup for an opponent", which is a different feature wearing
 * this one's name.
 *
 * `[event]` is the optional trailing disambiguator, the identical shape `tn player avail`,
 * `tn lineup plan` and `tn report build` already use: needed only when the day falls inside more
 * than one event's range, and checked AGAINST the day rather than trusted when supplied.
 *
 * No lineup logic lives here. This translates two positionals, calls one service, and shapes the
 * result — the `lineup_build` MCP tool calls the identical service (ARCHITECTURE.md § 5 question 1).
 */
export const lineupBuild: Command = {
  noun: "lineup",
  verb: "build",
  summary: "Build the home team's lineup for an event day from who is available",
  run: async (args) => {
    // One payload positional, OPTIONAL: `<day> [event]`. Same parser, same global flags, no flags of
    // its own — GRAMMAR.md's "payload positionals, no new flags" shape.
    const parsed = parsePayloadArgs(args, 1);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("lineup build", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary(
        "lineup build",
        "error",
        [["message", "missing target — usage: tn lineup build <YYYY-MM-DD> [event]"]],
        opts,
      );
      return 1;
    }
    const [eventName] = parsed.payload;

    const { db, sqlite } = openDb();
    try {
      let build;
      try {
        build = getLineupBuild(db, { day: parsed.target, eventName });
      } catch (err) {
        if (!isLineupBuildRefusal(err)) throw err;
        // An ambiguous day renders through `ambiguousMessage` (src/ingest/errors.ts), the ONE
        // formatter every surface uses, so the three facts #94 requires all reach the operator: the
        // incoming value (the day), where it came from, and what it was near. The error carries its
        // candidates for exactly this — a hand-rolled sentence here would be the regression
        // ARCHITECTURE.md § 5 question 8 asks about.
        const message =
          err instanceof AmbiguousEventForDayError
            ? ambiguousMessage({
                incoming: parsed.target,
                candidates: err.candidates.map((candidate) => candidate.name),
                context: "event for day",
              })
            : err.message;
        emitSummary("lineup build", "error", [["message", message]], opts);
        return 1;
      }

      if (!opts.quiet) {
        // One `console.log`, the same shape every other rendering command uses. `emitJson` sanitizes
        // every string leaf on the way out; `formatLineupBuild` sanitizes each name it interpolates.
        console.log(opts.json ? emitJson(build) : formatLineupBuild(build));
      }
      return 0;
    } finally {
      sqlite.close();
    }
  },
};
