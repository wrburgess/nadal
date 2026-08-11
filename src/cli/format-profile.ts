// Compact human-readable formatting shared by `player show` and `team show`'s non-`--json` output
// (spec § Interfaces: `player show` is "full profile: ratings trajectory, history, records"). Kept
// separate from `src/report/*.ts` (Task 7): the CLI's terse one-call-to-console.log form and the
// self-contained HTML/markdown dossier are different presenters over the same `src/query/` shapes,
// each with its own escaping/layout rules — reusing THIS module for the report renderers would
// couple two audiences (a terminal, a printed binder) that should stay free to diverge.

import { sanitizeValue } from "../sanitize.js";
import { leagueScopeLabel } from "../query/league-scope.js";
import type { AbsentRosterMember } from "../query/team-profile.js";
import type {
  DataGapsResult,
  EvidenceScopeSummary,
  PartnerFrequencyEntry,
  RatingSource,
  RatingTrajectoryResult,
  SlotTendency,
  WindowedRecordResult,
} from "../query/types.js";

/**
 * Every scraped, human-facing string that reaches the terminal goes through here first.
 *
 * A player or team name comes from a fetched page, so it is attacker-influenced, and these
 * formatters write it straight to a TTY. A name carrying ANSI/OSC controls or bidi overrides can
 * clear the screen, rewrite earlier lines, or visually reorder a roster — the same Trojan-Source
 * spoofing class `src/sanitize.ts` was written for. Until now that sanitizer was applied only to
 * `key=value` summary lines (`emit.ts`, `summary.ts`), so every multi-line human-readable
 * presenter — `team show`, `player show`, and #17 PR B's `lineup plan` — interpolated names raw.
 *
 * Found by the independent Codex review of PR #47 against the new formatter (rated medium). It is
 * fixed for all three rather than only the one flagged: fixing the reported instance and leaving
 * its siblings is this repo's most-recorded failure mode (docs/findings.md), and the two older
 * presenters are exposed by exactly the same input.
 *
 * The HTML and markdown dossier renderers are NOT routed through this — they have their own,
 * stronger escapes (`escapeHtml`, `escapeMarkdownCell`) for a different threat in a different
 * medium.
 */
export function formatName(value: string): string {
  return sanitizeValue(value);
}

/** `wins-losses`, with `undecided` appended only when nonzero — `excludedUndated` is a data-quality
 * footnote (rows with no `playedOn`), not part of the record itself, so it never renders here. */
export function formatRecord(record: WindowedRecordResult): string {
  const base = `${record.wins}-${record.losses}`;
  return record.undecided > 0 ? `${base} (${record.undecided} undecided)` : base;
}

export function formatSlotTendencies(slots: SlotTendency[]): string {
  if (slots.length === 0) return "none";
  return slots.map((s) => `${s.slot}×${s.count}`).join(", ");
}

export function formatPartnerFrequency(
  partners: (PartnerFrequencyEntry & { canonicalName: string })[],
): string {
  if (partners.length === 0) return "none";
  return partners.map((p) => `${formatName(p.canonicalName)} ×${p.count}`).join(", ");
}

function courtMatchCount(n: number): string {
  return `${n} court match${n === 1 ? "" : "es"}`;
}

/**
 * The ONE sentence naming what a set of records was actually computed over (#97) — shared by
 * `tn player show`, `tn team show` and both dossier renderers, for the same reason
 * `ratingSourceLabel` is shared: three surfaces describing the same stored scope three different
 * ways is drift, and here it would be drift about the honesty of the numbers beside it.
 *
 * Both branches are load-bearing, and neither may be omitted. #97 exists because a dossier's records
 * were computed over every league a player had ever played in without saying so; a filtered record
 * that does not name its filter is that same defect, and an UNFILTERED record that does not say it is
 * unfiltered is the same defect one step further out — a reader who cannot tell the two apart has
 * learned nothing from the page. So "no league scope applied" is printed as positively as an
 * exclusion is.
 *
 * `eventName` is the event the scope was read from, or `null` when no event was named. It is stated
 * because a captain holding a printed binder needs to know *why* these numbers are scoped, not only
 * that they are.
 */
export function formatEvidenceScopeLine(summary: EvidenceScopeSummary, eventName: string | null): string {
  const from = eventName === null ? "" : ` (event "${formatName(eventName)}")`;
  if (summary.scope === null) {
    return `no league scope applied${from} — every league counts, ${courtMatchCount(summary.retained)}`;
  }
  return (
    `${leagueScopeLabel(summary.scope)}${from} — ` +
    `${summary.retained} of ${courtMatchCount(summary.considered)} retained, ${summary.excluded} excluded`
  );
}

/**
 * What is STILL in the evidence after the scope ran — the other half of #97's disclosure, and the
 * half a count alone cannot give. After `exclude:Mixed`, between 37% and 69% of the remaining
 * evidence is still out-of-league (Adult 18+ 3.5, Adult 55+ 7.0/8.0, Tri-Level, Combo …): an accepted
 * residual, but one the HC ruling requires be stated rather than left implicit. Rendering it from the
 * actual retained rows keeps it true as the data moves, where a hardcoded sentence would quietly rot.
 *
 * The unclassified bucket is named in words ("no league recorded") rather than shown as a blank, so
 * it reads as the real category it is — those rows survive either scope mode on purpose
 * (`leagueScopeRetains`), and a blank cell would read as a rendering bug instead.
 */
export function formatRetainedLeaguesLine(summary: EvidenceScopeSummary): string {
  if (summary.retainedLeagues.length === 0) return "none on file";
  return summary.retainedLeagues
    .map((entry) => `${entry.league === null ? "no league recorded" : formatName(entry.league)} (${entry.count})`)
    .join(", ");
}

// Human labels for the four known rating sources (spec § Domain model: "NTRP + type, WTN S, WTN D,
// TR dynamic"). A source outside this map (schema comment: the vocabulary is open, same rationale
// as `derive.ts`'s `Discipline`) falls through to its raw string rather than being dropped — an
// unrecognized rating is still a rating.
const RATING_SOURCE_LABELS: Record<string, string> = {
  ntrp: "NTRP",
  wtn_singles: "WTN-S",
  wtn_doubles: "WTN-D",
  tr_dynamic: "TR-Dyn",
};

/** The one place a rating source becomes human-readable, exported so `tn lineup plan` and the two
 * dossier renderers name a scale the same way this module already does — a printed binder reading
 * "ranked within ntrp" beside a roster row reading "NTRP" is the drift this prevents. An unknown
 * source falls through to its raw string, per the open-vocabulary rule above. */
export function ratingSourceLabel(source: string): string {
  return RATING_SOURCE_LABELS[source] ?? source;
}

/**
 * The WTN sources this disclosure can name a publisher for: the two that `src/ingest/archived.ts`
 * writes out of the ITF widget embedded in a USTA profile.
 *
 * **Both halves of this pair matter, and each fixes a different defect.** An enumeration alone
 * fails silently when the vocabulary grows — #132's own rejected option 3 ("store both,
 * source-attributed") adds a WTN source, and a two-element set would describe only the old one
 * while the roster table printed both. But a bare `startsWith("wtn_")` fails *worse*: the second
 * source that option contemplates comes **from worldtennisnumber.com**, the very publisher this
 * line says the number is *not* from, so a prefix test would attach "shown on the USTA player
 * profile" to a figure that is nothing of the kind. Widening the net to avoid an omission would
 * have manufactured a false attribution — in the one sentence whose whole job is attribution.
 * (Found by Codex adversarial review round 1, guard-completeness lens, rated Medium.)
 *
 * So: attribute only what is known, and **notice** the rest rather than swallowing it. An
 * unrecognised `wtn_*` source is disclosed as present-but-unattributed, which needs no maintenance
 * and cannot lie. Adding it to this set is then a deliberate act by whoever adds the source.
 */
const USTA_WIDGET_WTN_SOURCES: ReadonlySet<string> = new Set(["wtn_singles", "wtn_doubles"]);

function isWtnSource(source: string): boolean {
  return source.startsWith("wtn_");
}

/**
 * Issue #132's disclosure: **which** publisher's World Tennis Number the dossier is printing, and
 * **when** that publisher published it.
 *
 * The issue's complaint was that two sources give a different WTN singles number for one player —
 * 30.35 on the USTA profile widget, 32.6 on worldtennisnumber.com — and the dossier "prints one of
 * them without saying which". The decision was to keep the USTA-embedded value; this line is the
 * other half of that decision, and without it the decision is invisible to the person holding the
 * binder.
 *
 * **Derived from the observations actually printed, never hardcoded** — the same rule
 * `formatRetainedLeaguesLine` states one field over: a hardcoded sentence quietly rots as the data
 * moves. Specifically it reads each entry's `latest`, because `latest` is what
 * `formatRatingTrajectory` renders; describing the whole `series` would date numbers the page does
 * not show.
 *
 * **Every branch prints**, per the #97/#113 precedent — a disclosure that disappears when there is
 * nothing to disclose leaves a reader unable to tell "no WTN on file" from "this dossier forgot to
 * mention it". "No WTN at all" and "WTN whose date we cannot state" are kept **separate**, and
 * neither borrows the other's sentence: `observed_on` is an unconstrained TEXT column, so a blank
 * one is reachable, and collapsing that case into "none on file" would deny ratings the page is
 * visibly printing, while letting it fall through to the dated branch would render a contentless
 * `published .`.
 *
 * It does **not** claim the two publishers were reconciled, because they were not: the 30.35/32.6
 * gap is unexplained, and saying so is the honest content of the line.
 */
export function formatWtnProvenanceLine(trajectories: RatingTrajectoryResult[]): string {
  const wtn = trajectories.flat().filter((entry) => isWtnSource(entry.source));
  if (wtn.length === 0) return "none on file for this roster";

  const attributed = wtn.filter((entry) => USTA_WIDGET_WTN_SOURCES.has(entry.source));
  const unattributed = [...new Set(wtn.filter((e) => !USTA_WIDGET_WTN_SOURCES.has(e.source)).map((e) => e.source))]
    .map((source) => formatName(ratingSourceLabel(source)))
    .sort();

  const dates = attributed
    .map((entry) => formatName(entry.latest.observedOn).trim())
    .filter((date) => date !== "")
    .sort();

  const first = dates[0];
  const last = dates[dates.length - 1];
  const when =
    first === undefined || last === undefined
      ? "publication date not recorded"
      : first === last
        ? `published ${first}`
        : `published between ${first} and ${last}`;

  // The USTA-attributed sentence is stated only when there is something to attribute it to; a
  // roster carrying ONLY unrecognised WTN sources must not be told its numbers came from a page
  // none of them came from.
  const usta =
    attributed.length === 0
      ? ""
      : `the ITF World Tennis Number shown on the USTA player profile, ${when}. ` +
        "worldtennisnumber.com may show a different number for the same player; this dossier prints " +
        "the USTA figure and does not reconcile the two";

  if (unattributed.length === 0) return usta;
  const others =
    `${unattributed.join(", ")} ${unattributed.length === 1 ? "is" : "are"} also on file and ` +
    "this line does not identify their publisher";
  return usta === "" ? others : `${usta}. Separately, ${others}`;
}

/**
 * Every rating source renders at a FIXED precision, never a variable one — these are scouting
 * numbers read side by side in print, and a WTN of exactly `4` rendering as `"4"` next to a `"4.2"`
 * reads as a different (smaller-magnitude) quantity than it is, not merely a formatting quirk.
 * NTRP is fixed to 1 decimal place (it is always `x.0`/`x.5` by definition — spec § Domain model);
 * every other source (WTN singles/doubles, TR dynamic, and anything outside the known vocabulary —
 * `RATING_SOURCE_LABELS`'s "open vocabulary" comment applies here too) is fixed to 2. `toFixed`
 * rounds rather than truncates, so a value carrying more precision than the display allows (e.g. a
 * raw `21.567`) still renders a value consistent with the others rather than silently dropping
 * digits.
 */
function formatRatingValue(value: number, source: string): string {
  const decimals = source === "ntrp" ? 1 : 2;
  return value.toFixed(decimals);
}

/** NTRP's `ratingType` (C/S/A/D/M) is appended directly to the value (spec: "NTRP + rating type");
 * every other source has no rating type to append. */
export function formatRatingTrajectory(trajectory: RatingTrajectoryResult): string {
  if (trajectory.length === 0) return "none on file";
  return trajectory
    .map((entry) => {
      const label = RATING_SOURCE_LABELS[entry.source] ?? entry.source;
      const typeSuffix = entry.latest.ratingType ?? "";
      return `${label} ${formatRatingValue(entry.latest.value, entry.source)}${typeSuffix}`;
    })
    .join(", ");
}

/**
 * The roster-source disclosure line (#113) — `formatEvidenceScopeLine`'s precedent one field over,
 * shared by `tn team show`, `tn lineup plan` and both dossier renderers so the four surfaces cannot
 * describe the same roster four different ways. **Both branches always print**, per the #97
 * precedent this mirrors: a season roster states itself as loudly as a registered one, because a
 * reader who cannot tell the two apart has learned nothing from either.
 *
 * `eventName` is `null` whenever `rosterSource === "season"` because no event was named at all — the
 * one case genuinely distinct from "an event was named but has no (or no longer any) registered
 * rows", which still names the event so the fallback reads as informative rather than as a missing
 * argument. `rosterSource === "registered"` always carries a non-null `eventName` by construction —
 * `resolveRoster` (src/query/roster.ts) can only reach that branch by resolving an event first.
 */
export function formatRosterSourceLine(
  rosterSource: "registered" | "season",
  eventName: string | null,
  registeredCount: number,
  seasonCount: number,
): string {
  if (rosterSource === "registered") {
    // TWO FACTS, not one ratio. "N of M season roster" reads as a subset claim, and the code does
    // not preserve one: the writer now requires a current season membership, so the subset holds at
    // registration — but a later `tn team pull` that retires a season member correctly leaves their
    // registration standing, so M can fall below N and the line would render "2 of 1". Stating the
    // two counts separately is true in every reachable state, which a ratio is not. (Codex
    // adversarial review of PR #121, round 1, finding 5 [low].)
    // See the doc comment above: reachable only with a non-null eventName.
    return (
      `registered ${registeredCount} for event "${formatName(eventName ?? "")}" ` +
      `(season roster: ${seasonCount})`
    );
  }
  if (eventName === null) return "season roster — no event named";
  return `season roster (event "${formatName(eventName)}") — no registered members`;
}

/**
 * One NOT REGISTERED player's compact line (#113, the HC's 2026-08-05 dossier-scope mock): name and
 * a single rating value, deliberately no record and no tendencies — it exists so a late add is
 * RECOGNISED, not SCOUTED. `rating === null` (no observation in `source`, or no source was chosen at
 * all because nobody absent has any rating on file) prints `—` rather than omitting the player —
 * the same "state the absence, never drop the row" discipline `formatRetainedLeaguesLine` uses for
 * an unclassified league.
 */
export function formatAbsentRosterMember(member: AbsentRosterMember, source: RatingSource | null): string {
  const rating = member.rating === null || source === null ? "—" : formatRatingValue(member.rating, source);
  return `${formatName(member.canonicalName)} ${rating}`;
}

// Human labels for the three `dataGaps` sections — `dataGaps`' keys are the camelCase field names
// `getPlayerProfile` builds (`captainNotes`), which read awkwardly bare in prose. `availability`
// and `captain_notes` gained writers in #17 PR A; `events` still has none that associates a PLAYER
// with an event, so it remains the one standing "not collected" section.
const DATA_GAP_LABELS: Record<string, string> = {
  events: "events",
  availability: "availability",
  captainNotes: "captain notes",
};

/** The keys `dataGaps` marked `"not-collected"`, human-labeled and stably ordered — `"empty"` and
 * `"has-data"` are both real results (Task 3 rule 6) and never appear here. `null`, not `""`, when
 * there is nothing to report, so a caller can `if (line !== null)` instead of checking length. */
export function formatDataGapsLine(gaps: DataGapsResult): string | null {
  const keys = Object.keys(gaps).filter((k) => gaps[k] === "not-collected");
  if (keys.length === 0) return null;
  return keys.map((k) => DATA_GAP_LABELS[k] ?? k).join(", ");
}
