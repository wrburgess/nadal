// Agent/diff-friendly markdown dossier renderer (Task 7) — the twin of `html.ts`, same input shape
// (`TeamDossier`), same content order, same determinism requirement (no clock, no locale-dependent
// formatting). Markdown has no "external reference" concept the way HTML does (no `<script src>`
// to omit), but the renderer still never emits a URL of any kind, for the same self-contained
// spirit `html.ts` is held to.

import type { PlayerProfile } from "../query/player-profile.js";
import type { TeamCrossHeadToHead } from "../query/team-profile.js";
import {
  formatAbsentRosterMember,
  formatEvidenceScopeLine,
  formatPartnerFrequency,
  formatRatingTrajectory,
  formatRecord,
  formatRetainedLeaguesLine,
  formatRosterSourceLine,
  formatSlotTendencies,
  ratingSourceLabel,
} from "../cli/format-profile.js";
import { sanitizeValue } from "../sanitize.js";
import type { TeamDossier } from "./types.js";

/**
 * The general-purpose escape for any free text this renderer interpolates — a player or team name
 * is attacker-influenced (it comes from a scraped page), and markdown, unlike this renderer's HTML
 * twin, permits raw inline HTML: a name like `Dan <script>alert(1)</script>` written verbatim is
 * executed by any viewer that renders the resulting `.md` file. `escapeHtml` in `html.ts` is the
 * ONLY thing preventing that on the HTML side; this is markdown's equivalent, applied everywhere a
 * name (or any other free-text field) is interpolated — table cells, headings, prose — not only
 * inside the roster table.
 *
 * A markdown table cell specifically breaks on two further characters beyond the injection set:
 * `|` (the column delimiter itself) and a raw newline (a table row must be exactly one line). A
 * backtick is escaped for the same table-safety reason — an odd number of unescaped backticks opens
 * an inline-code span that swallows every `|` after it until the next backtick, corrupting the
 * table exactly like an unescaped pipe would, just less obviously. `<`, `>`, `[`, `]`, `_`, `*` are
 * escaped because CommonMark treats them as syntax (raw HTML, link/image brackets, emphasis) even
 * outside a table cell — the same character set matters whether this value lands in a table row or
 * a bare heading. Backslash-escaping is CommonMark's own mechanism for "this character, literally"
 * — not a bespoke scheme — so the output survives being re-parsed by any standard renderer, not
 * just displayed as raw text by accident.
 *
 * **Markdown escaping is not the whole job**, which is why `sanitizeValue` runs FIRST. Backslashing
 * CommonMark's syntax characters says nothing about control, format, or line-separator characters:
 * a RIGHT-TO-LEFT OVERRIDE inside a name survives every escape above and visually reorders the
 * rendered table — including, in a scouting dossier, which player sits on which court. That matters
 * more here than in a terminal, because this file is printed and carried to a court where nobody
 * can check it against the source. `sanitizeValue` also subsumes the newline handling this function
 * used to do itself (CR and LF are both category Cc), so the explicit `\r?\n` replace it carried
 * was removed rather than left as a branch no input can reach.
 * (Found by the independent Codex review of PR #47, rated medium.)
 */
export function escapeMarkdownCell(value: string): string {
  return sanitizeValue(value)
    .replace(/\\/g, "\\\\")
    .replace(/[|`<>[\]_*]/g, (ch) => `\\${ch}`);
}

/**
 * The roster-source disclosure line (#113) — `renderEvidenceScopeMarkdown`'s precedent one field
 * over. **Always rendered, both branches** (#97's discipline, applied to a different disclosure): a
 * season roster states itself as loudly as a registered one.
 */
function renderRosterSourceLineMarkdown(dossier: TeamDossier): string {
  const line = formatRosterSourceLine(
    dossier.rosterSource,
    dossier.event?.name ?? null,
    dossier.team.registeredCount,
    dossier.team.seasonCount,
  );
  return `**Roster:** ${escapeMarkdownCell(line)}.`;
}

/**
 * The NOT REGISTERED block (#113, the HC's 2026-08-05 dossier-scope mock): season-roster players
 * who did not register for the scoped event, name + rating only — deliberately no record, no
 * tendencies (a late add should be recognised, not scouted). Renders NOTHING when
 * `dossier.team.absentRoster` is empty — which is always true on the `season` branch (see
 * `resolveRoster`'s own doc comment), and may also be true on the `registered` branch when the
 * entire season roster registered. Either way, an empty absent list means the concept does not
 * apply here, never "everyone is absent".
 */
function renderNotRegisteredSectionMarkdown(dossier: TeamDossier): string {
  const absent = dossier.team.absentRoster;
  if (absent.length === 0) return "";
  const source = dossier.team.absentRatingSource;
  const sourceNote =
    source === null ? "no ratings on file for anyone below" : `ratings shown: ${escapeMarkdownCell(ratingSourceLabel(source))}`;
  const items = absent.map((m) => `- ${escapeMarkdownCell(formatAbsentRosterMember(m, source))}`).join("\n");
  return (
    "\n\n## Not registered (watch for adds)\n\n" +
    `_Name and rating only, ${sourceNote} — no record, no tendencies; a late add should be ` +
    "recognised, not scouted._\n\n" +
    items
  );
}

function renderRosterTableMarkdown(dossier: TeamDossier): string {
  const header = "| Player | Age range | Ratings (NTRP · WTN S/D · TR dynamic) |";
  const divider = "|---|---|---|";
  const rows = dossier.players.map(
    (p) =>
      `| ${escapeMarkdownCell(p.identity.canonicalName)} | ${escapeMarkdownCell(p.identity.ageRange ?? "unknown")} |` +
      ` ${escapeMarkdownCell(formatRatingTrajectory(p.ratingTrajectory))} |`,
  );
  return [header, divider, ...rows].join("\n");
}

function renderTeamRecordMarkdown(dossier: TeamDossier): string {
  return (
    `**Team record:** ${formatRecord(dossier.team.teamRecord)}  \n` +
    `**Slots:** ${formatSlotTendencies(dossier.team.slotTendencies)}`
  );
}

// Same rationale as `html.ts`'s twin: `TeamCrossHeadToHead` has no `excludedUndated`, so
// `formatRecord` does not apply — see that file's comment for why.
function formatHeadToHead(h: TeamCrossHeadToHead): string {
  const base = `${h.wins}-${h.losses}`;
  return h.undecided > 0 ? `${base} (${h.undecided} undecided)` : base;
}

/** One player's row within the dedicated prior-meetings section (see
 * `renderPriorMeetingsSectionMarkdown` below) — `headToHead` is never null here, that case is
 * handled once for the whole dossier by the caller before this is reached. */
function renderPlayerPriorMeetingsRowMarkdown(player: PlayerProfile, headToHead: TeamCrossHeadToHead[]): string {
  const rows = headToHead.filter((h) => h.playerId === player.identity.playerId);
  const name = escapeMarkdownCell(player.identity.canonicalName);
  if (rows.length === 0) return `**${name}** — Prior meetings vs our players: none on file.`;
  const items = rows.map(
    (h) => `- vs ${escapeMarkdownCell(h.opponentName)}: ${formatHeadToHead(h)} (${h.matches} matches)`,
  );
  return [`**${name}** — Prior meetings vs our players:`, ...items].join("\n");
}

/**
 * One dedicated section for the whole dossier, rendered ONCE — not once per player block. Same
 * rationale as `html.ts`'s twin: the "not available" line does not depend on which player it is
 * about, so repeating it per player only repeated the same sentence N times for an N-player
 * dossier. The two-reason split below is `html.ts`'s twin too — see that comment for why one
 * sentence for both was wrong; the pair must stay in step so the printed and the readable dossier
 * never disagree about why a section is empty.
 */
function renderPriorMeetingsSectionMarkdown(dossier: TeamDossier): string {
  const headToHead = dossier.team.headToHead;
  const unavailable = dossier.team.isHome
    ? "_Not available on our own team's dossier — this section compares an opponent's roster against ours._"
    : "_Not available in this build (no home team configured)._";
  const body =
    headToHead === null
      ? unavailable
      : dossier.players.map((p) => renderPlayerPriorMeetingsRowMarkdown(p, headToHead)).join("\n\n");
  return `## Prior meetings vs our players\n\n${body}`;
}

/**
 * #97's non-optional disclosure: what the records, slot tendencies and prior meetings in this
 * dossier were actually computed over. Rendered as its own section, ALWAYS — an unscoped dossier
 * says so as plainly as a scoped one does, because a reader who cannot tell those two apart is back
 * at the defect this issue was opened for.
 *
 * The closing sentence is what keeps the section from over-claiming, and it is the reason this is a
 * section rather than a footnote. The scope does not govern everything on the page: the team record
 * is derived from `team_matches` and carries no league context at all, and the predicted lineup is
 * scoped by something stronger and different (this team's own schedule — see `getLineupPlan`).
 * Printing a scope immediately above a lineup it does not govern, without saying so, would be a new
 * silent lie of the same shape as the one being fixed.
 */
function renderEvidenceScopeMarkdown(dossier: TeamDossier): string {
  const summary = dossier.team.evidenceScope;
  const eventName = dossier.event?.name ?? null;
  return [
    "## Evidence scope",
    "",
    `**Records, court-slot tendencies and prior meetings below were computed over:** ` +
      `${escapeMarkdownCell(formatEvidenceScopeLine(summary, eventName))}.`,
    "",
    `**Leagues counted:** ${escapeMarkdownCell(formatRetainedLeaguesLine(summary))}.`,
    "",
    "_The team record above is derived from team fixtures rather than court matches, and the " +
      "predicted lineup below is restricted to this team's own schedule instead — neither is filtered " +
      "by this scope._",
  ].join("\n");
}

/**
 * Spec § Deliverables #1's "predicted lineup honestly labeled a guess", rendered into the dossier
 * itself. The heading says "predicted", the sentence under it says "a guess", and every row carries
 * its own confidence and basis — a table of names with no such framing is the failure mode this
 * whole section is written against, and it would be read as a lineup card in a courtside binder.
 *
 * `lineup === null` prints an explicit absence rather than omitting the section: a missing section
 * is indistinguishable from one nobody added.
 */
function renderPredictedLineupMarkdown(dossier: TeamDossier): string {
  const heading = "## Predicted lineup (a guess)";
  const lineup = dossier.lineup;
  if (lineup === null) {
    return `${heading}\n\n_No court-match history on file for this team, so there is nothing to predict from._`;
  }

  const preamble =
    `_A guess, not a lineup card — inferred from ${lineup.observedCourtMatches} observed court ` +
    `match${lineup.observedCourtMatches === 1 ? "" : "es"} across a roster of ${lineup.rosterSize}._`;

  const rows = lineup.slots.map((slot) => {
    const names =
      slot.players.length === 0
        ? "_(unfilled — roster exhausted)_"
        : slot.players.map((p) => escapeMarkdownCell(p.canonicalName)).join(" / ");
    const evidence =
      slot.basis === "rating"
        ? "placed by rating — no shared history"
        : slot.discipline === "singles"
          ? `${slot.support} singles match${slot.support === 1 ? "" : "es"}`
          : `${slot.support} match${slot.support === 1 ? "" : "es"} together`;
    return `| ${escapeMarkdownCell(slot.slot)} | ${names} | ${slot.confidence} | ${evidence} |`;
  });

  const footnotes = [
    lineup.unplaced.length === 0
      ? null
      : `**Not placed:** ${lineup.unplaced
          .map(
            (p) =>
              `${escapeMarkdownCell(p.canonicalName)} (${p.courtMatches} court match${p.courtMatches === 1 ? "" : "es"})`,
          )
          .join(", ")}`,
    lineup.ratingSource === null
      ? "**Ratings:** none on file — ties fell through to a stable ordering, not to strength."
      : `**Ratings:** ranked within ${escapeMarkdownCell(ratingSourceLabel(lineup.ratingSource))}` +
        (lineup.unranked.length === 0
          ? "."
          : `; unrated: ${lineup.unranked.map((p) => escapeMarkdownCell(p.canonicalName)).join(", ")}.`),
    lineup.slotSource === "event-format"
      ? `**Courts:** ${lineup.slots.length}, from the format of event "${escapeMarkdownCell(lineup.slotEvent.name)}".`
      : `**Courts:** ${lineup.slots.length}, taken from this team's observed match history — not from the event format.`,
    lineup.excludedOtherTeamMatches === 0
      ? null
      : `**Excluded:** ${lineup.excludedOtherTeamMatches} court match` +
        `${lineup.excludedOtherTeamMatches === 1 ? "" : "es"} these players played for other teams.`,
  ].filter((line): line is string => line !== null);

  return [
    heading,
    "",
    preamble,
    "",
    "| Court | Players | Confidence | Based on |",
    "|---|---|---|---|",
    ...rows,
    "",
    footnotes.join("  \n"),
  ].join("\n");
}

function renderPlayerBlockMarkdown(player: PlayerProfile, season: string): string {
  return [
    `### ${escapeMarkdownCell(player.identity.canonicalName)}`,
    "",
    `**${season} record:** singles ${formatRecord(player.singlesRecord.season)}, doubles ${formatRecord(player.doublesRecord.season)}`,
    "",
    `**Court-slot tendencies:** ${formatSlotTendencies(player.slotTendencies)}`,
    "",
    `**Partner frequency:** ${escapeMarkdownCell(formatPartnerFrequency(player.partnerFrequency))}`,
  ].join("\n");
}

function renderPlayersSectionMarkdown(dossier: TeamDossier): string {
  return dossier.players.map((p) => renderPlayerBlockMarkdown(p, dossier.season)).join("\n\n");
}

const DATA_GAP_LABELS: Record<string, string> = {
  events: "events",
  availability: "availability",
  captainNotes: "captain notes",
};

function notCollectedKeys(dossier: TeamDossier): string[] {
  const keys = new Set<string>();
  for (const player of dossier.players) {
    for (const [key, status] of Object.entries(player.dataGaps)) {
      if (status === "not-collected") keys.add(key);
    }
  }
  return Array.from(keys);
}

function renderNotCollectedMarkdown(dossier: TeamDossier): string {
  const keys = notCollectedKeys(dossier);
  if (keys.length === 0) return "";
  const labels = keys.map((k) => DATA_GAP_LABELS[k] ?? k).join(", ");
  return `\n\n## Not collected yet\n\n${labels} — no writer exists anywhere in this codebase yet; this is NOT the same as "zero results".`;
}

export function renderDossierMarkdown(dossier: TeamDossier): string {
  return (
    `# ${escapeMarkdownCell(dossier.team.teamName)} — Scouting Dossier _(dossier — v0 layout)_\n\n` +
    "## Roster\n\n" +
    renderRosterSourceLineMarkdown(dossier) +
    "\n\n" +
    renderRosterTableMarkdown(dossier) +
    "\n\n" +
    renderTeamRecordMarkdown(dossier) +
    renderNotRegisteredSectionMarkdown(dossier) +
    "\n\n" +
    // Placed BEFORE everything it qualifies, not appended as a footnote: a scope that a reader meets
    // only after they have already read the records has not scoped their reading of them.
    renderEvidenceScopeMarkdown(dossier) +
    "\n\n" +
    renderPredictedLineupMarkdown(dossier) +
    "\n\n## Player detail\n\n" +
    renderPlayersSectionMarkdown(dossier) +
    "\n\n" +
    renderPriorMeetingsSectionMarkdown(dossier) +
    renderNotCollectedMarkdown(dossier) +
    "\n"
  );
}
