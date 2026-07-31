// Self-contained HTML dossier renderer (Task 7). "Self-contained" is a hard requirement (spec §
// Reports: "self-contained print-optimized HTML (primary)") — everything the browser needs
// (styling, layout) is inlined, and NOTHING here fetches anything: no CDN, no webfont, no remote
// image, no `<script src>`, no `<link rel="stylesheet">`, no `@import`. `escapeHtml` is owned
// locally rather than pulled from an npm package — `src/cli/args.ts`'s existing comment records
// this codebase's standing "no new deps" judgment, and this module is the same call for the same
// reason.
//
// Deterministic on purpose (spec § Reports: "deterministic rendering from DB state"): no
// `Date.now()`, no clock, no locale-dependent formatting anywhere below. Every value comes from the
// `TeamDossier` passed in, so two calls with the same dossier byte-for-byte produce the same string.
//
// The layout is EXPLICITLY labeled v0 in the rendered output (see the `<span class="v0-badge">`
// below) — this is a first real answer to #13's "what does Randy want on one page per opponent",
// not a settled design.

import type { PlayerProfile } from "../query/player-profile.js";
import type { TeamCrossHeadToHead } from "../query/team-profile.js";
import {
  formatPartnerFrequency,
  formatRatingTrajectory,
  formatRecord,
  formatSlotTendencies,
} from "../cli/format-profile.js";
import type { TeamDossier } from "./types.js";

/** The five XML-significant characters, escaped to their named entities. Order matters: `&` FIRST,
 * or an entity written by an earlier replacement (e.g. `&lt;`) would itself get re-escaped by a
 * later `&` -> `&amp;` pass. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRosterTableHtml(dossier: TeamDossier): string {
  const rows = dossier.players
    .map((p) => {
      const ratings = formatRatingTrajectory(p.ratingTrajectory);
      return (
        "<tr>" +
        `<td>${escapeHtml(p.identity.canonicalName)}</td>` +
        `<td>${escapeHtml(p.identity.ageRange ?? "unknown")}</td>` +
        `<td>${escapeHtml(ratings)}</td>` +
        "</tr>"
      );
    })
    .join("");
  return (
    "<table class=\"roster\">" +
    "<thead><tr><th>Player</th><th>Age range</th><th>Ratings (NTRP · WTN S/D · TR dynamic)</th></tr></thead>" +
    `<tbody>${rows}</tbody>` +
    "</table>"
  );
}

function renderTeamRecordHtml(dossier: TeamDossier): string {
  return (
    `<p><strong>Team record:</strong> ${escapeHtml(formatRecord(dossier.team.teamRecord))}` +
    ` &nbsp; <strong>Slots:</strong> ${escapeHtml(formatSlotTendencies(dossier.team.slotTendencies))}</p>`
  );
}

/** Head-to-head rows for one player, filtered from the team's cross-pair list — an opponent id with
 * no canonical name on hand (Task 4/#32's knowingly-deferred identity-perf tradeoff means the
 * dossier assembly does not resolve every opponent id to a name) falls back to `player #<id>`, the
 * same convention `player-profile.ts` already uses for an unresolved partner id. */
/** `TeamCrossHeadToHead` carries `wins`/`losses`/`undecided`/`matches` but not `excludedUndated` —
 * unlike `windowedRecord`, `headToHead` (derive.ts) never excludes a row, it just counts it, so
 * there is nothing for that field to mean here. `formatRecord` therefore does not apply; this is
 * the same `wins-losses (N undecided)` shape, spelled out locally instead of loosening
 * `formatRecord`'s type to paper over the mismatch. */
function formatHeadToHead(h: TeamCrossHeadToHead): string {
  const base = `${h.wins}-${h.losses}`;
  return h.undecided > 0 ? `${base} (${h.undecided} undecided)` : base;
}

function renderPriorMeetingsHtml(player: PlayerProfile, headToHead: TeamCrossHeadToHead[] | null): string {
  if (headToHead === null) {
    return "<p><em>Prior meetings vs our players: not available in this build (no home team configured).</em></p>";
  }
  const rows = headToHead.filter((h) => h.playerId === player.identity.playerId);
  if (rows.length === 0) {
    return "<p>Prior meetings vs our players: none on file.</p>";
  }
  const items = rows
    .map((h) => `<li>vs player #${h.opponentId}: ${escapeHtml(formatHeadToHead(h))} (${h.matches} matches)</li>`)
    .join("");
  return `<div><strong>Prior meetings vs our players:</strong><ul>${items}</ul></div>`;
}

/** One player's full detail block — everything about a single player stays together on the page
 * (`page-break-inside: avoid`, in the inlined stylesheet), so a printed binder never splits one
 * player's record across a page break. Content order follows spec § Deliverables #1: 6-month
 * singles/doubles records, then court-slot tendencies, then partner frequency, then prior meetings. */
function renderPlayerBlockHtml(player: PlayerProfile, headToHead: TeamCrossHeadToHead[] | null): string {
  return (
    '<div class="player-block">' +
    `<h3>${escapeHtml(player.identity.canonicalName)}</h3>` +
    `<p><strong>6-month record:</strong> singles ${escapeHtml(formatRecord(player.singlesRecord.sixMonth))},` +
    ` doubles ${escapeHtml(formatRecord(player.doublesRecord.sixMonth))}</p>` +
    `<p><strong>Court-slot tendencies:</strong> ${escapeHtml(formatSlotTendencies(player.slotTendencies))}</p>` +
    `<p><strong>Partner frequency:</strong> ${escapeHtml(formatPartnerFrequency(player.partnerFrequency))}</p>` +
    renderPriorMeetingsHtml(player, headToHead) +
    "</div>"
  );
}

function renderPlayersSectionHtml(dossier: TeamDossier): string {
  return dossier.players.map((p) => renderPlayerBlockHtml(p, dossier.team.headToHead)).join("");
}

// The three sections with no writer ANYWHERE in the codebase (docs/findings.md, #15) — same labels
// `src/cli/format-profile.ts` uses for the CLI's compact text, kept in sync deliberately rather than
// re-deriving a second label map here.
const DATA_GAP_LABELS: Record<string, string> = {
  events: "events",
  availability: "availability",
  captainNotes: "captain notes",
};

/**
 * The union of "not-collected" keys across every player in the dossier — in this codebase every
 * player reports the SAME three keys (no writer exists at all for `events`/`availability`/
 * `captain_notes`), but a hand-built test profile can legitimately report none, and the block must
 * genuinely disappear in that case rather than always rendering (Task 3 rule 6's "distinct from
 * zero results" made visible at the presenter layer too).
 */
function notCollectedKeys(dossier: TeamDossier): string[] {
  const keys = new Set<string>();
  for (const player of dossier.players) {
    for (const [key, status] of Object.entries(player.dataGaps)) {
      if (status === "not-collected") keys.add(key);
    }
  }
  return Array.from(keys);
}

function renderNotCollectedHtml(dossier: TeamDossier): string {
  const keys = notCollectedKeys(dossier);
  if (keys.length === 0) return "";
  const labels = keys.map((k) => escapeHtml(DATA_GAP_LABELS[k] ?? k)).join(", ");
  return (
    '<section id="not-collected"><h2>Not collected yet</h2>' +
    `<p>${labels} — no writer exists anywhere in this codebase yet; this is NOT the same as "zero results".</p>` +
    "</section>"
  );
}

// Inlined once, verbatim, into every rendered document — no `<link>`, so no external request.
// Print rules sized for a courtside binder (letter paper, half-inch margins) per the plan.
const STYLE = `
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; margin: 1.5rem; color: #111; }
  h1 { font-size: 1.4rem; }
  .v0-badge { font-size: 0.7rem; font-weight: normal; color: #666; border: 1px solid #999; border-radius: 3px; padding: 0.1rem 0.4rem; margin-left: 0.5rem; }
  table.roster { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; }
  table.roster th, table.roster td { border: 1px solid #ccc; padding: 0.25rem 0.5rem; text-align: left; font-size: 0.9rem; }
  .player-block { border-top: 1px solid #ddd; padding: 0.5rem 0; page-break-inside: avoid; }
  @media print {
    body { margin: 0; }
    .player-block { page-break-inside: avoid; }
  }
  @page { size: letter; margin: 0.5in; }
`;

/** The full self-contained document: everything a browser or print pipeline needs is inlined. */
export function renderDossier(dossier: TeamDossier): string {
  return (
    "<!doctype html>" +
    '<html lang="en">' +
    "<head>" +
    '<meta charset="utf-8">' +
    `<title>${escapeHtml(dossier.team.teamName)} — Scouting Dossier</title>` +
    `<style>${STYLE}</style>` +
    "</head>" +
    "<body>" +
    `<h1>${escapeHtml(dossier.team.teamName)} <span class="v0-badge">dossier — v0 layout</span></h1>` +
    '<section id="roster"><h2>Roster</h2>' +
    renderRosterTableHtml(dossier) +
    renderTeamRecordHtml(dossier) +
    "</section>" +
    '<section id="players"><h2>Player detail</h2>' +
    renderPlayersSectionHtml(dossier) +
    "</section>" +
    renderNotCollectedHtml(dossier) +
    "</body>" +
    "</html>"
  );
}
