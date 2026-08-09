import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { ambiguousMessage } from "../../ingest/errors.js";
import { getPlayerProfile, resolvePlayerTarget } from "../../query/player-profile.js";
import type { PlayerProfile } from "../../query/player-profile.js";
import { InvalidLeagueScopeError } from "../../query/league-scope.js";
import { InvalidEventFormatError } from "../../query/event-format.js";
import { UnknownEventError, resolveEvent } from "../../query/lineup.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitJson, emitSummary } from "../emit.js";
import {
  formatDataGapsLine,
  formatEvidenceScopeLine,
  formatName,
  formatPartnerFrequency,
  formatRatingTrajectory,
  formatRecord,
  formatRetainedLeaguesLine,
  formatSlotTendencies,
} from "../format-profile.js";
import { windowLabel, windowStart } from "../window.js";

/** Every error a bad `[event]` argument can throw (#97) — caller-fixable, so it exits 1 with a
 * diagnostic rather than an uncaught throw. `EventHasNoFormatError` is deliberately absent: this
 * command reads the event's evidence scope, never its court format, so an event with no format on
 * file is perfectly usable here (`resolveEvent` refuses only on an unknown name or a corrupted
 * stored value — `requireSlotSet`, which this command never calls, carries the format refusal). */
function isEventRefusal(err: unknown): err is UnknownEventError | InvalidLeagueScopeError | InvalidEventFormatError {
  return (
    err instanceof UnknownEventError ||
    err instanceof InvalidLeagueScopeError ||
    err instanceof InvalidEventFormatError
  );
}

/**
 * Spec § Interfaces: `tn player show <name|usta:…> [--json]` — "full profile: ratings trajectory,
 * history, records". Unlike `pull`, the ok path is NOT `emitSummary`'s one-line `key=value` form —
 * a profile is inherently multi-field, and squeezing it through that format would either truncate
 * it or produce an unreadable wall of `key="value"` pairs. Instead: exactly ONE `console.log` call
 * either way (human or `--json`), which is what "one summary" actually means for this command — the
 * error paths (missing/unknown/ambiguous target, a bad flag) still go through `emitSummary` so they
 * stay consistent with every other command's error contract.
 */
function formatPlayerProfileText(profile: PlayerProfile, label: string, eventName: string | null): string {
  const id = profile.identity;
  const aliasSuffix = id.aliases.length > 0 ? ` (aka ${id.aliases.map(formatName).join(", ")})` : "";
  const gapsLine = formatDataGapsLine(profile.dataGaps);

  const lines = [
    `${formatName(id.canonicalName)}${aliasSuffix}`,
    `  age: ${formatName(id.ageRange ?? "unknown")}   gender: ${formatName(id.gender ?? "unknown")}`,
    `  ratings: ${formatRatingTrajectory(profile.ratingTrajectory)}`,
    `  singles: ${formatRecord(profile.singlesRecord.windowed)} (${label}) / ${formatRecord(profile.singlesRecord.allTime)} (all-time)`,
    `  doubles: ${formatRecord(profile.doublesRecord.windowed)} (${label}) / ${formatRecord(profile.doublesRecord.allTime)} (all-time)`,
    `  slots: ${formatSlotTendencies(profile.slotTendencies)}`,
    `  partners: ${formatPartnerFrequency(profile.partnerFrequency)}`,
    // Issue #49: a retired membership is history, not hidden (player-profile.ts never filters it) —
    // labelled "(former)" so a captain reading the profile can tell a former team from a current one.
    `  teams: ${
      profile.teamMemberships
        .map((m) => `${formatName(m.teamName)}${m.retiredAt !== null ? " (former)" : ""}`)
        .join(", ") || "none"
    }`,
    // #97. Printed unconditionally, scoped or not — a reader who cannot tell a scoped profile from
    // an unscoped one has learned nothing from the records two lines up. The second line is the
    // accepted residual made concrete: what is STILL counted after the scope ran.
    `  evidence: ${formatEvidenceScopeLine(profile.evidenceScope, eventName)}`,
    `  leagues counted: ${formatRetainedLeaguesLine(profile.evidenceScope)}`,
  ];
  if (gapsLine !== null) lines.push(`  not collected yet: ${gapsLine}`);
  return lines.join("\n");
}

export const playerShow: Command = {
  noun: "player",
  verb: "show",
  summary: "Show a player's full profile: ratings trajectory, history, records",
  run: async (args) => {
    // #97: an optional trailing `[event]` positional — the same shape `tn lineup plan`,
    // `tn report build` and `tn player avail` already use, so this adds no flags.
    const parsed = parsePayloadArgs(args, 1);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player show", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player show", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [eventName] = parsed.payload;

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
          [["message", ambiguousMessage({ incoming: parsed.target, candidates: resolution.candidates, context: "player name target" })]],
          opts,
        );
        return 1;
      }

      // #97: the named event, resolved ONCE before the profile is built so a bad name refuses
      // without printing anything. An event that records no scope resolves `leagueScope` to `null`,
      // which the profile reports as "no league scope applied" rather than silently reading as
      // unscoped.
      const resolvedEvent = eventName === undefined ? undefined : resolveEvent(db, eventName);
      // Issue #122, design decision 5: anchor to the SAME already-resolved event's own `starts_on`
      // — never a second lookup — falling back to the caller's clock when no event was named, or
      // the named event has no `starts_on` on file. This fixes the unnamed defect that
      // `player show`/`team show` used to ignore their `[event]` argument entirely for windowing.
      // ONE anchor for both the boundary and the label below, so the two can never come from
      // different reads.
      const anchor = resolvedEvent?.recordedAs.startsOn ?? new Date();
      const profile = getPlayerProfile(db, resolution.playerId, {
        since: windowStart(anchor),
        leagueScope: resolvedEvent?.leagueScope ?? null,
      });

      // `--quiet` wins over `--json` (GRAMMAR.md), same as `emitSummary` — checked here rather
      // than routed through `emitSummary` itself, since neither success form is a `key=value` line.
      if (!opts.quiet) {
        console.log(
          opts.json
            ? emitJson(profile)
            : formatPlayerProfileText(profile, windowLabel(anchor), eventName ?? null),
        );
      }
      return 0;
    } catch (err) {
      if (!isEventRefusal(err)) throw err;
      emitSummary("player show", "error", [["message", err.message]], opts);
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
