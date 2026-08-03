import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { getTeamProfile, resolveTeamTarget } from "../../query/team-profile.js";
import type { TeamProfile } from "../../query/team-profile.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitJson, emitSummary } from "../emit.js";
import { formatName, formatRecord, formatSlotTendencies } from "../format-profile.js";
import { seasonLabel, seasonStart } from "../window.js";

/**
 * Spec § Interfaces: `tn team show <name> [--json]` — "roster with each player's headline ratings
 * and 6-month record, plus the team's match record". Same one-`console.log`-call shape as
 * `player show` (Task 5): the ok path is not a `key=value` summary line, the error paths are.
 *
 * The spec's "6-month" is superseded by issue #90: the window is the SEASON, and `season` is the
 * label for the very boundary `profile` was built with — passed in rather than recomputed here, so
 * the number and the label it sits beside can never come from two different anchors.
 */
function formatTeamProfileText(profile: TeamProfile, season: string): string {
  const lines = [
    `${formatName(profile.teamName)}`,
    `  home: ${profile.isHome ? "yes" : "no"}`,
    `  record: ${formatRecord(profile.teamRecord)}`,
    `  slots: ${formatSlotTendencies(profile.slotTendencies)}`,
    "  roster:",
  ];
  for (const member of profile.roster) {
    lines.push(
      `    ${formatName(member.canonicalName)} — age: ${formatName(member.ageRange ?? "unknown")}` +
        `   singles: ${formatRecord(member.singlesRecord)} (${season})` +
        `   doubles: ${formatRecord(member.doublesRecord)} (${season})` +
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

      // ONE anchor for both the boundary and the label below.
      const anchor = new Date();
      const profile = getTeamProfile(db, resolution.teamId, { since: seasonStart(anchor) });

      if (!opts.quiet) {
        console.log(opts.json ? emitJson(profile) : formatTeamProfileText(profile, seasonLabel(anchor)));
      }
      return 0;
    } finally {
      sqlite.close();
    }
  },
};
