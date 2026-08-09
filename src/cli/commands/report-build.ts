import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { ambiguousMessage } from "../../ingest/errors.js";
import { InvalidEventFormatError } from "../../query/event-format.js";
import { InvalidLeagueScopeError } from "../../query/league-scope.js";
import { EventHasNoFormatError, UnknownEventError, resolveEvent } from "../../query/lineup.js";
import { OutputPathError } from "../../fs/output-root.js";
import { countTeams, resolvedReportsRoot, writeSectionalsDossiers, writeTeamDossier } from "../../report/write.js";
import { windowAnchorFor } from "../../query/events.js";
import { resolveTeamTarget } from "../../query/team-profile.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitSummary } from "../emit.js";
import type { SummaryField } from "../emit.js";
import { evidenceWindow, windowSnapshot } from "../window.js";

const SECTIONALS_TARGET = "sectionals";

/** Every error a bad `[event]` argument can throw (#63, #97) — caller-fixable, so it exits 1 with a
 * diagnostic rather than an uncaught throw, matching every other refusal in this command.
 *
 * `InvalidLeagueScopeError` belongs here for exactly the reason `InvalidEventFormatError` does: both
 * are fail-closed decoders on the SAME `resolveEvent` call, and a hand-corrupted column is precisely
 * what they exist for. Omitting it did not produce the stack trace this list exists to prevent — it
 * produced something worse, an exit 1 with **nothing printed at all**, which reads as "the command
 * did nothing" rather than "the command refused, here is why". The general shape, worth stating
 * because the next structured column on `events` will meet it: **adding a decoder to a shared
 * resolve path creates a new refusal class, and every caller that classifies refusals by an explicit
 * `instanceof` list is silently incomplete until it is added to that list.**
 * (Found by the AC's verify pass and independently by the Codex adversarial review of PR #99,
 * round 1, Finding 3 [C1/medium].) */
function isEventRefusal(
  err: unknown,
): err is UnknownEventError | EventHasNoFormatError | InvalidEventFormatError | InvalidLeagueScopeError {
  return (
    err instanceof UnknownEventError ||
    err instanceof EventHasNoFormatError ||
    err instanceof InvalidEventFormatError ||
    err instanceof InvalidLeagueScopeError
  );
}

/**
 * Spec § Interfaces: `tn report build [sectionals|<team>] [event] [--json]`. `<team>` builds that
 * one team's dossier; `sectionals` — and bare, no target — builds one dossier per team in the DB
 * plus a top-level index. The optional trailing `event` (#63) resolves against `events.name` and its
 * format REPLACES the derived slot set for EVERY dossier this run builds — the same optional
 * trailing positional `tn lineup plan`/`tn player avail` already use, no new flags. Unlike
 * `player show`/`team show` (Task 5/6), this command's ok path IS a `key=value` summary line
 * (`emitSummary`): the deliverable here is a list of files written, which fits that shape naturally,
 * rather than a profile that would not.
 */
export const reportBuild: Command = {
  noun: "report",
  verb: "build",
  summary: "Render per-opponent scouting dossiers (HTML + markdown) to disk",
  run: async (args) => {
    const parsed = parsePayloadArgs(args, 1);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("report build", "error", [["message", parsed.error]], opts);
      return 1;
    }

    // `undefined` and `"sectionals"` are the SAME instruction (spec: "Bare (no target) is
    // equivalent to sectionals") — anything else names a single team.
    const target = parsed.target;
    const [eventName] = parsed.payload;

    const { db, sqlite } = openDb();
    try {
      // Issue #122 (generalizes #90): the binder is anchored to the EVENT'S 12-month evidence
      // window, not to the day it is printed, so the same database renders the same records in
      // August as in December. `anchoredTo` is reported in the summary below because an event with
      // no `starts_on` falls back to today, and a fallback that looked identical to a real anchor
      // would reproduce the defect this fixes — a boundary that reads as anchored and is not.
      //
      // #122 round-1 Finding 3: the named event is resolved EXACTLY ONCE, right here — never again
      // by `windowAnchorFor` (a pure function over this already-resolved value) or by
      // `writeSectionalsDossiers`/`writeTeamDossier` below (which take the resolved event as a
      // parameter and never look it up themselves). Before this fix, the window came from its own
      // separate `resolveWindowAnchor` read while the format/scope/roster came from a SECOND,
      // independent `resolveEvent` read inside the write — a concurrent `tn event add` between the
      // two could hand one build the old event's window and the new event's everything else. One
      // read here removes the second read to disagree with it.
      const event = eventName === undefined ? undefined : resolveEvent(db, eventName);
      const anchor = windowAnchorFor(event);
      const window = evidenceWindow(anchor.value);
      let written: string[];
      let teamsCount: number;
      // #113: only ever set on the SINGLE-team path — a batch mixes registered and season teams,
      // and one scalar cannot describe both without lying about one of them (see the field's own
      // comment below).
      let rosterField: SummaryField | undefined;
      if (target === undefined || target === SECTIONALS_TARGET) {
        written = writeSectionalsDossiers(db, { window, event });
        teamsCount = countTeams(db);
      } else {
        const resolution = resolveTeamTarget(db, target);
        if (resolution.kind === "not-found") {
          emitSummary("report build", "error", [["message", `unknown target "${target}"`]], opts);
          return 1;
        }
        if (resolution.kind === "ambiguous") {
          emitSummary(
            "report build",
            "error",
            [["message", ambiguousMessage({ incoming: target, candidates: resolution.candidates, context: "team name target" })]],
            opts,
          );
          return 1;
        }
        // The roster source comes back FROM the write, never from a second read. An earlier
        // revision re-queried the database after the files had landed, which a concurrent
        // `tn roster set` could slip inside — the summary would then say `roster=registered` about
        // files that say season roster. (Codex adversarial review, round 1, finding 3 [medium].)
        const result = writeTeamDossier(db, resolution.teamId, { window, event });
        written = result.files;
        teamsCount = 1;
        rosterField = ["roster", result.rosterSource];
      }

      // The old shape printed every absolute file path on one line — unreadable at Sectionals
      // scale (a five-team field would print ten-plus paths). `root` + `teams` + `files` tells a
      // caller exactly where to look and how much landed there without spelling out every path.
      emitSummary(
        "report build",
        "ok",
        [
          ["target", target ?? SECTIONALS_TARGET],
          ["teams", teamsCount],
          ["files", written.length],
          ["root", resolvedReportsRoot()],
          // Issue #122: `since` is the ISO lower bound the binder actually filtered to (machine-
          // usable, no spaces — superseding #90's bare `season=` year), and `anchoredTo` says where
          // the anchor came from: `event` means the event's own `starts_on`, `today` means it had
          // none (or none was named) and the clock was used. Printing only `since` would make those
          // two indistinguishable, which is the defect this change exists to remove.
          ["since", windowSnapshot(window).since],
          ["anchoredTo", anchor.anchoredTo],
          ...(rosterField === undefined ? [] : [rosterField]),
        ],
        opts,
      );
      return 0;
    } catch (err) {
      // A misconfigured TN_REPORTS_PATH (e.g. pointed at a tracked in-repo directory) is refused by
      // Task 1's guard — surfaced here as an ordinary command error rather than an uncaught throw,
      // matching every other command's contract of "a failure is a nonzero exit with a message",
      // not a stack trace on stderr.
      if (err instanceof OutputPathError) {
        emitSummary("report build", "error", [["message", err.message]], opts);
        return 1;
      }
      if (isEventRefusal(err)) {
        emitSummary("report build", "error", [["message", err.message]], opts);
        return 1;
      }
      throw err;
    } finally {
      sqlite.close();
    }
  },
};
