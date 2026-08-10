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
 *
 * Issue #122, Task 7's explicit exemption: unlike the records and tendencies above it, this section
 * is NOT filtered by the page's 12-month window — a prior meeting is evidence about an opponent
 * regardless of when it happened. The heading says so, so a reader comparing this section's count
 * against the windowed sections above it is not left to guess why they differ.
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
  return `## Prior meetings vs our players (all meetings on file)\n\n${body}`;
}

/**
 * #97's non-optional disclosure: what the records and court-slot tendencies in this dossier were
 * actually computed over. Rendered as its own section, ALWAYS — an unscoped dossier says so as
 * plainly as a scoped one does, because a reader who cannot tell those two apart is back at the
 * defect this issue was opened for.
 *
 * The closing sentence is what keeps the section from over-claiming, and it is the reason this is a
 * section rather than a footnote. The league scope named above does not govern everything on the
 * page: the team record is derived from `team_matches` and carries no league context at all, the
 * predicted lineup is scoped by something stronger and different (this team's own schedule — see
 * `getLineupPlan`), and prior meetings below draws on the same leagues but is NOT limited to the
 * 12-month window this section's records are (issue #122, Task 7 — see that section's own heading).
 * Printing a scope immediately above sections it does not fully govern, without saying so, would be
 * a new silent lie of the same shape as the one being fixed.
 */
function renderEvidenceScopeMarkdown(dossier: TeamDossier): string {
  const summary = dossier.team.evidenceScope;
  const eventName = dossier.event?.name ?? null;
  return [
    "## Evidence scope",
    "",
    `**Records and court-slot tendencies below were computed over:** ` +
      `${escapeMarkdownCell(formatEvidenceScopeLine(summary, eventName))}.`,
    "",
    `**Leagues counted:** ${escapeMarkdownCell(formatRetainedLeaguesLine(summary))}.`,
    "",
    "_The team record above is derived from team fixtures rather than court matches, and the " +
      "predicted lineup below is restricted to this team's own schedule instead — neither is filtered " +
      "by this scope. Prior meetings below draws on the same leagues but every date on file, not the " +
      "12-month window above._",
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

function renderPlayerBlockMarkdown(player: PlayerProfile, windowLabel: string): string {
  return [
    `### ${escapeMarkdownCell(player.identity.canonicalName)}`,
    "",
    `**Record (${windowLabel}):** singles ${formatRecord(player.singlesRecord.windowed)}, doubles ${formatRecord(player.doublesRecord.windowed)}`,
    "",
    `**Court-slot tendencies:** ${formatSlotTendencies(player.slotTendencies)}`,
    "",
    `**Partner frequency:** ${escapeMarkdownCell(formatPartnerFrequency(player.partnerFrequency))}`,
  ].join("\n");
}

function renderPlayersSectionMarkdown(dossier: TeamDossier): string {
  return dossier.players.map((p) => renderPlayerBlockMarkdown(p, dossier.window)).join("\n\n");
}

/** What a day with no recorded answer prints. Deliberately NOT a blank cell: an empty cell in a
 * printed grid reads as an oversight, where a glyph reads as a recorded absence of an answer. */
const UNRECORDED_DAY = "—";

/** `2026-08-09T00:00:00.000Z` → `2026-08-09`. The binder is read at a tennis court; the time of day
 * a note was typed is noise. */
function noteDay(createdAt: string): string {
  return createdAt.slice(0, 10);
}

/**
 * #126, spec § Deliverables #2 — the own-team book: availability and captain notes, on OUR dossier
 * only. Returns "" for every opponent, which is what `ownTeam: null` means.
 *
 * Three absences are rendered as three DIFFERENT sentences, because they call for different actions
 * and collapsing them is the whole failure mode this section exists to avoid:
 *   - no book at all  → nothing (not our team; their availability is not ours to record)
 *   - no event named  → say so (there is no day range to grid over — NOT "nobody is available")
 *   - book is empty   → "none recorded" (a writer exists and the captain has not used it yet)
 *
 * That last sentence must not be confused with the `## Not collected yet` section below, which
 * means "no writer exists anywhere in this codebase" — true of these two tables until #17 PR A, and
 * false ever since.
 */
function renderOwnTeamBookMarkdown(dossier: TeamDossier): string {
  const book = dossier.ownTeam;
  if (book === null) return "";

  const lines: string[] = [
    "\n\n## Own-team book",
    "",
    "_The captain's layer — availability and notes. Recorded for our team only, by design._",
    "",
    "### Availability",
    "",
  ];

  if (book.availability === null) {
    lines.push(
      "_No event named for this build, so there is no day range to report availability over._" +
        " Re-run naming the event to see the grid.",
    );
  } else if (book.availability.days.length === 0) {
    // A named event with no `starts_on`/`ends_on` on file. Both columns are NULLABLE
    // (src/db/schema.ts) and `eventsForDay` already guards for it — the `events` table predates its
    // only writer (`addEvent`, #17 PR B), so undated rows are representable. Without this branch the
    // grid below emits a header with one cell more than its divider, which is not a table at all: the
    // whole block renders as literal pipes on the printed page.
    lines.push(
      "_This event has no date range on file, so there are no days to report availability over._" +
        " Set its start and end dates (`tn event add`) and rebuild.",
    );
  } else if (book.availability.players.length === 0) {
    lines.push("_None recorded._ Use `tn player avail` to record who can play which day.");
  } else {
    const { days, players } = book.availability;
    // Columns come from the EVENT's day range (see `getAvailabilityForEvent`), so a day nobody has
    // answered for still gets a column full of `—` rather than vanishing from the page.
    lines.push(
      `| Player | ${days.map((d) => escapeMarkdownCell(d)).join(" | ")} |`,
      `|---|${days.map(() => "---|").join("")}`,
      ...players.map(
        (p) =>
          `| ${escapeMarkdownCell(p.canonicalName)} | ` +
          p.days.map((d) => escapeMarkdownCell(d.status ?? UNRECORDED_DAY)).join(" | ") +
          " |",
      ),
      "",
      `_\`${UNRECORDED_DAY}\` means **not recorded** — which is not the same as unavailable._`,
    );
  }

  lines.push("", "### Captain notes", "");
  if (book.notes.player.length === 0) {
    lines.push("_None recorded._ Use `tn player note` to add one.");
  } else {
    lines.push(
      ...book.notes.player.map(
        (n) => `- **${escapeMarkdownCell(n.canonicalName)}** — ${escapeMarkdownCell(n.note)} _(${noteDay(n.createdAt)})_`,
      ),
    );
  }

  // Pairing notes get their OWN block rather than appearing under each partner: the note is one
  // observation about the two of them together, and printing it twice would read as two.
  lines.push("", "### Pairing notes", "");
  if (book.notes.pairing.length === 0) {
    lines.push("_None recorded._");
  } else {
    lines.push(
      ...book.notes.pairing.map(
        (n) =>
          `- **${escapeMarkdownCell(n.canonicalName)} + ${escapeMarkdownCell(n.pairCanonicalName)}** —` +
          ` ${escapeMarkdownCell(n.note)} _(${noteDay(n.createdAt)})_`,
      ),
    );
  }

  return lines.join("\n");
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
    // #126: between the predicted lineup and the per-player detail — the captain reads the guess,
    // then who is actually there, then the individual write-ups.
    renderOwnTeamBookMarkdown(dossier) +
    "\n\n## Player detail\n\n" +
    renderPlayersSectionMarkdown(dossier) +
    "\n\n" +
    renderPriorMeetingsSectionMarkdown(dossier) +
    renderNotCollectedMarkdown(dossier) +
    "\n"
  );
}
