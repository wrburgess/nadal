import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { getTeamProfile, resolveTeamTarget } from "../../query/team-profile.js";
import type { TeamProfile } from "../../query/team-profile.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary } from "../emit.js";
import { formatRecord, formatSlotTendencies } from "../format-profile.js";
import { sixMonthsAgo } from "../window.js";

/**
 * Spec § Interfaces: `tn team show <name> [--json]` — "roster with each player's headline ratings
 * and 6-month record, plus the team's match record". Same one-`console.log`-call shape as
 * `player show` (Task 5): the ok path is not a `key=value` summary line, the error paths are.
 */
function formatTeamProfileText(profile: TeamProfile): string {
  const lines = [
    `${profile.teamName}`,
    `  record: ${formatRecord(profile.teamRecord)}`,
    `  slots: ${formatSlotTendencies(profile.slotTendencies)}`,
    "  roster:",
  ];
  for (const member of profile.roster) {
    lines.push(
      `    ${member.canonicalName} — age: ${member.ageRange ?? "unknown"}` +
        `   singles: ${formatRecord(member.singlesRecord)} (6mo)` +
        `   doubles: ${formatRecord(member.doublesRecord)} (6mo)` +
        `   slots: ${formatSlotTendencies(member.slotTendencies)}`,
    );
  }
  if (profile.roster.length === 0) lines.push("    (no roster on file)");
  return lines.join("\n");
}

export const teamShow: Command = {
  noun: "team",
  verb: "show",
  summary: "Show a team's roster and match record",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("team show", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("team show", "error", [["message", "missing target"]], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const resolution = resolveTeamTarget(db, parsed.target);
      if (resolution.kind === "not-found") {
        emitSummary("team show", "error", [["message", `unknown target "${parsed.target}"`]], opts);
        return 1;
      }
      if (resolution.kind === "ambiguous") {
        emitSummary(
          "team show",
          "error",
          [["message", `ambiguous target: ${resolution.candidates.join(", ")}`]],
          opts,
        );
        return 1;
      }

      const profile = getTeamProfile(db, resolution.teamId, { since: sixMonthsAgo() });

      if (!opts.quiet) {
        console.log(opts.json ? JSON.stringify(profile) : formatTeamProfileText(profile));
      }
      return 0;
    } finally {
      sqlite.close();
    }
  },
};
