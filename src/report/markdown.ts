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
 */
export function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/[|`<>[\]_*]/g, (ch) => `\\${ch}`)
    .replace(/\r?\n/g, " ");
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
 * dossier.
 */
function renderPriorMeetingsSectionMarkdown(dossier: TeamDossier): string {
  const headToHead = dossier.team.headToHead;
  const body =
    headToHead === null
      ? "_Not available in this build (no home team configured)._"
      : dossier.players.map((p) => renderPlayerPriorMeetingsRowMarkdown(p, headToHead)).join("\n\n");
  return `## Prior meetings vs our players\n\n${body}`;
}

function renderPlayerBlockMarkdown(player: PlayerProfile): string {
  return [
    `### ${escapeMarkdownCell(player.identity.canonicalName)}`,
    "",
    `**6-month record:** singles ${formatRecord(player.singlesRecord.sixMonth)}, doubles ${formatRecord(player.doublesRecord.sixMonth)}`,
    "",
    `**Court-slot tendencies:** ${formatSlotTendencies(player.slotTendencies)}`,
    "",
    `**Partner frequency:** ${escapeMarkdownCell(formatPartnerFrequency(player.partnerFrequency))}`,
  ].join("\n");
}

function renderPlayersSectionMarkdown(dossier: TeamDossier): string {
  return dossier.players.map((p) => renderPlayerBlockMarkdown(p)).join("\n\n");
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
    renderRosterTableMarkdown(dossier) +
    "\n\n" +
    renderTeamRecordMarkdown(dossier) +
    "\n\n## Player detail\n\n" +
    renderPlayersSectionMarkdown(dossier) +
    "\n\n" +
    renderPriorMeetingsSectionMarkdown(dossier) +
    renderNotCollectedMarkdown(dossier) +
    "\n"
  );
}
