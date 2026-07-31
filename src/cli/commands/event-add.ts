import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import {
  EventRangeInvertedError,
  InvalidEventDayError,
  InvalidEventKindError,
  MissingEventNameError,
  addEvent,
} from "../../query/events.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitSummary } from "../emit.js";

/** Every error `addEvent` can throw for a caller-fixable reason — as opposed to a genuine bug,
 * which should still surface as an uncaught throw rather than a tidy `status=error` line. */
function isEventRefusal(
  err: unknown,
): err is MissingEventNameError | InvalidEventKindError | InvalidEventDayError | EventRangeInvertedError {
  return (
    err instanceof MissingEventNameError ||
    err instanceof InvalidEventKindError ||
    err instanceof InvalidEventDayError ||
    err instanceof EventRangeInvertedError
  );
}

/**
 * `tn event add <name> <league|tournament> <YYYY-MM-DD> <YYYY-MM-DD>` — payload positionals, no new
 * flags, matching the shape `tn player avail` set (PR A, Task 3 decision 2) and GRAMMAR.md's stated
 * exception list, where `team pull`/`player pull` are the ONLY commands carrying flags beyond the
 * global three. An earlier draft of the plan specified `--kind/--from/--to`; positionals are what
 * the house grammar actually uses, and they add nothing to the flag surface.
 *
 * Unlike every other target-taking command, `<name>` here is NOT resolved against existing rows —
 * this is the writer that creates them. A repeat under the same name updates in place.
 */
export const eventAdd: Command = {
  noun: "event",
  verb: "add",
  summary: "Create or update an event and its inclusive date range",
  run: async (args) => {
    const parsed = parsePayloadArgs(args, 3);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("event add", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("event add", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [kind, startsOn, endsOn] = parsed.payload;
    if (kind === undefined || startsOn === undefined || endsOn === undefined) {
      emitSummary(
        "event add",
        "error",
        [["message", "usage: tn event add <name> <league|tournament> <YYYY-MM-DD> <YYYY-MM-DD>"]],
        opts,
      );
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const result = addEvent(db, { name: parsed.target, kind, startsOn, endsOn });
      emitSummary(
        "event add",
        "ok",
        [
          ["event", result.name],
          ["kind", result.kind],
          ["startsOn", result.startsOn],
          ["endsOn", result.endsOn],
          ["created", String(result.created)],
        ],
        opts,
      );
      return 0;
    } catch (err) {
      if (!isEventRefusal(err)) throw err;
      emitSummary("event add", "error", [["message", err.message]], opts);
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
