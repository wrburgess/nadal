// Compact human-readable formatting shared by `player show` and `team show`'s non-`--json` output
// (spec § Interfaces: `player show` is "full profile: ratings trajectory, history, records"). Kept
// separate from `src/report/*.ts` (Task 7): the CLI's terse one-call-to-console.log form and the
// self-contained HTML/markdown dossier are different presenters over the same `src/query/` shapes,
// each with its own escaping/layout rules — reusing THIS module for the report renderers would
// couple two audiences (a terminal, a printed binder) that should stay free to diverge.

import { sanitizeValue } from "../sanitize.js";
import type {
  DataGapsResult,
  PartnerFrequencyEntry,
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

// Human labels for the three `dataGaps` sections — `dataGaps`' keys are the camelCase field names
// `getPlayerProfile` builds (`captainNotes`), which read awkwardly bare in prose. All three have
// real writers as of #17 (`setAvailability`, `addCaptainNote` in PR A; `addEvent` in PR B), so
// "not collected" is now an unusual state rather than the standing one docs/findings.md #15
// recorded.
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
