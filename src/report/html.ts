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
 * The five XML-significant characters, escaped to their named entities. Order matters: `&` FIRST,
 * or an entity written by an earlier replacement (e.g. `&lt;`) would itself get re-escaped by a
 * later `&` -> `&amp;` pass.
 *
 * `sanitizeValue` runs first, for the reason its markdown twin records: entity-escaping markup says
 * nothing about control, format, or line-separator characters, so a RIGHT-TO-LEFT OVERRIDE inside a
 * scraped name survives it and visually reorders the rendered dossier — in a document that gets
 * printed and carried to a court, where the reader cannot check it against the source.
 * (Found by the independent Codex review of PR #47, rated medium.)
 */
export function escapeHtml(value: string): string {
  return sanitizeValue(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The roster-source disclosure line (#113) — the twin of `renderEvidenceScopeHtml`'s precedent,
 * one field over. **Always rendered, both branches** (#97's discipline). */
function renderRosterSourceLineHtml(dossier: TeamDossier): string {
  const line = formatRosterSourceLine(
    dossier.rosterSource,
    dossier.event?.name ?? null,
    dossier.team.registeredCount,
    dossier.team.seasonCount,
  );
  return `<p><strong>Roster:</strong> ${escapeHtml(line)}.</p>`;
}

/** The NOT REGISTERED block (#113) — the twin of `renderNotRegisteredSectionMarkdown`. Renders
 * nothing when `dossier.team.absentRoster` is empty (see that function's own doc comment for why an
 * empty list is never rendered as an empty section). */
function renderNotRegisteredSectionHtml(dossier: TeamDossier): string {
  const absent = dossier.team.absentRoster;
  if (absent.length === 0) return "";
  const source = dossier.team.absentRatingSource;
  const sourceNote =
    source === null ? "no ratings on file for anyone below" : `ratings shown: ${escapeHtml(ratingSourceLabel(source))}`;
  const items = absent.map((m) => `<li>${escapeHtml(formatAbsentRosterMember(m, source))}</li>`).join("");
  return (
    '<section id="not-registered"><h2>Not registered (watch for adds)</h2>' +
    `<p class="guess-note">Name and rating only, ${sourceNote} — no record, no tendencies; a late ` +
    "add should be recognised, not scouted.</p>" +
    `<ul>${items}</ul>` +
    "</section>"
  );
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

/** #97's non-optional disclosure — the twin of `renderEvidenceScopeMarkdown`, and the two must stay
 * in step or the printed and the readable dossier disagree about what their numbers cover. See that
 * function's doc comment for why the section is always rendered (even unscoped) and why its closing
 * sentence names what the scope does NOT govern. */
function renderEvidenceScopeHtml(dossier: TeamDossier): string {
  const summary = dossier.team.evidenceScope;
  const eventName = dossier.event?.name ?? null;
  return (
    '<section id="evidence-scope"><h2>Evidence scope</h2>' +
    "<p><strong>Records and court-slot tendencies below were computed over:</strong> " +
    `${escapeHtml(formatEvidenceScopeLine(summary, eventName))}.</p>` +
    `<p><strong>Leagues counted:</strong> ${escapeHtml(formatRetainedLeaguesLine(summary))}.</p>` +
    '<p class="guess-note">The team record above is derived from team fixtures rather than court ' +
    "matches, and the predicted lineup below is restricted to this team&#39;s own schedule instead — " +
    "neither is filtered by this scope. Prior meetings below draws on the same leagues but every " +
    "date on file, not the 12-month window above.</p>" +
    "</section>"
  );
}

/** `TeamCrossHeadToHead` carries `wins`/`losses`/`undecided`/`matches` but not `excludedUndated` —
 * unlike `windowedRecord`, `headToHead` (derive.ts) never excludes a row, it just counts it, so
 * there is nothing for that field to mean here. `formatRecord` therefore does not apply; this is
 * the same `wins-losses (N undecided)` shape, spelled out locally instead of loosening
 * `formatRecord`'s type to paper over the mismatch. */
function formatHeadToHead(h: TeamCrossHeadToHead): string {
  const base = `${h.wins}-${h.losses}`;
  return h.undecided > 0 ? `${base} (${h.undecided} undecided)` : base;
}

/** One player's row within the dedicated prior-meetings section (see `renderPriorMeetingsSectionHtml`
 * below) — `headToHead` is never null here, that case is handled once for the whole dossier by the
 * caller before this is reached. */
function renderPlayerPriorMeetingsRowHtml(player: PlayerProfile, headToHead: TeamCrossHeadToHead[]): string {
  const rows = headToHead.filter((h) => h.playerId === player.identity.playerId);
  const name = escapeHtml(player.identity.canonicalName);
  if (rows.length === 0) {
    return `<p><strong>${name}</strong> — Prior meetings vs our players: none on file.</p>`;
  }
  const items = rows
    .map(
      (h) =>
        `<li>vs ${escapeHtml(h.opponentName)}: ${escapeHtml(formatHeadToHead(h))} (${h.matches} matches)</li>`,
    )
    .join("");
  return `<div><strong>${name}</strong> — Prior meetings vs our players:<ul>${items}</ul></div>`;
}

/**
 * One dedicated section for the whole dossier, rendered ONCE — not once per player block. The
 * unavailable line does not depend on which player it is about, so repeating it per player only
 * repeated the same sentence N times for an N-player dossier; when head-to-head data IS available
 * it genuinely differs per player, so this section still breaks it out by player, just gathered in
 * one place rather than scattered through `renderPlayersSectionHtml`.
 *
 * #19: `headToHead` is null for TWO distinct reasons — `write.ts`'s `versusTeamId` is `undefined`
 * both when no home team is designated at all AND when the team being rendered IS the home team
 * (a dossier does not compare a roster against itself). One sentence covered both, so the home
 * team's own dossier announced "no home team configured" moments after `tn team home` had
 * succeeded — accurate for one case, plainly false for the other, and read courtside as evidence
 * that the designation had not taken. `TeamProfile.isHome` (src/query/team-profile.ts) already
 * distinguishes them, and the two conditions are exhaustive: `versusTeamId` is `undefined` iff
 * there is no home team or this team is it.
 *
 * Issue #122, Task 7's explicit exemption: this section is NOT filtered by the page's 12-month
 * window, unlike the records and tendencies above it — a prior meeting is evidence about an
 * opponent regardless of when it happened. The heading says so.
 */
function renderPriorMeetingsSectionHtml(dossier: TeamDossier): string {
  const headToHead = dossier.team.headToHead;
  const unavailable = dossier.team.isHome
    ? "<p><em>Not available on our own team&#39;s dossier — this section compares an opponent&#39;s roster against ours.</em></p>"
    : "<p><em>Not available in this build (no home team configured).</em></p>";
  const body =
    headToHead === null
      ? unavailable
      : dossier.players.map((p) => renderPlayerPriorMeetingsRowHtml(p, headToHead)).join("");
  return `<section id="prior-meetings"><h2>Prior meetings vs our players (all meetings on file)</h2>${body}</section>`;
}

/** One player's full detail block — everything about a single player stays together on the page
 * (`page-break-inside: avoid`, in the inlined stylesheet), so a printed binder never splits one
 * player's record across a page break. Content order follows spec § Deliverables #1: windowed
 * singles/doubles records, then court-slot tendencies, then partner frequency. Prior meetings is
 * NOT repeated here — it renders once for the whole dossier, in its own section
 * (`renderPriorMeetingsSectionHtml`). */
function renderPlayerBlockHtml(player: PlayerProfile, windowLabel: string): string {
  return (
    '<div class="player-block">' +
    `<h3>${escapeHtml(player.identity.canonicalName)}</h3>` +
    `<p><strong>Record (${escapeHtml(windowLabel)}):</strong> singles ${escapeHtml(formatRecord(player.singlesRecord.windowed))},` +
    ` doubles ${escapeHtml(formatRecord(player.doublesRecord.windowed))}</p>` +
    `<p><strong>Court-slot tendencies:</strong> ${escapeHtml(formatSlotTendencies(player.slotTendencies))}</p>` +
    `<p><strong>Partner frequency:</strong> ${escapeHtml(formatPartnerFrequency(player.partnerFrequency))}</p>` +
    "</div>"
  );
}

function renderPlayersSectionHtml(dossier: TeamDossier): string {
  return dossier.players.map((p) => renderPlayerBlockHtml(p, dossier.window)).join("");
}

// Labels for the three `dataGaps` sections — same ones `src/cli/format-profile.ts` uses for the
// CLI's compact text, kept in sync deliberately rather than re-deriving a second label map here.
// (`availability` and `captain_notes` gained writers in #17 PR A; `events` still has none that
// associates a PLAYER with an event, so it remains the one standing "not collected" section — see
// the `dataGaps` comment in src/query/player-profile.ts.)
const DATA_GAP_LABELS: Record<string, string> = {
  events: "events",
  availability: "availability",
  captainNotes: "captain notes",
};

/**
 * The markdown twin's counterpart — spec § Deliverables #1's "predicted lineup honestly labeled a
 * guess", in the dossier itself. Same content, same order, same framing discipline: the heading and
 * the lede both say "guess", every row carries confidence and what it rests on, and the provenance
 * footnotes name the rating scale and where the court list came from. This document is printed and
 * carried to a court, so an unhedged table of names is the exact failure to avoid.
 *
 * `lineup === null` renders the absence explicitly rather than omitting the section.
 */
function renderPredictedLineupHtml(dossier: TeamDossier): string {
  const open = '<section id="predicted-lineup"><h2>Predicted lineup (a guess)</h2>';
  const lineup = dossier.lineup;
  if (lineup === null) {
    return (
      open +
      "<p>No court-match history on file for this team, so there is nothing to predict from.</p>" +
      "</section>"
    );
  }

  const matches = `${lineup.observedCourtMatches} observed court match${lineup.observedCourtMatches === 1 ? "" : "es"}`;
  const rows = lineup.slots
    .map((slot) => {
      const names =
        slot.players.length === 0
          ? "<em>(unfilled — roster exhausted)</em>"
          : slot.players.map((p) => escapeHtml(p.canonicalName)).join(" / ");
      const evidence =
        slot.basis === "rating"
          ? "placed by rating — no shared history"
          : slot.discipline === "singles"
            ? `${slot.support} singles match${slot.support === 1 ? "" : "es"}`
            : `${slot.support} match${slot.support === 1 ? "" : "es"} together`;
      return (
        `<tr><td>${escapeHtml(slot.slot)}</td><td>${names}</td>` +
        `<td>${escapeHtml(slot.confidence)}</td><td>${escapeHtml(evidence)}</td></tr>`
      );
    })
    .join("");

  const footnotes: string[] = [];
  if (lineup.unplaced.length > 0) {
    const listed = lineup.unplaced
      .map(
        (p) =>
          `${escapeHtml(p.canonicalName)} (${p.courtMatches} court match${p.courtMatches === 1 ? "" : "es"})`,
      )
      .join(", ");
    footnotes.push(`<strong>Not placed:</strong> ${listed}`);
  }
  footnotes.push(
    lineup.ratingSource === null
      ? "<strong>Ratings:</strong> none on file — ties fell through to a stable ordering, not to strength."
      : `<strong>Ratings:</strong> ranked within ${escapeHtml(ratingSourceLabel(lineup.ratingSource))}` +
        (lineup.unranked.length === 0
          ? "."
          : `; unrated: ${lineup.unranked.map((p) => escapeHtml(p.canonicalName)).join(", ")}.`),
  );
  footnotes.push(
    lineup.slotSource === "event-format"
      ? `<strong>Courts:</strong> ${lineup.slots.length}, from the format of event "${escapeHtml(lineup.slotEvent.name)}".`
      : `<strong>Courts:</strong> ${lineup.slots.length}, taken from this team's observed match history — ` +
          "not from the event format.",
  );
  if (lineup.excludedOtherTeamMatches > 0) {
    footnotes.push(
      `<strong>Excluded:</strong> ${lineup.excludedOtherTeamMatches} court match` +
        `${lineup.excludedOtherTeamMatches === 1 ? "" : "es"} these players played for other teams.`,
    );
  }

  return (
    open +
    `<p class="guess-note">A guess, not a lineup card — inferred from ${matches} across a roster of ` +
    `${lineup.rosterSize}.</p>` +
    '<table class="roster"><thead><tr><th>Court</th><th>Players</th><th>Confidence</th>' +
    "<th>Based on</th></tr></thead><tbody>" +
    rows +
    "</tbody></table>" +
    footnotes.map((f) => `<p>${f}</p>`).join("") +
    "</section>"
  );
}

/**
 * The union of "not-collected" keys across every player in the dossier. In production that is
 * currently exactly one key — `events` — because `availability` and `captain_notes` gained writers
 * in #17 PR A while nothing yet writes a player-to-event association (see the `dataGaps` comment in
 * `src/query/player-profile.ts`). The block must still genuinely disappear when the set is empty
 * rather than always rendering, and a hand-built test profile can report any combination
 * (Task 3 rule 6's "distinct from zero results", made visible at the presenter layer too).
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

/** The markdown twin's `UNRECORDED_DAY`. Kept identical so the printed binder and the screen agree
 * on what "we never asked" looks like. */
const UNRECORDED_DAY = "—";

function noteDayHtml(createdAt: string): string {
  return escapeHtml(createdAt.slice(0, 10));
}

/**
 * #126 — the HTML twin of `renderOwnTeamBookMarkdown`. See that function for why the three absent
 * states (not our team / no event named / nothing recorded) must read as three different sentences.
 *
 * Every interpolation here goes through `escapeHtml`: captain notes are arbitrary operator text and
 * the availability grid renders names from a different source than the roster table above it, so
 * neither can borrow that table's escaping.
 */
function renderOwnTeamBookHtml(dossier: TeamDossier): string {
  const book = dossier.ownTeam;
  if (book === null) return "";

  let availability: string;
  if (book.availability === null) {
    availability =
      "<p><em>No event named for this build, so there is no day range to report availability over." +
      " Re-run naming the event to see the grid.</em></p>";
  } else if (book.availability.days.length === 0) {
    // See the markdown twin: a named event whose `starts_on`/`ends_on` are null. HTML tolerates a
    // zero-column table better than markdown does, but an empty grid still reads as "nobody is
    // available" rather than "this event has no dates", so both renderers say the same thing.
    availability =
      "<p><em>This event has no date range on file, so there are no days to report availability over." +
      " Set its start and end dates (<code>tn event add</code>) and rebuild.</em></p>";
  } else if (book.availability.players.length === 0) {
    availability = "<p><em>None recorded.</em> Use <code>tn player avail</code> to record who can play which day.</p>";
  } else {
    const { days, players } = book.availability;
    availability =
      '<table class="roster"><thead><tr><th>Player</th>' +
      days.map((d) => `<th>${escapeHtml(d)}</th>`).join("") +
      "</tr></thead><tbody>" +
      players
        .map(
          (p) =>
            `<tr><td>${escapeHtml(p.canonicalName)}</td>` +
            p.days.map((d) => `<td>${escapeHtml(d.status ?? UNRECORDED_DAY)}</td>`).join("") +
            "</tr>",
        )
        .join("") +
      "</tbody></table>" +
      `<p class="guess-note"><code>${UNRECORDED_DAY}</code> means <strong>not recorded</strong> —` +
      " which is not the same as unavailable.</p>";
  }

  const playerNotes =
    book.notes.player.length === 0
      ? "<p><em>None recorded.</em> Use <code>tn player note</code> to add one.</p>"
      : "<ul>" +
        book.notes.player
          .map(
            (n) =>
              `<li><strong>${escapeHtml(n.canonicalName)}</strong> — ${escapeHtml(n.note)}` +
              ` <em>(${noteDayHtml(n.createdAt)})</em></li>`,
          )
          .join("") +
        "</ul>";

  // Own block, not repeated under each partner — see the markdown twin.
  const pairingNotes =
    book.notes.pairing.length === 0
      ? "<p><em>None recorded.</em></p>"
      : "<ul>" +
        book.notes.pairing
          .map(
            (n) =>
              `<li><strong>${escapeHtml(n.canonicalName)} + ${escapeHtml(n.pairCanonicalName)}</strong> —` +
              ` ${escapeHtml(n.note)} <em>(${noteDayHtml(n.createdAt)})</em></li>`,
          )
          .join("") +
        "</ul>";

  return (
    '<section id="own-team-book"><h2>Own-team book</h2>' +
    '<p class="guess-note">The captain\'s layer — availability and notes. Recorded for our team only, by design.</p>' +
    "<h3>Availability</h3>" +
    availability +
    "<h3>Captain notes</h3>" +
    playerNotes +
    "<h3>Pairing notes</h3>" +
    pairingNotes +
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
  .guess-note { font-style: italic; color: #555; }
  #predicted-lineup { page-break-inside: avoid; }
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
    renderRosterSourceLineHtml(dossier) +
    renderRosterTableHtml(dossier) +
    renderTeamRecordHtml(dossier) +
    "</section>" +
    renderNotRegisteredSectionHtml(dossier) +
    // Placed BEFORE everything it qualifies — see the markdown twin's comment.
    renderEvidenceScopeHtml(dossier) +
    renderPredictedLineupHtml(dossier) +
    // #126: same position as the markdown twin — the guess, then who is actually there, then the
    // per-player detail.
    renderOwnTeamBookHtml(dossier) +
    '<section id="players"><h2>Player detail</h2>' +
    renderPlayersSectionHtml(dossier) +
    "</section>" +
    renderPriorMeetingsSectionHtml(dossier) +
    renderNotCollectedHtml(dossier) +
    "</body>" +
    "</html>"
  );
}
