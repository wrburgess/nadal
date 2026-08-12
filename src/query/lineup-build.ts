// DB assembly for `tn lineup build` (#127) — the sibling of `lineup.ts`, and thin for the same
// reason: it fetches rows with drizzle, hands them to `derive-lineup-build.ts`'s pure
// `buildDayScenarios`, and attaches the names a presenter needs. Not one rule below is re-implemented
// here; every judgement about who plays where lives in the pure layer, where it is tested against
// hand-built inputs a real fixture cannot exhibit.
//
// **The target is the DAY, not a team.** The builder is home-team-only by construction: availability
// and captain notes are "populated for our team only, by design" (spec § Domain model), so the team
// comes from `requireHomeTeam` and there is deliberately no way to ask this question about an
// opponent. That question is `tn lineup plan`, which this leaves untouched.
//
// **Every read happens exactly once and is threaded down.** The event is resolved once and its
// identity carried; the roster is resolved once and its `members` handed to BOTH readers that need
// it (neither `getAvailabilityForEvent` nor `getCaptainNotes` takes a `teamId`, by design). That is
// not stylistic: deriving "who is on this roster" twice is the defect class PR #134 closed three
// times in one review, and each instance rendered a page that disagreed with itself.

import { inArray } from "drizzle-orm";
import { ratingObservations } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import type { AvailabilityStatus } from "./availability.js";
import {
  EventDoesNotCoverDayError,
  InvalidAvailabilityStatusError,
  getAvailabilityForEvent,
  resolveEventForDay,
} from "./availability.js";
import type { CaptainNotesView } from "./captain-notes.js";
import { getCaptainNotes } from "./captain-notes.js";
import { buildDayScenarios } from "./derive-lineup-build.js";
import type {
  DayScenarios,
  EligibilityLedger,
  EligibilityStatus,
  PlaysConstraint,
  Scenario,
} from "./derive-lineup-build.js";
import type { EventCourt } from "./event-format.js";
import { requireHomeTeam } from "./home-team.js";
import { ownTeamCourtMatchRows, requireSlotSet, resolveEvent } from "./lineup.js";
import { InvalidPlaysError } from "./player-plays.js";
import { resolveRoster } from "./roster.js";
import type { RatingSource } from "./types.js";

export type GetLineupBuildInput = {
  /** ISO day, e.g. `"2026-08-29"`. The event is resolved FROM it. */
  day: string;
  /** The optional trailing disambiguator, the identical shape `tn player avail` uses: required only
   * when the day falls inside more than one event's range, and refused if the named event does not
   * actually cover the day. */
  eventName?: string;
};

export type LineupBuild = {
  day: string;
  teamId: number;
  teamName: string;
  /** The event the DAY resolved to — the only event identity in this result, carried from the one
   * `resolveEvent` call rather than looked up again anywhere below. */
  event: { id: number; name: string };
  /** That event's court list, in its own format order. */
  slotSet: EventCourt[];
  ledger: EligibilityLedger;
  eligibleCount: number;
  /** #149: `eligibleCount` minus every player whose recorded `plays` is `"doubles-only"` — carried
   * straight through from `DayScenarios.singlesEligibleCount` (derive-lineup-build.ts). Threaded
   * here (rather than left a level down) because both consumers of THIS type need it directly: the
   * CLI presenter's day-level disclosure of the constraint-override case, and the `lineup_build` MCP
   * tool, which returns this object verbatim rather than re-deriving anything from `scenarios`. */
  singlesEligibleCount: number;
  bodiesNeeded: number;
  shortfall: number;
  ratingSource: RatingSource | null;
  ratedEligible: number;
  scenarios: Scenario[];
  /** Player and pairing notes over the SAME roster the scenarios were built from — displayed, never
   * scored. Scoring on a pairing note would drag a CLI grammar change into scope, and a captain's
   * subjective line is context for a decision rather than an input to an optimizer. */
  captainNotes: CaptainNotesView;
  /**
   * The evidence every shared-match count actually rests on: this team's own court matches in which
   * at least one of these players was on THIS TEAM's side. Reported so an honest zero is legible as
   * a scoped zero.
   *
   * Counts the rows that retain **one of these players on this team's side**, not every row that was
   * ours and not merely every row the side filter left non-empty. Reporting anything wider makes the
   * denominator overstate the support beneath it — a court that contributed to no count would still
   * be offered as evidence for the counts. The difference is not dropped, it moves to
   * `excludedOpposingSideMatches` below.
   */
  observedCourtMatches: number;
  /** Court matches these players appeared in that belong to some OTHER team, set aside rather than
   * silently dropped. */
  excludedOtherTeamMatches: number;
  /**
   * Court matches that ARE this team's own, but in which every one of these players sat on the
   * opposing side — a roster member who played that court *against* us, before changing teams.
   *
   * A second, separate exclusion from `excludedOtherTeamMatches`, and deliberately not folded into
   * it: that one means "this match was not ours", this one means "this match was ours and these
   * players were not on our half of it". Collapsing them would make the page unable to say which
   * happened. Found by the independent Codex review of PR #137 (final pass, class A) — as a defect
   * in the *fix* for its own earlier finding, which added the side filter and left this counter
   * reading the unfiltered set.
   */
  excludedOpposingSideMatches: number;
  rosterSize: number;
  /** `resolveRoster`'s own discriminant (#113), carried through unchanged, exactly as `LineupPlan`
   * carries it. */
  rosterSource: "registered" | "season";
  registeredCount: number;
  seasonCount: number;
};

/**
 * Reads one stored `availability.status` into the pure layer's closed vocabulary, or refuses.
 *
 * `availability.status` is a plain TEXT column, so SQLite enforces nothing on it; only
 * `setAvailability`'s zod enum stands between a value and the table, and a hand-edited database is
 * exactly the case this exists for. Failing closed matters here more than it looks: an unrecognized
 * status belongs to none of the four ledger buckets, so the honest outcome of "carry it through"
 * would be a roster member who appears on NO line of the page at all — an absence with no bucket, in
 * a feature whose whole point is that every absence is named. Same class as the writer's, because it
 * is the same reason.
 */
function readStatus(status: AvailabilityStatus | null): EligibilityStatus {
  if (status === null) return null;
  if (status === "available" || status === "unavailable" || status === "uncertain") return status;
  throw new InvalidAvailabilityStatusError(
    `stored availability status "${status}" is not one of available | unavailable | uncertain`,
  );
}

/**
 * Reads one stored `players.plays` into the pure layer's closed vocabulary, or refuses (#149).
 *
 * `players.plays` is a plain TEXT column exactly like `availability.status` above, so SQLite
 * enforces nothing on it — only `setPlays`'s zod enum stands between a value and the table, and a
 * hand-edited database is exactly the case this exists for. Failing closed matters here for the
 * same reason `readStatus` fails closed: an unrecognized value is not one of the two eligibility
 * outcomes this feature can act on, so the honest choice is to refuse rather than silently treat it
 * as "unconstrained" (which would seat a player the captain constrained) or as "doubles-only" (which
 * would bench a player the captain never constrained). Throws the SAME class `setPlays` throws for
 * an invalid input — it is the same reason, only discovered at read time instead of write time.
 */
function readPlays(plays: string | null): PlaysConstraint {
  if (plays === null) return null;
  if (plays === "both" || plays === "doubles-only") return plays;
  throw new InvalidPlaysError(`stored plays value "${plays}" is not one of both | doubles-only`);
}

/**
 * Builds one day's lineup scenarios for the home team: who is available, the three disclosed ways to
 * field them, and everything a presenter needs to say why.
 *
 * The sequence, each read exactly once: `requireHomeTeam` -> `resolveEventForDay` (the shared
 * day->event resolver `setAvailability` uses, so the two doors cannot disagree about which event a
 * day belongs to) -> `resolveEvent` + `requireSlotSet` -> `resolveRoster` -> `getAvailabilityForEvent`
 * and `getCaptainNotes`, both handed that one resolution's `members` -> `ownTeamCourtMatchRows` ->
 * rating observations -> `buildDayScenarios`.
 *
 * **`NoCourtMatchHistoryError` is deliberately NOT inherited.** `getLineupPlan` refuses a team with
 * no court matches of its own, and correctly: a PREDICTION with no evidence would read as "we predict
 * nobody plays". This is not a prediction. Availability is the input and history is a soft signal, so
 * a roster with no history still produces scenarios and every pair simply reads no shared history —
 * refusing here would fail on exactly the newly-assembled roster this feature exists to serve.
 *
 * Refuses, one distinct class per reason: `NoHomeTeamError`; the day->event taxonomy
 * (`InvalidAvailabilityDayError`, `NoEventForDayError`, `AmbiguousEventForDayError`,
 * `EventDoesNotCoverDayError`, `UnknownEventError`); `EventHasNoFormatError` when the resolved event
 * has no court list; `InvalidEventFormatError` / `InvalidLeagueScopeError` for a corrupted stored
 * column; `InvalidAvailabilityStatusError` for a stored status our own writer could not have
 * produced (see `readStatus`); and `InvalidPlaysError` for a stored `plays` value our own writer
 * could not have produced (#149, see `readPlays`).
 */
export function getLineupBuild(db: Db, input: GetLineupBuildInput): LineupBuild {
  const homeTeam = requireHomeTeam(db);

  // The day names the event; a supplied name is still checked AGAINST the day rather than trusted,
  // which is `tn player avail`'s documented behavior one command over.
  const dayEvent = resolveEventForDay(db, input.day, input.eventName);
  const resolved = resolveEvent(db, dayEvent.name);
  // RE-ASSERT COVERAGE. `resolveEventForDay` and `resolveEvent` are two separate reads of the
  // `events` row, so the range can change between them — `tn event add` upserts on name, and nadal
  // genuinely runs `tn mcp serve` beside the CLI against one WAL file. Without this check the
  // failure is SILENT rather than loud: every downstream day comes from
  // `getAvailabilityForEvent`, which enumerates the range it reads, so a shortened event yields a
  // day list that no longer contains `input.day`, every player reads `status: null` (unrecorded),
  // and the command exits 0 with a confident "nobody is available" for a day the event no longer
  // covers. Re-reading the range off the ALREADY-RESOLVED value costs nothing — `recordedAs` is
  // carried on it — and converts that into the refusal the caller already handles.
  //
  // Found by the independent Codex review of this PR, class A. The self-review had recorded the
  // two-read window as Low on the reasoning that it "fails closed via UnknownEventError" — true for
  // a RENAME or a delete, and wrong for a RANGE CHANGE, which is the case that produces a wrong
  // answer instead of an error. Checking one branch of a window and generalizing to the window is
  // the error worth remembering here.
  const { startsOn, endsOn } = resolved.recordedAs;
  if (startsOn === null || endsOn === null || input.day < startsOn || input.day > endsOn) {
    throw new EventDoesNotCoverDayError(
      `event "${resolved.event.name}" does not cover ${input.day} (${startsOn ?? "?"}..${endsOn ?? "?"}) — ` +
        "its dates changed between resolving the day and reading the event",
    );
  }
  // The court list is REQUIRED here — there is no observed-slot-set fallback for a built lineup, and
  // silently inventing courts from history would be the silent-lie class this repo has logged
  // before. Called immediately after resolution, before any roster or evidence read, so the refusal
  // lands before any work is done.
  const slotSet = [...requireSlotSet(resolved)];

  // ONE roster resolution, threaded to every reader below. `eventId` is the ALREADY-RESOLVED event's
  // own identity, never a name looked up again.
  const rosterResolution = resolveRoster(db, { teamId: homeTeam.id, eventId: resolved.event.id });
  const members = rosterResolution.members;
  const memberIds = members.map((m) => m.playerId);

  // Neither reader takes a `teamId`: both are handed the roster the caller already resolved, by
  // design (see each function's doc comment). That shape is what makes it impossible for the ledger
  // and the notes to disagree about who is on this team.
  const eventAvailability = getAvailabilityForEvent(db, { eventId: resolved.event.id, roster: members });
  const captainNotes = getCaptainNotes(db, { roster: members });

  // The day is inside the event's range by construction — `resolveEventForDay` matched it against
  // `starts_on`..`ends_on`, and `getAvailabilityForEvent` enumerates that same range — so a player
  // with no entry for it has simply not answered.
  const statusFor = new Map<number, AvailabilityStatus | null>();
  for (const player of eventAvailability.players) {
    statusFor.set(player.playerId, player.days.find((d) => d.day === input.day)?.status ?? null);
  }

  const { rows, excludedOtherTeamMatches, ourSideByCourtMatch } = ownTeamCourtMatchRows(db, homeTeam.id, memberIds);

  // OUR SIDE ONLY. "This court match is ours" and "this player was on our side of it" are different
  // facts, and the rows above answer the first. A player on our roster *now* may have played a court
  // under one of our team matches **for the opponent**, having changed teams between seasons — and
  // when two such players shared that side, `partnerFrequency` would count a partnership formed
  // AGAINST us and this command would print it as "N matches together", under a strategy whose
  // stated rule says "for this team". Restricting participants here makes the claim the code's
  // rather than the doc's. Found by the independent Codex review of PR #137 (class A); measured at
  // 0 of 22 doubles courts on the production database today, so this closes a latent hole rather
  // than correcting a number now in the binder.
  //
  // Done HERE rather than inside `ownTeamCourtMatchRows` on purpose: `getLineupPlan` shares that
  // function, #127 leaves `tn lineup plan` behaviorally untouched, and `predictedLineup` carries the
  // same conflation one module over. That sibling instance is real and is recorded rather than
  // silently fixed under an issue that excludes it.
  const ourRows = rows.map((row) => ({
    ...row,
    participants: row.participants.filter((p) => p.side === ourSideByCourtMatch.get(row.id)),
  }));
  // WHICH ROWS ARE ACTUALLY EVIDENCE. The predicate is "does this row retain one of THESE PLAYERS",
  // not "did the filter leave anybody standing" — and the difference is the whole finding.
  //
  // `courtMatchRowsForPlayers` pre-joins EVERY participant, including people who are not on this
  // roster at all. So a court can be retained because a roster member played it on the OPPOSING
  // side, keep a non-roster team-mate of ours on our side, and survive a bare `participants.length
  // > 0` test — while contributing to nothing, because every count below is computed over this
  // roster's ids. An earlier revision used exactly that bare test and was wrong for exactly that
  // shape (Codex pass 3, class A).
  //
  // Stated as the lesson rather than patched again: the two previous versions of this line each
  // asked a PROXY for the real question ("is the row non-empty after filtering?"), and a proxy can
  // always be made wrong by a case it does not model. This asks the question the page's own numbers
  // answer — a court is evidence when somebody whose counts we report was on our side of it — so
  // there is no gap left between the counter and the thing it counts. It also subsumes the earlier
  // case, since a row the filter emptied retains nobody at all.
  const memberIdSet = new Set(memberIds);
  const contributingRows = ourRows.filter((row) => row.participants.some((p) => memberIdSet.has(p.playerId)));

  const observationRows =
    memberIds.length === 0
      ? []
      : db.select().from(ratingObservations).where(inArray(ratingObservations.playerId, memberIds)).all();
  const observationsByPlayer = new Map<number, typeof observationRows>();
  for (const observation of observationRows) {
    const list = observationsByPlayer.get(observation.playerId) ?? [];
    list.push(observation);
    observationsByPlayer.set(observation.playerId, list);
  }

  const scenarios: DayScenarios = buildDayScenarios({
    players: members.map((member) => ({
      playerId: member.playerId,
      canonicalName: member.canonicalName,
      status: readStatus(statusFor.get(member.playerId) ?? null),
      plays: readPlays(member.plays),
    })),
    slotSet,
    ratings: memberIds.map((playerId) => ({
      playerId,
      observations: (observationsByPlayer.get(playerId) ?? []).map((o) => ({
        id: o.id,
        source: o.source,
        value: o.value,
        ratingType: o.ratingType,
        observedOn: o.observedOn,
      })),
    })),
    rows: ourRows,
  });

  // The team's name comes off the already-resolved home-team ROW below, never a second read:
  // `requireHomeTeam` returns the whole row for exactly this reason.
  return {
    day: input.day,
    teamId: homeTeam.id,
    teamName: homeTeam.name,
    event: { id: resolved.event.id, name: resolved.event.name },
    slotSet,
    ledger: scenarios.ledger,
    eligibleCount: scenarios.eligibleCount,
    singlesEligibleCount: scenarios.singlesEligibleCount,
    bodiesNeeded: scenarios.bodiesNeeded,
    shortfall: scenarios.shortfall,
    ratingSource: scenarios.ratingSource,
    ratedEligible: scenarios.ratedEligible,
    scenarios: scenarios.scenarios,
    captainNotes,
    observedCourtMatches: contributingRows.length,
    excludedOtherTeamMatches,
    excludedOpposingSideMatches: rows.length - contributingRows.length,
    rosterSize: memberIds.length,
    rosterSource: rosterResolution.source,
    registeredCount: rosterResolution.registeredCount,
    seasonCount: rosterResolution.seasonCount,
  };
}
