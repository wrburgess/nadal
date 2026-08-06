import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { ambiguousMessage } from "../../ingest/errors.js";
import { getTeamProfile, resolveTeamTarget } from "../../query/team-profile.js";
import type { TeamProfile } from "../../query/team-profile.js";
import { InvalidEventFormatError } from "../../query/event-format.js";
import { InvalidLeagueScopeError } from "../../query/league-scope.js";
import { UnknownEventError, resolveEvent } from "../../query/lineup.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitJson, emitSummary } from "../emit.js";
import {
  formatAbsentRosterMember,
  formatEvidenceScopeLine,
  formatName,
  formatRecord,
  formatRetainedLeaguesLine,
  formatRosterSourceLine,
  formatSlotTendencies,
  ratingSourceLabel,
} from "../format-profile.js";
import { seasonLabel, seasonStart } from "../window.js";

/** Every error a bad `[event]` argument can throw (#97). `EventHasNoFormatError` is deliberately
 * absent for the same reason as in `player show`: this command reads the evidence scope, never the
 * court format. */
function isEventRefusal(err: unknown): err is UnknownEventError | InvalidLeagueScopeError | InvalidEventFormatError {
  return (
    err instanceof UnknownEventError ||
    err instanceof InvalidLeagueScopeError ||
    err instanceof InvalidEventFormatError
  );
}

/**
 * Spec § Interfaces: `tn team show <name> [--json]` — "roster with each player's headline ratings
 * and 6-month record, plus the team's match record". Same one-`console.log`-call shape as
 * `player show` (Task 5): the ok path is not a `key=value` summary line, the error paths are.
 *
 * The spec's "6-month" is superseded by issue #90: the window is the SEASON, and `season` is the
 * label for the very boundary `profile` was built with — passed in rather than recomputed here, so
 * the number and the label it sits beside can never come from two different anchors.
 */
function formatTeamProfileText(profile: TeamProfile, season: string, eventName: string | null): string {
  const lines = [
    `${formatName(profile.teamName)}`,
    `  home: ${profile.isHome ? "yes" : "no"}`,
    `  record: ${formatRecord(profile.teamRecord)}`,
    `  slots: ${formatSlotTendencies(profile.slotTendencies)}`,
    // #97, printed unconditionally for the same reason `player show` prints it: this command renders
    // the roster's per-member records and slot tendencies from the SAME `getTeamProfile` call the
    // dossier uses, so leaving it silent here would keep one surface on the unfiltered path with no
    // way to say so. `record:` above is deliberately NOT covered by it — that comes from team
    // fixtures, which carry no league context at all.
    `  evidence: ${formatEvidenceScopeLine(profile.evidenceScope, eventName)} (the team record above is from team fixtures, not scoped by this)`,
    `  leagues counted: ${formatRetainedLeaguesLine(profile.evidenceScope)}`,
    // #113: the roster-source disclosure line — always printed, both branches (the #97 precedent
    // above, applied to a different disclosure).
    `  roster: ${formatRosterSourceLine(profile.rosterSource, eventName, profile.registeredCount, profile.seasonCount)}`,
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

  // #113, the HC's 2026-08-05 dossier-scope mock: name + rating only, no record, no tendencies.
  // Never rendered when empty (`resolveRoster`'s own doc comment) — a second `console.log` call is
  // never needed since this joins the SAME string.
  if (profile.absentRoster.length > 0) {
    const sourceNote =
      profile.absentRatingSource === null
        ? "no ratings on file for anyone below"
        : `ratings shown: ${ratingSourceLabel(profile.absentRatingSource)}`;
    lines.push(`  not registered (watch for adds) — ${sourceNote}:`);
    for (const member of profile.absentRoster) {
      lines.push(`    ${formatAbsentRosterMember(member, profile.absentRatingSource)}`);
    }
  }

  return lines.join("\n");
}

export const teamShow: Command = {
  noun: "team",
  verb: "show",
  summary: "Show a team's roster and match record",
  run: async (args) => {
    // #97: an optional trailing `[event]` positional, the same shape every other event-taking
    // command uses.
    const parsed = parsePayloadArgs(args, 1);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("team show", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("team show", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [eventName] = parsed.payload;

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
          [["message", ambiguousMessage({ incoming: parsed.target, candidates: resolution.candidates, context: "team name target" })]],
          opts,
        );
        return 1;
      }

      // ONE anchor for both the boundary and the label below.
      const anchor = new Date();
      // #113: resolved ONCE (never a second lookup) — `eventId` scopes the roster the same read
      // already scopes by `leagueScope`.
      const resolvedEvent = eventName === undefined ? undefined : resolveEvent(db, eventName);
      const profile = getTeamProfile(db, resolution.teamId, {
        since: seasonStart(anchor),
        leagueScope: resolvedEvent?.leagueScope ?? null,
        eventId: resolvedEvent?.event.id ?? null,
      });

      if (!opts.quiet) {
        console.log(
          opts.json ? emitJson(profile) : formatTeamProfileText(profile, seasonLabel(anchor), eventName ?? null),
        );
      }
      return 0;
    } catch (err) {
      if (!isEventRefusal(err)) throw err;
      emitSummary("team show", "error", [["message", err.message]], opts);
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
