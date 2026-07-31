import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { NoCourtMatchHistoryError, getLineupPlan } from "../../query/lineup.js";
import { resolveTeamTarget } from "../../query/team-profile.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary } from "../emit.js";
import { formatLineupPlan } from "../format-lineup.js";

/**
 * `tn lineup plan <team> [--json]` — spec § Interfaces' `tn lineup plan <opponent>`, and spec §
 * Deliverables 1's "predicted lineup honestly labeled a guess".
 *
 * Scoped to the OPPONENT's predicted lineup, which is the fork the HC chose on issue #17: our own
 * lineup planning stays in agent chat over the MCP tools (spec § Deliverables 3 puts it there), so
 * this command needs no availability data — which is just as well, since an opponent's availability
 * is something we never have.
 *
 * Same one-`console.log`-call shape as `team show` / `player show`: the ok path prints the rendered
 * plan, the error paths print `key=value` summary lines.
 */
export const lineupPlan: Command = {
  noun: "lineup",
  verb: "plan",
  summary: "Predict an opponent's lineup from court-assignment history and ratings",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("lineup plan", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("lineup plan", "error", [["message", "missing target"]], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const resolution = resolveTeamTarget(db, parsed.target);
      if (resolution.kind === "not-found") {
        emitSummary("lineup plan", "error", [["message", `unknown target "${parsed.target}"`]], opts);
        return 1;
      }
      if (resolution.kind === "ambiguous") {
        emitSummary(
          "lineup plan",
          "error",
          [["message", `ambiguous target: ${resolution.candidates.join(", ")}`]],
          opts,
        );
        return 1;
      }

      let plan;
      try {
        plan = getLineupPlan(db, resolution.teamId);
      } catch (err) {
        // A team with no court matches is a caller-fixable state ("pull them first"), not a bug —
        // so it exits 1 with a diagnostic rather than an empty lineup that would read as a
        // prediction that nobody plays.
        if (!(err instanceof NoCourtMatchHistoryError)) throw err;
        emitSummary(
          "lineup plan",
          "error",
          [["message", `no court-match history on file for "${parsed.target}" — run tn team pull --players first`]],
          opts,
        );
        return 1;
      }

      if (!opts.quiet) {
        console.log(opts.json ? JSON.stringify(plan) : formatLineupPlan(plan));
      }
      return 0;
    } finally {
      sqlite.close();
    }
  },
};
