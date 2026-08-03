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
 */
export function ambiguousMessage(identity: AmbiguousIdentity): string {
  return `ambiguous identity "${identity.incoming}" (${identity.context}) — near: ${identity.candidates.join(", ")}`;
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
 */
export class AmbiguousIdentityError extends Error implements AmbiguousIdentity {
  constructor(
    readonly incoming: string,
    readonly candidates: string[],
    readonly context: string,
  ) {
    super(ambiguousMessage({ incoming, candidates, context }));
    this.name = "AmbiguousIdentityError";
  }
}
