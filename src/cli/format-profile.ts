// Compact human-readable formatting shared by `player show` and `team show`'s non-`--json` output
// (spec § Interfaces: `player show` is "full profile: ratings trajectory, history, records"). Kept
// separate from `src/report/*.ts` (Task 7): the CLI's terse one-call-to-console.log form and the
// self-contained HTML/markdown dossier are different presenters over the same `src/query/` shapes,
// each with its own escaping/layout rules — reusing THIS module for the report renderers would
// couple two audiences (a terminal, a printed binder) that should stay free to diverge.

import { sanitizeValue } from "../sanitize.js";
import { nameKey } from "../db/name-key.js";
import { leagueScopeLabel } from "../query/league-scope.js";
import type { PlayerTeamMembershipSummary } from "../query/player-profile.js";
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

/**
 * The `teams:` line of `tn player show` (#131). One entry per **team**, grouped on `teamId`.
 *
 * **Why grouping, and why on the id.** `team_memberships` is `player ↔ team ↔ event` by design, so a
 * player on both a season/district roster (`event_id IS NULL`) and an event's registered roster
 * legitimately holds two rows for one team — 49 such `(player, team)` pairs on the live database at
 * the time of writing, spread across all five Sectionals teams. The rows are correct; mapping them
 * straight to strings, as this line used to, printed the team name twice with byte-identical text.
 * Grouping on the **id** rather than on the rendered string matters: deduping display text would
 * hide the very failure it is meant to expose, since two rows that *render* alike would become
 * indistinguishable from two rows that *are* alike.
 *
 * **Why the contexts are named rather than collapsed.** The issue asked for this to be decided
 * rather than defaulted past, and the measurement decided it: registrations exist on every team in
 * the field, not only ours, so "registered for the event" versus "on the season roster" is a
 * scouting fact about an opponent — the difference between a player who will be in Springfield and
 * one who may not travel. The wording is #113's (`resolveRoster`, `formatRosterSourceLine`), reused
 * so one distinction has one vocabulary across the CLI.
 *
 * **What the parenthetical omits.** A lone CURRENT season membership renders bare, for players whom
 * "season roster" would label with nothing to distinguish it from — 28 of the 77 players who hold
 * any membership at all (the other 49 hold both a season row and a registration; 1668 of the 1745
 * players on file hold no membership and reach the `"none"` branch above). That is a presentation
 * default and nothing more: every context is built uniformly below, and only the final label is
 * elided.
 *
 * **`former` is per context, never per team.** A player may hold a retired season membership beside
 * a live registration (a `tn team pull` after `tn roster set`), and labelling the whole team
 * "(former)" off any single row would call someone still registered for Springfield a former member.
 * `retired_at` is non-null on 0 of 126 live rows, so nothing on disk would catch that — only
 * `test/cli-format-profile.test.ts` does.
 */
export function formatTeamMemberships(memberships: PlayerTeamMembershipSummary[]): string {
  if (memberships.length === 0) return "none";

  const byTeam = new Map<number, PlayerTeamMembershipSummary[]>();
  for (const m of memberships) {
    const rows = byTeam.get(m.teamId);
    if (rows === undefined) byTeam.set(m.teamId, [m]);
    else rows.push(m);
  }

  return Array.from(byTeam.values())
    .map((rows) => {
      // Every row in the group carries the same `teamName` (they share a `teamId`, and the name came
      // from the joined `teams` row), so the first is as good as any.
      const teamName = formatName(rows[0]!.teamName);

      // The season membership is ONE context however many rows carry it, so its retired-ness is
      // read across all of them rather than off whichever sorted first. `membership_unique_no_event`
      // (a partial unique index on `event_id IS NULL`) makes that set exactly one row today, so the
      // two readings coincide — but if that index were ever lost, `find` would silently drop a row
      // and report the first one's state, while `every` says "former" only when the player has
      // genuinely left. Same derivation on both branches below, so they cannot disagree.
      const seasonRows = rows.filter((r) => r.eventId === null);
      const eventRows = rows.filter((r) => r.eventId !== null);
      const seasonRetired = seasonRows.every((r) => r.retiredAt !== null);

      // The one elision: with no registration there is nothing to distinguish, so nothing is said —
      // 28 of the 77 players who hold any membership. A retired season row still takes the
      // "(former)" suffix it has carried since #49.
      if (eventRows.length === 0) {
        return seasonRetired ? `${teamName} (former)` : teamName;
      }

      const contexts: string[] = [];
      if (seasonRows.length > 0) contexts.push(withRetirement("season roster", seasonRetired));
      for (const row of eventRows) {
        // `membership_unique` (playerId, teamId, eventId) makes each event at most one row here, so
        // no event is named twice. A null `eventName` on a non-null `eventId` is a broken foreign
        // key, not a nameless event: printing the id keeps the fault VISIBLE, where
        // `registered for ""` would read as ordinary data.
        const label =
          row.eventName === null
            ? `registered for event #${row.eventId}`
            : `registered for "${formatName(row.eventName)}"`;
        contexts.push(withRetirement(label, row.retiredAt !== null));
      }
      return `${teamName} (${contexts.join("; ")})`;
    })
    .join(", ");
}

/** One roster context's label, marked when that context has been soft-retired. Takes the decided
 * boolean rather than a `retiredAt` string, so the caller owns "what counts as retired for this
 * context" in one place — the season context decides it over a set of rows, an event context over
 * its single row. An em dash rather than a second parenthesis, so the marker cannot be misread as
 * closing the group. */
function withRetirement(label: string, retired: boolean): string {
  return retired ? `${label} — former` : label;
}

/**
 * The `(aka …)` suffix of `tn player show` (#131, folded adjacent defect) — or `null` when there is
 * nothing worth saying, so the caller omits the parenthesis entirely rather than printing `(aka )`.
 *
 * Every player-creating path seeds an alias row equal to the new player's own canonical name
 * (`src/ingest/identity.ts`, `src/ingest/disambiguate.ts`), because `player_aliases.name_key` is the
 * index `findPlayerByNameOrAlias` resolves against. Measured on the live database: 1745 players,
 * 1745 alias rows, **1745 of them exactly equal to their own canonical name** — so this suffix
 * printed on every profile in the database and had never once carried information.
 *
 * The alias rows are correct and are not touched: deleting a self-alias would break the resolver
 * that reads them. This is a presenter fix, exactly as the `teams:` line above is.
 *
 * Compared through `nameKey` (src/db/name-key.ts) rather than by string equality, so "the same name"
 * means here what it means in the database — a future alias differing only in case, in surrounding
 * whitespace, or by an invisible character is suppressed by the same fold the rows were keyed with.
 * A second notion of name equality in this codebase is the "one ladder, two notions of a name"
 * defect #31 closed.
 */
export function formatAliases(canonicalName: string, aliases: string[]): string | null {
  // Deduped BY KEY among themselves, not only filtered against the canonical name — the same reason
  // the `teams:` line above groups on `teamId`. `player_alias_unique` is on (`player_id`, `alias`),
  // the RAW string, so the DATABASE permits two rows whose spellings fold to one name; only
  // `recordAlias` guards that, in application code, and the two creation paths each insert once. No
  // current writer produces such a pair — but a presenter whose entire purpose is to stop printing
  // one name twice should not rest on an invariant enforced one table over and not by its index.
  // Seeding the set with the player's own key makes the self-alias filter fall out of the same pass.
  const seen = new Set<string>([nameKey(canonicalName)]);
  const distinct: string[] = [];
  for (const alias of aliases) {
    const key = nameKey(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(alias);
  }
  if (distinct.length === 0) return null;
  return distinct.map(formatName).join(", ");
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
 *
 * Exported for #127's `format-lineup-build.ts`, which prints a COURT's rating — the sum of the
 * placed players' values, in the same scale. A sum belongs at the same precision as its terms (two
 * NTRP values are each `x.0`/`x.5`, so their sum is too), and the alternative was a second precision
 * convention in a sibling presenter — exactly the drift `ratingSourceLabel` was shared to prevent,
 * one field over. It is also what keeps a float sum (`4.2 + 4.1 === 8.299999999999999`) from
 * reaching a captain's page as a 16-digit number.
 */
export function formatRatingValue(value: number, source: string): string {
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
