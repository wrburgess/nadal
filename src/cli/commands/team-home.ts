import { eq } from "drizzle-orm";
import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { teams } from "../../db/schema.js";
import { resolveTeamTarget } from "../../query/team-profile.js";
import { setHomeTeam } from "../../query/home-team.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary } from "../emit.js";

/**
 * `tn team home <name|tr:…>` (nadal ADR 0001) — designates the resolved team as "our team" for
 * availability, captain notes, and dossier head-to-head. Reuses `resolveTeamTarget` (Task 5)
 * unchanged: this command NEVER creates a team, exactly like `team show` — enrichment stays `pull`'s
 * job. Re-running against a different team simply moves the designation (`setHomeTeam` clears any
 * prior flag first); it never errors on "already designated".
 */
export const teamHome: Command = {
  noun: "team",
  verb: "home",
  summary: "Designate a team as home (our team) for availability, notes, and dossiers",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("team home", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("team home", "error", [["message", "missing target"]], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const resolution = resolveTeamTarget(db, parsed.target);
      if (resolution.kind === "not-found") {
        emitSummary("team home", "error", [["message", `unknown target "${parsed.target}"`]], opts);
        return 1;
      }
      if (resolution.kind === "ambiguous") {
        emitSummary(
          "team home",
          "error",
          [["message", `ambiguous target: ${resolution.candidates.join(", ")}`]],
          opts,
        );
        return 1;
      }

      setHomeTeam(db, resolution.teamId);
      const team = db.select().from(teams).where(eq(teams.id, resolution.teamId)).all()[0]!;
      emitSummary("team home", "ok", [["team", team.name]], opts);
      return 0;
    } finally {
      sqlite.close();
    }
  },
};
