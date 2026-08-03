import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { ambiguousMessage } from "../../ingest/errors.js";
import { InvalidEventFormatError } from "../../query/event-format.js";
import { EventHasNoFormatError, UnknownEventError } from "../../query/lineup.js";
import { OutputPathError } from "../../fs/output-root.js";
import { countTeams, resolvedReportsRoot, writeSectionalsDossiers, writeTeamDossier } from "../../report/write.js";
import { resolveSeasonAnchor } from "../../query/events.js";
import { resolveTeamTarget } from "../../query/team-profile.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitSummary } from "../emit.js";
import { seasonWindow } from "../window.js";

const SECTIONALS_TARGET = "sectionals";

/** Every error a bad `[event]` argument can throw (#63) — caller-fixable, so it exits 1 with a
 * diagnostic rather than an uncaught throw, matching every other refusal in this command. */
function isEventRefusal(err: unknown): err is UnknownEventError | EventHasNoFormatError | InvalidEventFormatError {
  return (
    err instanceof UnknownEventError || err instanceof EventHasNoFormatError || err instanceof InvalidEventFormatError
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
      // Issue #90: the binder is anchored to the EVENT'S season, not to the day it is printed, so
      // the same database renders the same records in August as in December. `anchoredTo` is
      // reported in the summary below because an event with no `starts_on` falls back to today,
      // and a fallback that looked identical to a real anchor would reproduce the defect this
      // fixes — a boundary that reads as anchored and is not.
      const anchor = resolveSeasonAnchor(db, eventName);
      const season = seasonWindow(anchor.value);
      let written: string[];
      let teamsCount: number;
      if (target === undefined || target === SECTIONALS_TARGET) {
        written = writeSectionalsDossiers(db, { season, eventName });
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
        written = writeTeamDossier(db, resolution.teamId, { season, eventName });
        teamsCount = 1;
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
          // Issue #90. `season` says what the binder actually covers, and `anchoredTo` says where
          // that came from: `event` means the event's own `starts_on`, `today` means it had none
          // (or none was named) and the clock was used. Printing only `season` would make those
          // two indistinguishable, which is the defect this change exists to remove.
          ["season", season.year],
          ["anchoredTo", anchor.anchoredTo],
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
