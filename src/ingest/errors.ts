/**
 * The three facts a human needs to rule on an ambiguous identity. Every producer of an
 * `{ kind: "ambiguous" }` outcome carries this shape, and every reporting surface renders it
 * through `ambiguousMessage` below.
 *
 * - `incoming` — the name being resolved, i.e. the one that needs a decision.
 * - `candidates` — what it was near, i.e. what it might be the same person as.
 * - `context` — WHERE it came from, so the same name in a roster row and in a match partner slot
 *   are distinguishable.
 *
 * All three are REQUIRED, deliberately. They were optional when #94's first pass landed, and an
 * optional fact is one a new call site can drop while the formatter quietly falls back to the
 * pre-#94 message — which is the defect, not a degraded version of the fix. Making them required
 * moves "every site reports all three" from a convention to something the compiler checks.
 */
export type AmbiguousIdentity = {
  incoming: string;
  candidates: string[];
  context: string;
};

/**
 * Every ambiguity ONE pass met, in encounter order, each recorded once. Non-empty by construction:
 * a tuple type, not an array, because "ambiguous" with nothing to rule on is not a state any
 * producer can be in, and a runtime emptiness check inside a formatter is a decision made at the
 * worst possible moment — while reporting a failure.
 *
 * It exists because a pull used to refuse at the FIRST ambiguity, which cost one slow network round
 * trip per remaining one: live, `Dale Dixon` took four attempts and `NE/Penland` needed three full
 * `--players` runs to surface six (#96). The refusal itself is unchanged — still one, still rolling
 * back, still writing nothing.
 */
export type AmbiguousIdentities = { identities: readonly [AmbiguousIdentity, ...AmbiguousIdentity[]] };

/** The three facts of ONE identity — the shared half of both renderings below. */
function identityFacts(identity: AmbiguousIdentity): string {
  return `"${identity.incoming}" (${identity.context}) — near: ${identity.candidates.join(", ")}`;
}

/**
 * The ONE rendering of an ambiguous identity, shared by every surface that reports one: this
 * error's own `message`, both CLI commands' `message=` field, the `--players` cascade warning, and
 * the MCP tools. It lives here — beside the error, not in `src/cli/emit.ts` where #94's first pass
 * put it — because the CLI is not the only reporter, and a formatter owned by one surface is a
 * formatter the other two can drift away from. `src/mcp/tools.ts` did exactly that: it kept
 * printing the pre-#94 `ambiguous target: <candidates>` while the CLI had moved on.
 *
 * "ambiguous target: Justin DuBois" was the whole message before #94, and it named only what the
 * incoming value was NEAR — never the value itself, nor where it came from. On a cascade that made
 * it actively misleading: the target it printed had resolved fine, and the real ambiguity was a
 * name inside that player's match history. All three facts are reported, or a human cannot act.
 *
 * It takes ONE identity or a whole pass's worth (#96), and renders a pass of one identically to a
 * bare one — a list of one is the same event, and a second spelling of one event is the drift this
 * function was moved here to prevent. That union is also what lets `src/cli/commands/player-pull.ts`
 * and `src/mcp/tools.ts` report every ambiguity of a pass without being edited at all: they already
 * hand this function the whole result object, so the richer shape reaches it through the call they
 * already make.
 *
 * Several render on ONE line, numbered, with the count stated FIRST. One line because every caller
 * sanitizes the rendered string as a unit (see `sanitizeValue`) and a line break is exactly what
 * that guard is for; the count first because it is computed from the list, so a scraped name that
 * spells `[2]` into itself contradicts the stated total rather than corroborating it.
 */
export function ambiguousMessage(reported: AmbiguousIdentity | AmbiguousIdentities): string {
  const identities: readonly [AmbiguousIdentity, ...AmbiguousIdentity[]] =
    "identities" in reported ? reported.identities : [reported];
  const [first, ...rest] = identities;
  if (rest.length === 0) return `ambiguous identity ${identityFacts(first)}`;
  return `${identities.length} ambiguous identities — ${identities
    .map((identity, index) => `[${index + 1}] ${identityFacts(identity)}`)
    .join("; ")}`;
}

/**
 * Thrown from inside a `sqlite.transaction` callback to abort it — better-sqlite3/drizzle roll
 * back automatically on a thrown error, which is exactly the "no partial write" guarantee spec §
 * Ingestion requires when an identity ladder call returns `ambiguous` mid-pull. The pipeline
 * catches this one specifically to turn it back into a reportable outcome.
 *
 * It carries the three facts above, because two of them used to be dropped and the outcome was an
 * error nobody could act on (issue #94). A real one read:
 *
 *   team pull: cascading "John Jennings" failed (ambiguous) — skipped
 *
 * John Jennings was not the problem — he resolved exactly. The ambiguity was a name encountered
 * while ingesting HIS match history (it was `Austin DuBois`, a match opponent, near the
 * already-on-file `Justin DuBois`), and the message named the cascade target instead. The
 * candidates that WERE carried named only the existing side, never the incoming name that failed
 * to resolve. So the report pointed at the wrong person and omitted the one fact a human needs.
 *
 * The `message` is `ambiguousMessage` itself rather than a second string saying the same thing a
 * little differently: this one is what surfaces in a stack trace or an unexpected rethrow, and a
 * debugging read of stderr should not have to reconcile two spellings of one event.
 *
 * It carries the whole pass's `identities` (#96), because that is what has to cross the `throw` that
 * rolls the transaction back — the collection is built inside the transaction callback and read in
 * the `catch` outside it, and putting it on the error rather than in a variable the catch closes
 * over means the value the catch reports and the value the message renders cannot disagree.
 *
 * `incoming` / `candidates` / `context` MIRROR `identities[0]`, derived here so they cannot drift.
 * They stay because three kinds of reader depend on them: the `catch` blocks in `archived.ts` and
 * `team-pull.ts` build their single-identity results from them,
 * `test/ingest-upsert-idempotency.test.ts` reads `candidates` off a caught error, and every
 * `{ kind: "ambiguous" }` result keeps the flat shape #94 gave it so the CLI and MCP surfaces need
 * no edit to keep reporting a true fact.
 */
export class AmbiguousIdentityError extends Error implements AmbiguousIdentity {
  readonly incoming: string;
  readonly candidates: string[];
  readonly context: string;
  readonly identities: readonly [AmbiguousIdentity, ...AmbiguousIdentity[]];

  constructor(identities: readonly [AmbiguousIdentity, ...AmbiguousIdentity[]]) {
    super(ambiguousMessage({ identities }));
    const [first] = identities;
    this.incoming = first.incoming;
    this.candidates = first.candidates;
    this.context = first.context;
    this.identities = identities;
    this.name = "AmbiguousIdentityError";
  }
}
