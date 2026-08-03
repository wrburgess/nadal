/**
 * Thrown from inside a `sqlite.transaction` callback to abort it — better-sqlite3/drizzle roll
 * back automatically on a thrown error, which is exactly the "no partial write" guarantee spec §
 * Ingestion requires when an identity ladder call returns `ambiguous` mid-pull. The pipeline
 * catches this one specifically to turn it back into a reportable outcome.
 *
 * It carries THREE facts, because two of them used to be dropped and the outcome was an error
 * nobody could act on (issue #94). A real one read:
 *
 *   team pull: cascading "John Jennings" failed (ambiguous) — skipped
 *
 * John Jennings was not the problem — he resolved exactly. The ambiguity was a name encountered
 * while ingesting HIS match history, and the message named the cascade target instead. The
 * candidates that WERE carried named only the existing side (`Justin DuBois`), never the incoming
 * name that failed to resolve. So the report pointed at the wrong person and omitted the one fact
 * a human needs to rule on it.
 *
 * - `incoming` — the name being resolved, i.e. the one that needs a decision.
 * - `candidates` — what it was near, i.e. what it might be the same person as.
 * - `context` — WHERE it came from, so the same name in a roster row and in a match partner slot
 *   are distinguishable.
 */
export class AmbiguousIdentityError extends Error {
  constructor(
    readonly incoming: string,
    readonly candidates: string[],
    readonly context: string,
  ) {
    super(`ambiguous identity for "${incoming}" (${context}) — near: ${candidates.join(", ")}`);
    this.name = "AmbiguousIdentityError";
  }
}
