// Compact human-readable formatting shared by `player show` and `team show`'s non-`--json` output
// (spec § Interfaces: `player show` is "full profile: ratings trajectory, history, records"). Kept
// separate from `src/report/*.ts` (Task 7): the CLI's terse one-call-to-console.log form and the
// self-contained HTML/markdown dossier are different presenters over the same `src/query/` shapes,
// each with its own escaping/layout rules — reusing THIS module for the report renderers would
// couple two audiences (a terminal, a printed binder) that should stay free to diverge.

import type {
  DataGapsResult,
  PartnerFrequencyEntry,
  RatingTrajectoryResult,
  SlotTendency,
  WindowedRecordResult,
} from "../query/types.js";

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
  return partners.map((p) => `${p.canonicalName} ×${p.count}`).join(", ");
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

/** NTRP's `ratingType` (C/S/A/D/M) is appended directly to the value (spec: "NTRP + rating type");
 * every other source has no rating type to append. `value` prints without a trailing ".0" so an
 * integer NTRP rating (e.g. 4) does not read as "4.0" when the page never distinguished them. */
function formatRatingValue(value: number): string {
  return String(value);
}

export function formatRatingTrajectory(trajectory: RatingTrajectoryResult): string {
  if (trajectory.length === 0) return "none on file";
  return trajectory
    .map((entry) => {
      const label = RATING_SOURCE_LABELS[entry.source] ?? entry.source;
      const typeSuffix = entry.latest.ratingType ?? "";
      return `${label} ${formatRatingValue(entry.latest.value)}${typeSuffix}`;
    })
    .join(", ");
}

// Human labels for the three sections with no writer anywhere in the codebase (docs/findings.md,
// #15) — `dataGaps`' keys are the camelCase field names `getPlayerProfile` builds
// (`captainNotes`), which read awkwardly bare in prose.
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
