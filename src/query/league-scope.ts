// The shape of an event's EVIDENCE scope (#97) — which league contexts a dossier built for this
// event may draw on. This module owns BOTH directions of it, exactly as `event-format.ts` owns both
// directions of the court format: a human-typed CLI/MCP string in (`parseLeagueScope`) and the stored
// `events.league_scope` column value back out (`readLeagueScope`), through one shared validator each
// direction defers to, so the writer and the reader can never disagree about what a legal scope is.
//
// WHY THIS IS NOT PART OF `events.format`. The scope and the court format are read by different
// consumers and must be able to fail independently. `getLineupPlan` reads `format` and, per #97, is
// ALREADY correct — its evidence is restricted to court matches linked to the team's own
// `team_matches` rows (89 of 89 measured in-league), so it must ignore the scope entirely. Sharing a
// column would make the one reader that must ignore the scope the one reader obliged to decode it.
// `resolveEvent` also refuses an event with no format (`EventHasNoFormatError`), which folded would
// mean a scope could not exist without a court list. And `event-format.ts`'s round-trip guard pins
// the COURT grammar exactly; widening that grammar to carry a second concept re-opens a contract
// three adversarial review rounds hardened (PR #82).
//
// WHY THE PREDICATE IS EVALUATED IN JS, not as SQL `league_context NOT LIKE 'Mixed%'`. Three separate
// traps live in the SQL form: `%` and `_` inside a prefix are LIKE METACHARACTERS (so a scope naming
// a real league containing one would silently match far more than it named); SQLite's LIKE folds
// case for ASCII ONLY, so a non-ASCII source spelling is folded by neither SQLite nor a hand-written
// `lower()`; and `NOT LIKE` is NULL-PROPAGATING, so the unclassified rows below would be dropped by
// the SQL rather than by a decision anyone made. Filtering already-fetched rows removes all three
// and leaves the rule a pure function a test can drive directly. The whole live database is 790
// court matches, so nothing here is a scan worth pushing down.

import { z } from "zod";

/** `exclude` — drop every row a prefix positively matches. `only` — keep exactly those. The two are
 * exact inverses over CLASSIFIED rows (see `leagueScopeRetains` for what happens to unclassified
 * ones), which is what lets Springfield carry `exclude:Mixed` and September's mixed-doubles event
 * carry `only:Mixed` while both read the same court-match rows (#97's HC ruling). */
export type LeagueScopeMode = "exclude" | "only";

export type LeagueScope = {
  mode: LeagueScopeMode;
  /** Case-insensitive prefixes of `court_matches.league_context`, in the order typed. */
  prefixes: readonly string[];
};

/** Every reason a scope (human-typed or stored) is rejected — one class, so both directions collapse
 * to the same caller-fixable refusal rather than each inventing its own. Mirrors
 * `InvalidEventFormatError`. */
export class InvalidLeagueScopeError extends Error {}

// A CLOSED enum, and deliberately case-SENSITIVE, matching `event-format.ts`'s `discipline`: the two
// modes are exact opposites, so folding `Exclude` into `exclude` would put this module one typo away
// from silently applying the inverse of what was meant. There is no near-miss worth guessing at.
const modeSchema = z.enum(["exclude", "only"]);

/**
 * The structural shape of a stored scope. `.strict()` is load-bearing for the same reason it is in
 * `event-format.ts`: a value carrying keys our writer never emits came from somewhere else, and zod
 * would otherwise silently STRIP them — hiding them from the round-trip check below as well.
 *
 * Note what is deliberately NOT here: any rule about which characters a prefix may contain. That is
 * `assertWriterCouldHaveProduced`'s job, derived from the grammar rather than enumerated.
 */
const leagueScopeSchema = z
  .object({
    mode: modeSchema,
    prefixes: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** The comparison key for a prefix or a league context. JS's `toLowerCase` is Unicode-aware; SQLite's
 * `lower()` is ASCII-only, which is one of the three reasons this predicate is not pushed into SQL
 * (see the module comment, and `src/db/name-key.ts` for the same argument about names). */
function fold(value: string): string {
  return value.toLowerCase();
}

/** Refuses a scope naming the same prefix twice. Compared FOLDED, because the match itself is
 * case-insensitive: `Mixed` and `MIXED` are not two rules, they are one rule written twice, and
 * accepting both would print a label listing a distinction the predicate does not make. Shared by
 * both directions rather than checked once each. */
function requireDistinctPrefixes(prefixes: readonly string[]): void {
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    const key = fold(prefix);
    if (seen.has(key)) {
      throw new InvalidLeagueScopeError(`duplicate prefix "${prefix}" in league scope`);
    }
    seen.add(key);
  }
}

/**
 * CLI/MCP text -> a validated scope. Syntax: `<exclude|only>:<prefix>[,<prefix>…]`, e.g.
 * `exclude:Mixed` or `only:Mixed,Combo` — split on the FIRST `:` (so a prefix may itself contain a
 * colon, which several real league contexts could), then the remainder on `,`. Every part is
 * trimmed, so whitespace around the colon or a comma is accepted.
 *
 * Refuses (never guesses, never drops an entry): an empty or all-whitespace input; no colon at all;
 * a mode outside `exclude | only`; an empty prefix list; a blank prefix among real ones; and a
 * prefix repeated (case-insensitively). Every refusal names what was wrong so the message tells an
 * operator what to fix.
 */
export function parseLeagueScope(input: string): LeagueScope {
  const text = input.trim();
  if (text.length === 0) {
    throw new InvalidLeagueScopeError(
      'league scope is empty — expected "exclude:<prefix>" or "only:<prefix>", e.g. "exclude:Mixed"',
    );
  }

  const colonIndex = text.indexOf(":");
  if (colonIndex === -1) {
    throw new InvalidLeagueScopeError(
      `league scope "${input}" is missing "mode:prefix" — expected exclude | only, then a colon`,
    );
  }

  const modeText = text.slice(0, colonIndex).trim();
  const mode = modeSchema.safeParse(modeText);
  if (!mode.success) {
    throw new InvalidLeagueScopeError(
      `league scope "${input}" has an unknown mode "${modeText}" (expected exclude | only)`,
    );
  }

  const prefixText = text.slice(colonIndex + 1);
  if (prefixText.trim().length === 0) {
    throw new InvalidLeagueScopeError(`league scope "${input}" names no prefix to ${mode.data}`);
  }

  const prefixes: string[] = [];
  for (const rawPrefix of prefixText.split(",")) {
    const prefix = rawPrefix.trim();
    // Blank entries REFUSE rather than being filtered out: `exclude:Mixed,,Combo` is a typo, and
    // silently accepting it as two prefixes is how a third one someone meant to type goes missing.
    if (prefix.length === 0) {
      throw new InvalidLeagueScopeError(`league scope "${input}" contains a blank prefix`);
    }
    prefixes.push(prefix);
  }

  requireDistinctPrefixes(prefixes);
  return { mode: mode.data, prefixes };
}

/**
 * A scope -> the CLI/MCP text that would produce it. The inverse of `parseLeagueScope`, the exact
 * string `tn event add`'s summary line prints, and the input to the stored-value guard below — so
 * the round trip an operator performs by copying that line back into a command is the same one the
 * guard checks.
 */
export function leagueScopeText(scope: LeagueScope): string {
  return `${scope.mode}:${scope.prefixes.join(",")}`;
}

/**
 * A human sentence naming the scope, for the one thing #97 makes non-optional: a filtered record has
 * to say WHAT it filtered. Rendered from the scope itself rather than written as prose at each
 * surface, so the dossier, `tn player show` and `tn team show` cannot describe the same stored value
 * three different ways.
 */
export function leagueScopeLabel(scope: LeagueScope): string {
  const quoted = scope.prefixes.map((p) => `"${p}"`).join(" or ");
  const verb = scope.mode === "exclude" ? "excluding" : "only";
  return `${verb} league contexts starting with ${quoted}`;
}

/**
 * **The one predicate.** Whether a court match with this `league_context` survives the scope.
 *
 * A prefix MATCHES when the context is non-null and starts with it, folded (see `fold`). `exclude`
 * drops matches; `only` keeps them.
 *
 * **An unclassified row — `league_context IS NULL` — is retained under BOTH modes**, and the rule
 * behind that is one sentence: *a scope removes only what it can positively classify.* The concrete
 * reason it has to be this direction rather than the fail-closed one: `src/ingest/match-add.ts`
 * writes a null league context for EVERY court it records from an in-event scorecard photo (the
 * `docs/runbooks/in-event-screenshot-ingest.md` path). Those are the event's own courts — the most
 * in-scope evidence that exists — and dropping unclassified rows would silently discard exactly
 * them, in both directions, which is the same class of invisible evidence loss #97 was opened for.
 * Measured on the live database at the time of writing: 0 of 790 court matches are unclassified, so
 * this rule changes nothing about the Springfield binder; it is the rule for what arrives next.
 *
 * Callers do not infer the count of unclassified rows from this function — `courtMatchRowsForPlayers`
 * reports it as its own field, so "retained" never quietly means "retained, plus some we could not
 * classify".
 */
export function leagueScopeRetains(leagueContext: string | null, scope: LeagueScope): boolean {
  if (leagueContext === null) return true;
  const folded = fold(leagueContext);
  const matched = scope.prefixes.some((prefix) => folded.startsWith(fold(prefix)));
  return scope.mode === "exclude" ? !matched : matched;
}

/**
 * Refuses a decoded scope the WRITER could never have produced — by running it back through the
 * writer's own grammar and requiring an exact reproduction. Derived rather than enumerated, which is
 * the whole point; see `assertWriterCouldHaveProduced` in `event-format.ts` for the two review
 * rounds that argument came out of.
 *
 * Concretely here: `,` is the prefix delimiter, so a stored prefix containing one is unwritable and
 * is refused — while `:` is NOT (only the first one splits), so `"Mixed:Other"` IS producible and is
 * accepted. A character blacklist would have to get both of those right by hand, and would still be
 * wrong the next time the grammar moves. Leading or trailing whitespace on a stored prefix is
 * refused by the same mechanism, since the parser trims.
 */
function assertWriterCouldHaveProduced(scope: LeagueScope): void {
  let reparsed: LeagueScope;
  try {
    reparsed = parseLeagueScope(leagueScopeText(scope));
  } catch {
    // The writer's own grammar rejects it. Re-thrown with a STORED-value message, because
    // `parseLeagueScope`'s message describes text an operator typed, and nobody typed this.
    throw new InvalidLeagueScopeError(
      `stored league scope contains a prefix no "tn event add" league-scope could have written: ${JSON.stringify(scope)}`,
    );
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(scope)) {
    throw new InvalidLeagueScopeError(
      `stored league scope is not in the canonical form "tn event add" writes: ${JSON.stringify(scope)}`,
    );
  }
}

/**
 * A validated scope -> the exact string written to `events.league_scope`. Paired with
 * `readLeagueScope` below so ONE module owns the on-disk encoding as well as the shape: the column is
 * plain `text` rather than drizzle `{ mode: "json" }` for the same reason `events.format` is — see
 * that column's comment in `src/db/schema.ts`. Under `json` mode drizzle would parse this while
 * mapping EVERY row of the events table, so a hand-corrupted value would throw a raw `SyntaxError`
 * out of `eventsForDay` (`tn player avail`) and `match add` — commands with nothing to do with
 * evidence scopes — before any guard could see it.
 */
export function encodeLeagueScope(scope: LeagueScope): string {
  return JSON.stringify({ mode: scope.mode, prefixes: [...scope.prefixes] });
}

/**
 * The stored `events.league_scope` column value -> a validated scope, or `null` when the column is
 * null (no scope recorded — every league counts). **Fails closed**: anything our own writer would not
 * have produced throws a named `InvalidLeagueScopeError` rather than being coerced, silently dropped,
 * or surfacing as some other library's exception.
 *
 * Decoding happens here, and only here. Defense in depth: only `addEvent` writes this column in
 * production, but SQLite enforces no shape on a `text` column, so a hand-edited database is exactly
 * the case this exists for — and the failure it protects against is the worst one this issue has:
 * a dossier that names a scope it did not actually apply.
 */
export function readLeagueScope(raw: unknown): LeagueScope | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw !== "string") {
    throw new InvalidLeagueScopeError(`stored league scope is not text: ${JSON.stringify(raw)}`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // The message deliberately does NOT echo the stored bytes: an unparseable column value is
    // arbitrary content, and the operator needs the event and the fix, not the garbage.
    throw new InvalidLeagueScopeError(
      'stored league scope is not valid JSON — re-record it with tn event add <name> <kind> <starts-on> <ends-on> <format> "exclude:Mixed"',
    );
  }

  const result = leagueScopeSchema.safeParse(decoded);
  if (!result.success) {
    throw new InvalidLeagueScopeError(`stored league scope is malformed: ${JSON.stringify(decoded)}`);
  }

  const scope: LeagueScope = { mode: result.data.mode, prefixes: result.data.prefixes };
  requireDistinctPrefixes(scope.prefixes);
  assertWriterCouldHaveProduced(scope);
  return scope;
}
