// Agent/diff-friendly markdown dossier renderer (Task 7) — the twin of `html.ts`, same input shape
// (`TeamDossier`), same content order, same determinism requirement (no clock, no locale-dependent
// formatting). Markdown has no "external reference" concept the way HTML does (no `<script src>`
// to omit), but the renderer still never emits a URL of any kind, for the same self-contained
// spirit `html.ts` is held to.

import type { PlayerProfile } from "../query/player-profile.js";
import type { TeamCrossHeadToHead } from "../query/team-profile.js";
import {
  formatPartnerFrequency,
  formatRatingTrajectory,
  formatRecord,
  formatSlotTendencies,
} from "../cli/format-profile.js";
import type { TeamDossier } from "./types.js";

/**
 * Markdown table cells break on two characters: `|` (the column delimiter itself) and a raw
 * newline (a table row must be exactly one line). A backtick is escaped too — an odd number of
 * unescaped backticks in a cell opens an inline-code span that swallows every `|` after it until
 * the next backtick, which corrupts the table exactly like an unescaped pipe would, just less
 * obviously. Backslash-escaping is CommonMark's own mechanism for "this character, literally" —
 * not a bespoke scheme — so the table survives being re-parsed by any standard renderer, not just
 * displayed as raw text.
 */
export function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "\\`").replace(/\r?\n/g, " ");
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

function renderPriorMeetingsMarkdown(player: PlayerProfile, headToHead: TeamCrossHeadToHead[] | null): string {
  if (headToHead === null) {
    return "_Prior meetings vs our players: not available in this build (no home team configured)._";
  }
  const rows = headToHead.filter((h) => h.playerId === player.identity.playerId);
  if (rows.length === 0) return "Prior meetings vs our players: none on file.";
  const items = rows.map((h) => `- vs player #${h.opponentId}: ${formatHeadToHead(h)} (${h.matches} matches)`);
  return ["**Prior meetings vs our players:**", ...items].join("\n");
}

function renderPlayerBlockMarkdown(player: PlayerProfile, headToHead: TeamCrossHeadToHead[] | null): string {
  return [
    `### ${player.identity.canonicalName}`,
    "",
    `**6-month record:** singles ${formatRecord(player.singlesRecord.sixMonth)}, doubles ${formatRecord(player.doublesRecord.sixMonth)}`,
    "",
    `**Court-slot tendencies:** ${formatSlotTendencies(player.slotTendencies)}`,
    "",
    `**Partner frequency:** ${formatPartnerFrequency(player.partnerFrequency)}`,
    "",
    renderPriorMeetingsMarkdown(player, headToHead),
  ].join("\n");
}

function renderPlayersSectionMarkdown(dossier: TeamDossier): string {
  return dossier.players.map((p) => renderPlayerBlockMarkdown(p, dossier.team.headToHead)).join("\n\n");
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
    `# ${dossier.team.teamName} — Scouting Dossier _(dossier — v0 layout)_\n\n` +
    "## Roster\n\n" +
    renderRosterTableMarkdown(dossier) +
    "\n\n" +
    renderTeamRecordMarkdown(dossier) +
    "\n\n## Player detail\n\n" +
    renderPlayersSectionMarkdown(dossier) +
    renderNotCollectedMarkdown(dossier) +
    "\n"
  );
}
