// DB assembly for a team's predicted lineup (#17 PR B) — the sibling of `team-profile.ts` and
// `player-profile.ts`, and thin for the same reason: it fetches rows with drizzle, hands them to
// `derive.ts`'s pure `predictedLineup`, and attaches the names a presenter needs. The heuristic
// itself lives entirely in `derive.ts`, where it can be tested exhaustively against hand-built
// inputs; nothing here re-implements a rule.
//
// Spec § Deliverables 1 asks for "a predicted lineup honestly labeled a guess". Every name this
// module resolves exists so a presenter can print a person rather than a database id — the exact
// defect #16 shipped and #17 PR A fixed one layer over.

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { courtMatches, events, players, ratingObservations, teamMatches, teamMemberships, teams } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import { NoCourtMatchHistoryError, predictedLineup } from "./derive.js";
import type { EventCourt } from "./event-format.js";
import { readEventFormat } from "./event-format.js";
import { courtMatchRowsForPlayers } from "./player-profile.js";
import type { LineupBasis, LineupConfidence, RatingSource } from "./types.js";

export { NoCourtMatchHistoryError };

/** No row on file under the given name — `events.name` is unique, so this is the same
 * resolve-by-exact-name-or-refuse mechanism `src/ingest/match-add.ts` already uses. Nothing is ever
 * inferred from a partial or fuzzy match. */
export class UnknownEventError extends Error {}

/** The named event exists, but its `format` column is `null` — no silent fall back to the observed
 * slot set; naming the event lets a presenter tell the operator exactly what to add. */
export class EventHasNoFormatError extends Error {}

export type LineupPlanPlayer = {
  playerId: number;
  canonicalName: string;
};

export type LineupPlanSlot = {
  slot: string;
  discipline: string;
  players: LineupPlanPlayer[];
  confidence: LineupConfidence;
  basis: LineupBasis;
  support: number;
};

/**
 * Where `slots`' court list came from, as a DISCRIMINATED PAIR rather than two independent fields
 * (#63). `slotSource` and `slotEvent` are not free to disagree: `"event-format"` always has an
 * event, `"observed"` never does. Expressing that in the type is what lets the three presenters
 * narrow on `slotSource` and reach `slotEvent.name` without a non-null assertion — with two loose
 * fields, each presenter had to assert the invariant separately (`slotEvent!.name`), which is three
 * copies of a rule the type could hold once, and a crash for any caller that built the pair wrong.
 *
 * The JSON shape is unchanged: these remain two sibling keys, so `slotSource === "observed"` reads
 * exactly as before for every existing caller and test.
 */
export type LineupSlotProvenance =
  | { slotSource: "observed"; slotEvent: null }
  | { slotSource: "event-format"; slotEvent: { id: number; name: string } };

/** Brands `ResolvedEventFormat` so only `resolveEventFormat` can build one. A REAL symbol, not a
 * `declare const` phantom: a type-only brand disappears at runtime, so the object literal below
 * would have thrown `resolvedEventFormat is not defined` on the first call — caught by the tests
 * immediately. Not exported, so no caller outside this module can name the key, and a `const`
 * symbol is typed `unique symbol`, so none can forge it structurally either. */
const resolvedEventFormat = Symbol("resolvedEventFormat");

/**
 * A named event's format, already looked up and validated: the slot set to predict across, together
 * with the identity of the event it came from. Resolved ONCE by `resolveEventFormat` and reusable
 * across many `getLineupPlan` calls.
 *
 * **Opaque by construction, for a reason a plain structural type could not carry.** As two loose
 * public fields (`slotSet` + a separately-built provenance), a caller could resolve event A and
 * event B and hand over `{ slotSet: A.slotSet, provenance: B.provenance }` — predicting across A's
 * courts while all three presenters state the courts came from B. That needs no `any` and no
 * malformed data, and it defeats the provenance guarantee the batch fix exists to provide. Carrying
 * only the event's IDENTITY, and letting `getLineupPlan` derive the provenance from it, removes the
 * second field to disagree with; the brand removes the ability to fabricate the first.
 * (Codex adversarial review of PR #82, round 2, Finding 2 [medium].)
 */
export type ResolvedEventFormat = {
  readonly event: { readonly id: number; readonly name: string };
  readonly slotSet: readonly EventCourt[];
  readonly [resolvedEventFormat]: true;
};

/**
 * Looks up a named event and validates its stored format, or refuses. Exact match against
 * `events.name` (the unique key) — the same resolve-by-name-or-refuse mechanism
 * `src/ingest/match-add.ts` already uses; nothing is inferred from a partial or fuzzy match. No
 * silent fall back to the observed slot set when a named event has no format: that would be the
 * exact silent-lie class this repo has logged before.
 *
 * **Separated from `getLineupPlan` so a BATCH caller can resolve once and reuse.** `tn report build`
 * renders one dossier per team, and nadal genuinely runs two PROCESSES against one WAL database
 * (`tn mcp serve` beside a CLI invocation), so a concurrent `tn event add` committing between two
 * teams' dossiers would otherwise let ONE batch emit a two-court dossier and a four-court dossier
 * that each name the same event — while `docs/cli/GRAMMAR.md` promises the named event's format
 * applies to *every* dossier the run builds. A per-team lookup cannot keep that promise; one
 * up-front resolution can. (Codex adversarial review of PR #82, Finding 1 [high].)
 *
 * Resolving up front also moves the refusal EARLIER, which is the same batch discipline
 * `writeSectionalsDossiers` already applies to filesystem leaves: a bad event name now refuses
 * before any dossier is prepared, rather than on the first team that happens to have court history
 * — and it closes the case where a build over a team set that is empty, or entirely without
 * history, would have accepted an unknown event name in silence.
 */
export function resolveEventFormat(db: Db, eventName: string): ResolvedEventFormat {
  const eventRow = db.select().from(events).where(eq(events.name, eventName)).all()[0];
  if (eventRow === undefined) throw new UnknownEventError(`unknown event "${eventName}"`);
  // `readEventFormat` throws `InvalidEventFormatError` on a corrupted stored value (defense in
  // depth — only `addEvent` writes this column in production) — allowed to propagate as-is rather
  // than being re-wrapped, since it is already its own distinct, presenter-renderable class.
  const format = readEventFormat(eventRow.format);
  if (format === null) {
    throw new EventHasNoFormatError(
      `event "${eventName}" has no format on file — add one first, e.g. ` +
        `tn event add "${eventName}" ${eventRow.kind} ${eventRow.startsOn ?? "<starts-on>"} ` +
        `${eventRow.endsOn ?? "<ends-on>"} "S1:singles,D1:doubles"`,
    );
  }
  return {
    event: { id: eventRow.id, name: eventRow.name },
    slotSet: format,
    [resolvedEventFormat]: true,
  };
}

export type LineupPlan = LineupSlotProvenance & {
  teamId: number;
  teamName: string;
  slots: LineupPlanSlot[];
  unplaced: (LineupPlanPlayer & { courtMatches: number })[];
  /** The single rating scale every comparison was made within — `null` when nobody is rated. */
  ratingSource: RatingSource | null;
  /** Roster players ranked within `ratingSource`, strongest first. Carried through rather than
   * dropped because it is the only observable record of the ORDER every tie-break and every
   * rating-based pairing used — without it, a caller (or a test) can see which players were rated
   * but not how they compared, which is the half that actually drives placement. */
  ranked: LineupPlanPlayer[];
  /** Roster players with no observation in `ratingSource`, by name, so the gap is printable. */
  unranked: LineupPlanPlayer[];
  observedCourtMatches: number;
  /** Court matches these players appeared in that belong to some OTHER team (or to no team match
   * on file) and were therefore not used as evidence. Reported rather than silently dropped: a
   * thin-looking prediction for a roster with long individual histories is otherwise inexplicable,
   * and this number is the explanation. */
  excludedOtherTeamMatches: number;
  rosterSize: number;
};

/**
 * Builds a team's predicted lineup: the roster from `team_memberships`, that roster's court-match
 * history, and every rating observation for those players, run through `predictedLineup`.
 *
 * `eventName` (#63), when given, resolves against `events.name` (exact match, never inferred) and
 * its stored format REPLACES the derived slot set outright — `slotSource: "event-format"`, and
 * `slotEvent` names which one. Omitted, this is byte-identical to the pre-#63 behavior: the slot set
 * is derived from observed history and `slotSource` stays `"observed"`. The event is the parameter
 * of the QUESTION being asked ("what does Springfield's format say"), not a property stored against
 * the team — see the assessment on issue #63 for why a per-team link was rejected in favor of this.
 *
 * Throws `NoCourtMatchHistoryError` when the team has no court matches of its OWN on file — a
 * caller renders that as an honest absence rather than an empty lineup, which would read as "we
 * predict nobody plays". `report build` catches it for exactly that reason. Note that a roster
 * whose members have extensive individual histories can still refuse here, and correctly so: those
 * matches belong to other teams and say nothing about how THIS team fields courts. Throws
 * `UnknownEventError` / `EventHasNoFormatError` / `InvalidEventFormatError` for a bad `eventName` —
 * see each class's own doc comment.
 *
 * A player on the roster more than once (one `team_memberships` row per event — the schema allows
 * it, and a district roster plus a travel roster is the normal case) is counted ONCE here: the
 * roster is a set of people, and a duplicate id would let the same player be placed on two courts.
 */
export function getLineupPlan(db: Db, teamId: number, event?: string | ResolvedEventFormat): LineupPlan {
  const teamRow = db.select().from(teams).where(eq(teams.id, teamId)).all()[0];
  if (teamRow === undefined) throw new Error(`getLineupPlan: no team with id ${teamId}`);

  // #63: resolved FIRST, before any roster/court-match read — the event is a property of the
  // QUESTION being asked, not of the team, so there is nothing team-specific to fetch before
  // validating it.
  //
  // A caller may pass a NAME (resolved here, one lookup, the ordinary single-team case) or an
  // ALREADY-RESOLVED format. The second form exists for a BATCH caller — `report build` over every
  // team — which must resolve once and reuse, never once per team; see `resolveEventFormat`'s doc
  // comment for the race that motivates it.
  const resolved: ResolvedEventFormat | undefined =
    event === undefined ? undefined : typeof event === "string" ? resolveEventFormat(db, event) : event;
  const slotSet = resolved === undefined ? undefined : [...resolved.slotSet];
  // Derived from the resolved event's own identity, never accepted as a second field alongside the
  // slot set — so the courts predicted and the event named can not disagree.
  const provenance: LineupSlotProvenance =
    resolved === undefined
      ? { slotSource: "observed", slotEvent: null }
      : { slotSource: "event-format", slotEvent: { id: resolved.event.id, name: resolved.event.name } };

  // Issue #49: a retired member must never be predicted onto a court — the headline symptom the
  // issue was filed for. Filtered here, at the roster read, rather than after the fact: the pure
  // heuristic in derive.ts's `predictedLineup` only ever sees the players this query hands it, so
  // a retired player excluded here can never surface in a slot, an unplaced list, or a rating rank.
  const rosterRows = db
    .select({ playerId: teamMemberships.playerId, canonicalName: players.canonicalName })
    .from(teamMemberships)
    .innerJoin(players, eq(teamMemberships.playerId, players.id))
    .where(and(eq(teamMemberships.teamId, teamId), isNull(teamMemberships.retiredAt)))
    .all();

  const nameById = new Map<number, string>();
  for (const r of rosterRows) nameById.set(r.playerId, r.canonicalName);
  // Sorted so the roster handed to the pure layer is order-stable, and de-duplicated via the Map
  // above (see the doc comment: one person, however many event-scoped membership rows).
  const rosterPlayerIds = Array.from(nameById.keys()).sort((a, b) => a - b);

  // Evidence must be THIS TEAM's court matches, not merely court matches its players appear in.
  //
  // Spec § Ingestion ingests a player's full history "including their other leagues (18+ etc.)",
  // so a roster member's matches are mostly NOT this team's matches. Selecting by player id alone
  // let one team's predicted lineup be built from partnerships those players formed elsewhere — a
  // confident "8 matches together" for a pair that has never once played together for this team,
  // and a lineup for a newly assembled roster that should have refused outright. Found by the
  // independent Codex review of PR #47 (rated high).
  //
  // The association is `court_matches.team_match_id` -> `team_matches`, which `player-pull` sets
  // whenever a `team_matches` row already exists for the same `mid=` (i.e. whenever `tn team pull`
  // has seen this team's schedule). Both sides are checked: home/visiting are pull-perspective
  // labels, not venue, so a team is as likely to sit in one column as the other.
  //
  // An UNLINKED court match (`team_match_id IS NULL`) is excluded rather than assumed to belong
  // here. That is the conservative direction on purpose: including it is how the defect above
  // happened, and the cost of excluding it is a refusal that says "pull this team first", which is
  // true and actionable. The count of what was set aside is reported rather than silently dropped.
  const ownTeamMatchIds = db
    .select({ id: teamMatches.id })
    .from(teamMatches)
    .where(or(eq(teamMatches.homeTeamId, teamId), eq(teamMatches.visitingTeamId, teamId)))
    .all()
    .map((r) => r.id);

  const ownCourtMatchIds = new Set<number>(
    ownTeamMatchIds.length === 0
      ? []
      : db
          .select({ id: courtMatches.id })
          .from(courtMatches)
          .where(inArray(courtMatches.teamMatchId, ownTeamMatchIds))
          .all()
          .map((r) => r.id),
  );

  const allPlayerRows = courtMatchRowsForPlayers(db, rosterPlayerIds);
  const courtRows = allPlayerRows.filter((row) => ownCourtMatchIds.has(row.id));
  const excludedOtherTeamMatches = allPlayerRows.length - courtRows.length;

  const observationRows =
    rosterPlayerIds.length === 0
      ? []
      : db.select().from(ratingObservations).where(inArray(ratingObservations.playerId, rosterPlayerIds)).all();
  const observationsByPlayer = new Map<number, typeof observationRows>();
  for (const obs of observationRows) {
    const list = observationsByPlayer.get(obs.playerId) ?? [];
    list.push(obs);
    observationsByPlayer.set(obs.playerId, list);
  }

  const prediction = predictedLineup({
    rows: courtRows,
    rosterPlayerIds,
    ratings: rosterPlayerIds.map((playerId) => ({
      playerId,
      observations: (observationsByPlayer.get(playerId) ?? []).map((o) => ({
        id: o.id,
        source: o.source,
        value: o.value,
        ratingType: o.ratingType,
        observedOn: o.observedOn,
      })),
    })),
    slotSet,
  });

  // `player #<id>` is unreachable in practice — every id below came from the roster query this map
  // was built from — and is kept only so a presenter can never be handed `undefined`, matching the
  // existing convention in `player-profile.ts` / `team-profile.ts`.
  const named = (playerId: number): LineupPlanPlayer => ({
    playerId,
    canonicalName: nameById.get(playerId) ?? `player #${playerId}`,
  });

  return {
    teamId: teamRow.id,
    teamName: teamRow.name,
    slots: prediction.slots.map((s) => ({
      slot: s.slot,
      discipline: s.discipline,
      players: s.playerIds.map(named),
      confidence: s.confidence,
      basis: s.basis,
      support: s.support,
    })),
    unplaced: prediction.unplaced.map((u) => ({ ...named(u.playerId), courtMatches: u.courtMatches })),
    ratingSource: prediction.ratingSource,
    ranked: prediction.rankedPlayerIds.map(named),
    unranked: prediction.unrankedPlayerIds.map(named),
    // Spread as the discriminated pair, never as two independent keys. `prediction.slotSource` is
    // not copied here because it is not a second source of truth: `predictedLineup` derives it from
    // whether `slotSet` was passed, and `slotSet` and `provenance` are set in the SAME branch above,
    // so the two agree by construction rather than by a check that could be forgotten.
    ...provenance,
    observedCourtMatches: prediction.observedCourtMatches,
    excludedOtherTeamMatches,
    rosterSize: rosterPlayerIds.length,
  };
}
