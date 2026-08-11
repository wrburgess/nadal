// DB assembly for a team's predicted lineup (#17 PR B) — the sibling of `team-profile.ts` and
// `player-profile.ts`, and thin for the same reason: it fetches rows with drizzle, hands them to
// `derive.ts`'s pure `predictedLineup`, and attaches the names a presenter needs. The heuristic
// itself lives entirely in `derive.ts`, where it can be tested exhaustively against hand-built
// inputs; nothing here re-implements a rule.
//
// Spec § Deliverables 1 asks for "a predicted lineup honestly labeled a guess". Every name this
// module resolves exists so a presenter can print a person rather than a database id — the exact
// defect #16 shipped and #17 PR A fixed one layer over.

import { eq, inArray, or } from "drizzle-orm";
import { courtMatches, events, ratingObservations, teamMatches, teams } from "../db/schema.js";
import type { Db } from "../ingest/db-types.js";
import { NoCourtMatchHistoryError, predictedLineup } from "./derive.js";
import type { EventCourt } from "./event-format.js";
import { readEventFormat } from "./event-format.js";
import type { LeagueScope } from "./league-scope.js";
import { readLeagueScope } from "./league-scope.js";
import { courtMatchRowsForPlayers } from "./player-profile.js";
import { resolveRoster } from "./roster.js";
import type { CourtMatchRow, LineupBasis, LineupConfidence, RatingSource, Side } from "./types.js";

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

/** Brands `ResolvedEvent` so only `resolveEvent` can build one. A REAL symbol, not a
 * `declare const` phantom: a type-only brand disappears at runtime, so the object literal below
 * would have thrown `resolvedEvent is not defined` on the first call — caught by the tests
 * immediately. Not exported, so no caller outside this module can name the key, and a `const`
 * symbol is typed `unique symbol`, so none can forge it structurally either. */
const resolvedEvent = Symbol("resolvedEvent");

/**
 * A named event, already looked up and validated in ONE read: the slot set to predict across, the
 * evidence scope to draw records from (#97), and the identity of the event both came from. Resolved
 * once by `resolveEvent` and reusable across many `getLineupPlan` / `buildTeamDossier` calls.
 *
 * **One read, two columns, deliberately.** `events.format` and `events.league_scope` are read by
 * different consumers, but they must be read at the same instant. nadal runs `tn mcp serve` beside a
 * CLI invocation against one WAL database, so a `tn event add` committing between two separate
 * lookups is an ordinary concurrent-process interleaving — and two lookups would let one
 * `report build` predict across version A's courts while naming version B's evidence scope. That is
 * the same cross-process race Codex rated high on PR #82 (Finding 1), one column over, and the fix
 * is the same: resolve once, hand the value down.
 *
 * **Opaque by construction, for a reason a plain structural type could not carry.** As loose public
 * fields, a caller could resolve event A and event B and hand over `{ slotSet: A.slotSet,
 * event: B.event }` — predicting across A's courts while all three presenters state the courts came
 * from B. That needs no `any` and no malformed data, and it defeats the provenance guarantee this
 * exists to provide. Carrying only the event's IDENTITY, and letting `getLineupPlan` derive the
 * provenance from it, removes the second field to disagree with; the brand removes the ability to
 * fabricate the first. (Codex adversarial review of PR #82, round 2, Finding 2 [medium].)
 */
export type ResolvedEvent = {
  readonly event: { readonly id: number; readonly name: string };
  /** The event's own kind and date range, carried so consumers need no second read of the row —
   * which would reintroduce the very two-read window this type exists to close. Two consumers:
   * `requireSlotSet` renders a copy-pasteable `tn event add` line from it inside the refusal path,
   * and (#122) `team show`/`player show` (CLI and MCP) anchor their 12-month evidence window to
   * `startsOn`. Deliberately kept out of `event` above, which stays the two fields a presenter may
   * state as provenance. */
  readonly recordedAs: {
    readonly kind: string;
    readonly startsOn: string | null;
    readonly endsOn: string | null;
  };
  /** `null` when no format is on file. Callers that REQUIRE one go through `requireSlotSet`, which
   * carries the refusal — this type deliberately does not, so an event can carry an evidence scope
   * without also being obliged to carry a court list. */
  readonly slotSet: readonly EventCourt[] | null;
  /** #97's evidence scope, or `null` when none is on file (every league counts — the pre-#97
   * behavior). Read by `getTeamProfile` / `getPlayerProfile`; deliberately IGNORED by
   * `getLineupPlan`, see its doc comment. */
  readonly leagueScope: LeagueScope | null;
  readonly [resolvedEvent]: true;
};

/**
 * Looks up a named event and validates BOTH of its stored structured columns, or refuses. Exact
 * match against `events.name` (the unique key) — the same resolve-by-name-or-refuse mechanism
 * `src/ingest/match-add.ts` already uses; nothing is inferred from a partial or fuzzy match.
 *
 * **Separated from `getLineupPlan` so a BATCH caller can resolve once and reuse.** `tn report build`
 * renders one dossier per team, and nadal genuinely runs two PROCESSES against one WAL database
 * (`tn mcp serve` beside a CLI invocation), so a concurrent `tn event add` committing between two
 * teams' dossiers would otherwise let ONE batch emit a two-court dossier and a four-court dossier
 * that each name the same event — while `docs/cli/GRAMMAR.md` promises the named event's format
 * applies to *every* dossier the run builds. A per-team lookup cannot keep that promise; one
 * up-front resolution can. (Codex adversarial review of PR #82, Finding 1 [high].) #97 puts the
 * evidence scope under the same guarantee, in the same read.
 *
 * Resolving up front also moves the refusal EARLIER, which is the same batch discipline
 * `writeSectionalsDossiers` already applies to filesystem leaves: a bad event name now refuses
 * before any dossier is prepared, rather than on the first team that happens to have court history
 * — and it closes the case where a build over a team set that is empty, or entirely without
 * history, would have accepted an unknown event name in silence.
 *
 * **What this does NOT refuse, deliberately: a missing format.** That refusal moved to
 * `requireSlotSet` below, so that #97's evidence scope is reachable on an event with no court list.
 * Every existing caller that needed the old behavior calls `requireSlotSet` at the same point
 * `resolveEventFormat` used to throw, so refusal timing is unchanged for all of them.
 *
 * A CORRUPTED stored value in either column still refuses here, fail-closed: `readEventFormat` first
 * (`InvalidEventFormatError`), then `readLeagueScope` (`InvalidLeagueScopeError`). The format is
 * checked first so an event whose columns are both damaged reports them in the order they are typed.
 * This does mean `tn lineup plan <team> <event>` now refuses on an unreadable LEAGUE SCOPE, a column
 * it does not itself use — accepted, and the right direction: an unreadable scope means the database
 * has been hand-edited into a shape our writer cannot produce, and the neighbouring command quietly
 * proceeding would be the surprising outcome, not the refusal. Unreachable through `tn event add`.
 */
export function resolveEvent(db: Db, eventName: string): ResolvedEvent {
  const eventRow = db.select().from(events).where(eq(events.name, eventName)).all()[0];
  if (eventRow === undefined) throw new UnknownEventError(`unknown event "${eventName}"`);
  // Both readers throw their own distinct, presenter-renderable class on a corrupted stored value
  // (defense in depth — only `addEvent` writes these columns in production) — allowed to propagate
  // as-is rather than being re-wrapped.
  const format = readEventFormat(eventRow.format);
  const leagueScope = readLeagueScope(eventRow.leagueScope);
  const resolved = {
    event: Object.freeze({ id: eventRow.id, name: eventRow.name }),
    recordedAs: Object.freeze({ kind: eventRow.kind, startsOn: eventRow.startsOn, endsOn: eventRow.endsOn }),
    // Deep-frozen, not merely `readonly`: `readonly` is erased at compile time, so a holder could
    // reach through `resolved.slotSet[0].slot = "…"` and mutate the courts a whole batch is
    // predicting across, between one team and the next.
    slotSet: format === null ? null : Object.freeze(format.map((court) => Object.freeze({ ...court }))),
    // Frozen for the same reason, one level shallower (its `prefixes` array is the only reachable
    // mutable): a holder editing the scope mid-batch would give two teams in one run different
    // evidence while both dossiers name the same event.
    leagueScope:
      leagueScope === null
        ? null
        : Object.freeze({ mode: leagueScope.mode, prefixes: Object.freeze([...leagueScope.prefixes]) }),
  };
  // NON-enumerable, so object spread and `Object.assign` do not carry it — `{ ...a, slotSet: b.slotSet }`
  // therefore produces a value without the brand, which `getLineupPlan` rejects at runtime.
  Object.defineProperty(resolved, resolvedEvent, { value: true, enumerable: false });
  return Object.freeze(resolved) as ResolvedEvent;
}

/**
 * The slot set a caller REQUIRES, or the refusal. No silent fall back to the observed slot set when
 * a named event has no format: that would be the exact silent-lie class this repo has logged before.
 *
 * Split out of `resolveEvent` (#97) so that an evidence scope does not have to be accompanied by a
 * court list to exist. Called at the same point `resolveEventFormat` used to throw — immediately
 * after resolution, before any dossier is prepared — so "a bad event aborts the whole build with
 * nothing written" is unchanged.
 */
export function requireSlotSet(resolved: ResolvedEvent): readonly EventCourt[] {
  if (resolved.slotSet !== null) return resolved.slotSet;
  const { kind, startsOn, endsOn } = resolved.recordedAs;
  throw new EventHasNoFormatError(
    `event "${resolved.event.name}" has no format on file — add one first, e.g. ` +
      `tn event add "${resolved.event.name}" ${kind} ${startsOn ?? "<starts-on>"} ` +
      `${endsOn ?? "<ends-on>"} "S1:singles,D1:doubles"`,
  );
}

/** Runtime half of the opacity guarantee. The brand's TYPE stops a caller naming it; this stops a
 * caller reconstructing the value around it — and the two are not redundant, because TypeScript
 * models an object spread from the declared type, so `{ ...a }` can still typecheck as a
 * `ResolvedEvent` while carrying no brand at runtime. Checking here is what makes the
 * non-enumerable brand mean something rather than merely look like it does. */
function assertResolvedByUs(value: ResolvedEvent): void {
  if ((value as Record<symbol, unknown>)[resolvedEvent] !== true) {
    throw new Error(
      "getLineupPlan: the resolved event was not produced by resolveEvent — a copied or " +
        "reconstructed value can pair one event's courts with another event's identity, which is the " +
        "provenance guarantee this type exists to hold",
    );
  }
}

/** What `ownTeamCourtMatchRows` returns: the evidence, and how much of these players' history it
 * had to set aside to get it. The two travel together for the same reason `CourtMatchEvidence`'s do
 * — a caller cannot obtain the restricted rows without also being handed the number that makes an
 * honest zero explicable. */
export type OwnTeamCourtMatches = {
  rows: CourtMatchRow[];
  /** Court matches these players appeared in that belong to some OTHER team (or to no team match on
   * file) and were therefore not used as evidence. */
  excludedOtherTeamMatches: number;
  /**
   * For each retained court match, which `side` label THIS team's players carry on it — `"home"`
   * when the team sits in `team_matches.home_team_id`, `"visiting"` otherwise.
   *
   * Needed because "this court match is ours" and "this player was on our side of it" are different
   * facts, and a roster read only the first way conflates them. A player who is on our roster *now*
   * may have played a court under one of our team matches **for the opponent** — they changed teams
   * between seasons — and two such players share a side with each other, so anything counting
   * same-side partnerships sees a partnership that was never ours. Found by the independent Codex
   * review of PR #137 (class A).
   *
   * Safe to derive despite [#72](https://github.com/wrburgess/nadal/issues/72), which records that
   * `home`/`visiting` encode *pull perspective* rather than real home/away: that residual is about
   * the labels not being stable across pull ORDER, and it states that every column flips **together**
   * so a row stays self-consistent. This map reads `home_team_id` and `side` off the same row, so it
   * asks only the question the labels can answer — which side is ours *on this row* — never which
   * team physically hosted.
   *
   * Additive: `getLineupPlan` below does not read it, so its evidence set and its output are
   * unchanged (pinned by its existing tests passing untouched).
   */
  ourSideByCourtMatch: Map<number, Side>;
};

/**
 * Court matches `playerIds` appeared in that are THIS TEAM's own — not merely court matches its
 * players appear in.
 *
 * Spec § Ingestion ingests a player's full history "including their other leagues (18+ etc.)", so a
 * roster member's matches are mostly NOT this team's matches. Selecting by player id alone let one
 * team's predicted lineup be built from partnerships those players formed elsewhere — a confident
 * "8 matches together" for a pair that has never once played together for this team, and a lineup
 * for a newly assembled roster that should have refused outright. Found by the independent Codex
 * review of PR #47 (rated high).
 *
 * The association is `court_matches.team_match_id` -> `team_matches`, which `player-pull` sets
 * whenever a `team_matches` row already exists for the same `mid=` (i.e. whenever `tn team pull` has
 * seen this team's schedule). Both sides are checked: home/visiting are pull-perspective labels, not
 * venue, so a team is as likely to sit in one column as the other.
 *
 * An UNLINKED court match (`team_match_id IS NULL`) is excluded rather than assumed to belong here.
 * That is the conservative direction on purpose: including it is how the defect above happened, and
 * the cost of excluding it is a refusal that says "pull this team first", which is true and
 * actionable. The count of what was set aside is reported rather than silently dropped.
 *
 * **No league scope, deliberately** (#97): `courtMatchRowsForPlayers` is called WITHOUT one, because
 * the team linkage this function applies is the stronger restriction — see `getLineupPlan`'s doc
 * comment for the measurement and the pinned test. Extracted out of `getLineupPlan` for #127 so
 * `tn lineup build` scopes its shared-match evidence through the SAME function rather than growing a
 * second answer to "which matches count as ours" — the one defect class this whole restriction
 * exists to hold shut.
 */
export function ownTeamCourtMatchRows(db: Db, teamId: number, playerIds: number[]): OwnTeamCourtMatches {
  // `homeTeamId` comes back alongside the id so our SIDE on each team match is read off the same row
  // that established the match is ours — see `ourSideByCourtMatch` on the return type for why that
  // co-location is what makes the derivation safe under #72.
  const ownTeamMatchRows = db
    .select({ id: teamMatches.id, homeTeamId: teamMatches.homeTeamId })
    .from(teamMatches)
    .where(or(eq(teamMatches.homeTeamId, teamId), eq(teamMatches.visitingTeamId, teamId)))
    .all();
  const ownTeamMatchIds = ownTeamMatchRows.map((r) => r.id);
  const ourSideByTeamMatch = new Map<number, Side>(
    ownTeamMatchRows.map((r) => [r.id, r.homeTeamId === teamId ? "home" : "visiting"]),
  );

  const ownCourtRows =
    ownTeamMatchIds.length === 0
      ? []
      : db
          .select({ id: courtMatches.id, teamMatchId: courtMatches.teamMatchId })
          .from(courtMatches)
          .where(inArray(courtMatches.teamMatchId, ownTeamMatchIds))
          .all();
  const ownCourtMatchIds = new Set<number>(ownCourtRows.map((r) => r.id));
  const ourSideByCourtMatch = new Map<number, Side>();
  for (const row of ownCourtRows) {
    const side = row.teamMatchId === null ? undefined : ourSideByTeamMatch.get(row.teamMatchId);
    if (side !== undefined) ourSideByCourtMatch.set(row.id, side);
  }

  const allPlayerRows = courtMatchRowsForPlayers(db, playerIds).rows;
  const rows = allPlayerRows.filter((row) => ownCourtMatchIds.has(row.id));
  return { rows, excludedOtherTeamMatches: allPlayerRows.length - rows.length, ourSideByCourtMatch };
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
  /** `resolveRoster`'s own discriminant (#113), carried through unchanged: `"registered"` when the
   * named event has a registered roster, `"season"` otherwise — including when no event was named
   * at all. Lets `format-lineup.ts`'s trailer state which roster the prediction actually drew on. */
  rosterSource: "registered" | "season";
  registeredCount: number;
  seasonCount: number;
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
 * The roster itself now goes through `resolveRoster` (#113), the same choke point
 * `getTeamProfile` reads through: a named event with a REGISTERED roster (`tn roster set`, or a
 * hand-seeded event membership) restricts prediction to the players who registered, falling back to
 * the full season roster when the event has none — never a union of every event-scoped row a player
 * happens to carry. A player is therefore counted ONCE here regardless of how many
 * `team_memberships` rows they hold: the roster this function predicts across is a SET of people
 * drawn from exactly one scope, and a duplicate id would let the same player be placed on two
 * courts.
 *
 * **#97's evidence scope is deliberately NOT applied here, and this is the one reader that must not
 * change.** The obvious assumption is the opposite, so it is stated rather than left to be inferred:
 * a predicted lineup is already scoped by something stronger than a league predicate — its evidence
 * is restricted to court matches linked to one of THIS TEAM's own `team_matches` rows, and those
 * come from the team's own league page. Measured on the live database when #97 was written: 89 of 89
 * of this function's evidence rows were already `Adult 40+ 3.5`. Applying a league scope on top would
 * be a filter on an already-filtered set that removes nothing and implies a correctness this
 * function gets from the team linkage instead. `courtMatchRowsForPlayers` is therefore called
 * WITHOUT a scope below, and `resolved.leagueScope` is read by nothing in this function — pinned by
 * a test that seeds a Mixed court match against the team's OWN team match, so the assertion would
 * fail if a scope ever leaked in.
 */
export function getLineupPlan(db: Db, teamId: number, event?: string | ResolvedEvent): LineupPlan {
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
  const resolved: ResolvedEvent | undefined =
    event === undefined ? undefined : typeof event === "string" ? resolveEvent(db, event) : event;
  if (resolved !== undefined) assertResolvedByUs(resolved);
  // `requireSlotSet` carries the "named event has no format" refusal that `resolveEventFormat` used
  // to throw itself (#97 split it out so an evidence scope can exist without a court list). Called
  // here, immediately after resolution and before any roster or court-match read, so the refusal
  // lands at exactly the same point in the sequence it always did.
  const slotSet = resolved === undefined ? undefined : [...requireSlotSet(resolved)];
  // Derived from the resolved event's own identity, never accepted as a second field alongside the
  // slot set — so the courts predicted and the event named can not disagree.
  const provenance: LineupSlotProvenance =
    resolved === undefined
      ? { slotSource: "observed", slotEvent: null }
      : { slotSource: "event-format", slotEvent: { id: resolved.event.id, name: resolved.event.name } };

  // Issue #49: a retired member must never be predicted onto a court — the headline symptom the
  // issue was filed for. `resolveRoster` already excludes a retired row (#113); a retired player
  // excluded here can never surface in a slot, an unplaced list, or a rating rank. `eventId` is the
  // ALREADY-RESOLVED event's own identity, never a name looked up again — the same "resolve once,
  // thread it down" discipline `slotSet`/`provenance` above follow.
  const rosterResolution = resolveRoster(db, { teamId, eventId: resolved?.event.id ?? null });
  const rosterRows = rosterResolution.members;

  const nameById = new Map<number, string>();
  for (const r of rosterRows) nameById.set(r.playerId, r.canonicalName);
  // Sorted so the roster handed to the pure layer is order-stable, and de-duplicated via the Map
  // above (see the doc comment: one person, however many event-scoped membership rows).
  const rosterPlayerIds = Array.from(nameById.keys()).sort((a, b) => a - b);

  // Evidence must be THIS TEAM's court matches, not merely court matches its players appear in —
  // the whole rule, and the review history behind it, lives on `ownTeamCourtMatchRows` above, which
  // `getLineupBuild` (#127) shares so the two lineup readers cannot disagree about which matches
  // count as ours. No league scope is passed there, deliberately: see this function's own doc
  // comment, and #97 names this reader as the one that must not change.
  const { rows: courtRows, excludedOtherTeamMatches } = ownTeamCourtMatchRows(db, teamId, rosterPlayerIds);

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
    rosterSource: rosterResolution.source,
    registeredCount: rosterResolution.registeredCount,
    seasonCount: rosterResolution.seasonCount,
  };
}
