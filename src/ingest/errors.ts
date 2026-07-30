/**
 * Thrown from inside a `sqlite.transaction` callback to abort it — better-sqlite3/drizzle roll
 * back automatically on a thrown error, which is exactly the "no partial write" guarantee spec §
 * Ingestion requires when an identity ladder call returns `ambiguous` mid-pull. The pipeline
 * catches this one specifically to turn it back into a reportable outcome.
 */
export class AmbiguousIdentityError extends Error {
  constructor(readonly candidates: string[]) {
    super(`ambiguous identity: ${candidates.join(", ")}`);
    this.name = "AmbiguousIdentityError";
  }
}
