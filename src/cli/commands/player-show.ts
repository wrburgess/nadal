import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { getPlayerProfile, resolvePlayerTarget } from "../../query/player-profile.js";
import type { PlayerProfile } from "../../query/player-profile.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitJson, emitSummary } from "../emit.js";
import { formatDataGapsLine, formatName, formatPartnerFrequency, formatRatingTrajectory, formatRecord, formatSlotTendencies } from "../format-profile.js";
import { seasonLabel, seasonStart } from "../window.js";

/**
 * Spec § Interfaces: `tn player show <name|usta:…> [--json]` — "full profile: ratings trajectory,
 * history, records". Unlike `pull`, the ok path is NOT `emitSummary`'s one-line `key=value` form —
 * a profile is inherently multi-field, and squeezing it through that format would either truncate
 * it or produce an unreadable wall of `key="value"` pairs. Instead: exactly ONE `console.log` call
 * either way (human or `--json`), which is what "one summary" actually means for this command — the
 * error paths (missing/unknown/ambiguous target, a bad flag) still go through `emitSummary` so they
 * stay consistent with every other command's error contract.
 */
function formatPlayerProfileText(profile: PlayerProfile, season: string): string {
  const id = profile.identity;
  const aliasSuffix = id.aliases.length > 0 ? ` (aka ${id.aliases.map(formatName).join(", ")})` : "";
  const gapsLine = formatDataGapsLine(profile.dataGaps);

  const lines = [
    `${formatName(id.canonicalName)}${aliasSuffix}`,
    `  age: ${formatName(id.ageRange ?? "unknown")}   gender: ${formatName(id.gender ?? "unknown")}`,
    `  ratings: ${formatRatingTrajectory(profile.ratingTrajectory)}`,
    `  singles: ${formatRecord(profile.singlesRecord.season)} (${season}) / ${formatRecord(profile.singlesRecord.allTime)} (all-time)`,
    `  doubles: ${formatRecord(profile.doublesRecord.season)} (${season}) / ${formatRecord(profile.doublesRecord.allTime)} (all-time)`,
    `  slots: ${formatSlotTendencies(profile.slotTendencies)}`,
    `  partners: ${formatPartnerFrequency(profile.partnerFrequency)}`,
    // Issue #49: a retired membership is history, not hidden (player-profile.ts never filters it) —
    // labelled "(former)" so a captain reading the profile can tell a former team from a current one.
    `  teams: ${
      profile.teamMemberships
        .map((m) => `${formatName(m.teamName)}${m.retiredAt !== null ? " (former)" : ""}`)
        .join(", ") || "none"
    }`,
  ];
  if (gapsLine !== null) lines.push(`  not collected yet: ${gapsLine}`);
  return lines.join("\n");
}

export const playerShow: Command = {
  noun: "player",
  verb: "show",
  summary: "Show a player's full profile: ratings trajectory, history, records",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player show", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player show", "error", [["message", "missing target"]], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const resolution = resolvePlayerTarget(db, parsed.target);
      if (resolution.kind === "not-found") {
        emitSummary("player show", "error", [["message", `unknown target "${parsed.target}"`]], opts);
        return 1;
      }
      if (resolution.kind === "ambiguous") {
        emitSummary(
          "player show",
          "error",
          [["message", `ambiguous target: ${resolution.candidates.join(", ")}`]],
          opts,
        );
        return 1;
      }

      // ONE anchor for both the boundary and the label below (issue #90).
      const anchor = new Date();
      const profile = getPlayerProfile(db, resolution.playerId, { since: seasonStart(anchor) });

      // `--quiet` wins over `--json` (GRAMMAR.md), same as `emitSummary` — checked here rather
      // than routed through `emitSummary` itself, since neither success form is a `key=value` line.
      if (!opts.quiet) {
        console.log(opts.json ? emitJson(profile) : formatPlayerProfileText(profile, seasonLabel(anchor)));
      }
      return 0;
    } finally {
      sqlite.close();
    }
  },
};
