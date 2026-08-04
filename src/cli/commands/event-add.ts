import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { InvalidEventFormatError } from "../../query/event-format.js";
import { InvalidLeagueScopeError, leagueScopeText } from "../../query/league-scope.js";
import {
  EventRangeExcludesAvailabilityError,
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
): err is
  | MissingEventNameError
  | InvalidEventKindError
  | InvalidEventDayError
  | EventRangeInvertedError
  | EventRangeExcludesAvailabilityError
  | InvalidEventFormatError
  | InvalidLeagueScopeError {
  return (
    err instanceof MissingEventNameError ||
    err instanceof InvalidEventKindError ||
    err instanceof InvalidEventDayError ||
    err instanceof EventRangeInvertedError ||
    err instanceof EventRangeExcludesAvailabilityError ||
    err instanceof InvalidEventFormatError ||
    err instanceof InvalidLeagueScopeError
  );
}

/**
 * `tn event add <name> <league|tournament> <YYYY-MM-DD> <YYYY-MM-DD> [format] [league-scope]` — a
 * fifth (#63) and now sixth (#97) OPTIONAL trailing positional, the same shape `tn player avail`'s
 * optional event name already uses (Task 3 decision 2, PR A) — no new flags, matching GRAMMAR.md's
 * stated exception list, where `team pull`/`player pull` are the ONLY commands carrying flags beyond
 * the global three.
 *
 * Unlike every other target-taking command, `<name>` here is NOT resolved against existing rows —
 * this is the writer that creates them. A repeat under the same name updates in place, and an
 * OMITTED `[format]` or `[league-scope]` on a repeat PRESERVES whatever was already stored rather
 * than clobbering it — see `addEvent`'s own doc comment for the full "never clobber a stored value
 * with an incoming null" rule this shares with `upsertTeamMatch`.
 *
 * Positional ORDER makes `[league-scope]` unreachable without also supplying `[format]`, and that is
 * a stated limitation rather than an oversight — but it is unreachable in practice too, which is why
 * it did not warrant a flag: the only command that READS a scope is `tn report build`, which already
 * refuses an event with no format on file, so an event worth scoping necessarily has one to re-state.
 */
export const eventAdd: Command = {
  noun: "event",
  verb: "add",
  summary: "Create or update an event and its inclusive date range",
  run: async (args) => {
    const parsed = parsePayloadArgs(args, 5);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("event add", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("event add", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [kind, startsOn, endsOn, format, leagueScope] = parsed.payload;
    if (kind === undefined || startsOn === undefined || endsOn === undefined) {
      emitSummary(
        "event add",
        "error",
        [
          [
            "message",
            "usage: tn event add <name> <league|tournament> <YYYY-MM-DD> <YYYY-MM-DD> [format] [league-scope]",
          ],
        ],
        opts,
      );
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const result = addEvent(db, { name: parsed.target, kind, startsOn, endsOn, format, leagueScope });
      const fields: [string, string][] = [
        ["event", result.name],
        ["kind", result.kind],
        ["startsOn", result.startsOn],
        ["endsOn", result.endsOn],
        ["created", String(result.created)],
      ];
      // Only when a format is actually on file — never an empty `format=""` field, and never
      // appended when none has ever been given, so an invocation that predates this feature keeps
      // printing the EXACT same summary line it always has.
      if (result.format !== null) {
        fields.push(["format", result.format.map((c) => `${c.slot}:${c.discipline}`).join(",")]);
      }
      // #97, same "only when on file" convention: an event that has never carried a scope prints
      // exactly the summary line it always has. Rendered through `leagueScopeText`, the writer's own
      // grammar, so the value printed is the value that would recreate it — the same round trip the
      // stored-value guard checks.
      if (result.leagueScope !== null) {
        fields.push(["leagueScope", leagueScopeText(result.leagueScope)]);
      }
      emitSummary("event add", "ok", fields, opts);
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
