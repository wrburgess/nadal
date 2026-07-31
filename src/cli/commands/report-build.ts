import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { OutputPathError } from "../../fs/output-root.js";
import { writeSectionalsDossiers, writeTeamDossier } from "../../report/write.js";
import { resolveTeamTarget } from "../../query/team-profile.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary } from "../emit.js";
import { sixMonthsAgo } from "../window.js";

const SECTIONALS_TARGET = "sectionals";

/**
 * Spec § Interfaces: `tn report build [sectionals|<team>] [--json]`. `<team>` builds that one
 * team's dossier; `sectionals` — and bare, no target — builds one dossier per team in the DB plus a
 * top-level index. Unlike `player show`/`team show` (Task 5/6), this command's ok path IS a
 * `key=value` summary line (`emitSummary`): the deliverable here is a list of files written, which
 * fits that shape naturally, rather than a profile that would not.
 */
export const reportBuild: Command = {
  noun: "report",
  verb: "build",
  summary: "Render per-opponent scouting dossiers (HTML + markdown) to disk",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("report build", "error", [["message", parsed.error]], opts);
      return 1;
    }

    // `undefined` and `"sectionals"` are the SAME instruction (spec: "Bare (no target) is
    // equivalent to sectionals") — anything else names a single team.
    const target = parsed.target;
    const since = sixMonthsAgo();

    const { db, sqlite } = openDb();
    try {
      let written: string[];
      if (target === undefined || target === SECTIONALS_TARGET) {
        written = writeSectionalsDossiers(db, { since });
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
            [["message", `ambiguous target: ${resolution.candidates.join(", ")}`]],
            opts,
          );
          return 1;
        }
        written = writeTeamDossier(db, resolution.teamId, { since });
      }

      emitSummary(
        "report build",
        "ok",
        [
          ["target", target ?? SECTIONALS_TARGET],
          ["count", written.length],
          ["files", written.join(", ")],
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
      throw err;
    } finally {
      sqlite.close();
    }
  },
};
