// nadal's accepted register lives on the tracker, not in a file: an accepted
// finding IS a closed issue labelled `residual` (PROJECT.md -> Findings-Log
// Discipline). Upstream reads `findings/accepted.md`; this repository has no
// such file and deliberately does not grow one, because a second copy of the
// register drifts from the tracker with nothing watching.
//
// The impure half is injected rather than imported, following dispatch.ts: the
// decisions here are testable exactly, and the two `gh` calls live at the one
// edge in summon.ts that already shells out.

export const ACCEPTED_LABEL = "residual";

export interface ResidualIssue {
  number: number;
  title: string;
}

export interface RegisterSource {
  /** Whether the label itself exists on the repository. Separate from the
   *  listing on purpose — see readAcceptedRegister. */
  labelExists(label: string): boolean;
  listClosed(label: string): ResidualIssue[];
}

/** Reads the accepted register as summons-ready bullet lines.
 *
 *  **Why the label is probed before anything is listed.** Measured on #155:
 *  `gh issue list --state closed --label residual-typo` returns `[]` and exits
 *  **0**. So a renamed, deleted or mistyped label is indistinguishable from a
 *  genuinely empty register by exit code — and the two mean opposite things.
 *  An empty register reaches the reviewer as `- none accepted to date`
 *  (compose.ts), which for a broken label is a lie that re-opens every settled
 *  question on the record. Checking the exit code alone does not close this;
 *  only asking whether the label exists does.
 *
 *  A present label with no residuals is not an error — that empty register is
 *  true, and it is returned as one. */
export function readAcceptedRegister(
  source: RegisterSource,
  label: string = ACCEPTED_LABEL,
): string[] {
  if (!source.labelExists(label)) {
    throw new Error(
      `the accepted register's label \`${label}\` does not exist on this repository — ` +
        "refusing to report a register that was never queried as an empty register",
    );
  }
  return source
    .listClosed(label)
    .map((issue) => `- #${issue.number} — ${issue.title}`);
}

/** How high a listing may go before it is refused as truncated. */
export const REGISTER_LIMIT = 1000;

/** Turns a `gh issue list --json number,title` payload into rows, refusing
 *  everything it cannot vouch for. Pure, and separate from the process that
 *  produced the string, so every branch below is reachable from a test — the
 *  guards are the point of the module and an untestable guard is a claim. */
export function parseRegisterListing(
  json: string,
  label: string = ACCEPTED_LABEL,
  limit: number = REGISTER_LIMIT,
): ResidualIssue[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error(`the \`${label}\` listing returned ${typeof parsed}, not an array`);
  }
  if (parsed.length >= limit) {
    throw new Error(
      `the \`${label}\` listing hit its ${limit}-row limit — the register is truncated, and a ` +
        "truncated register suppresses accepted findings exactly as silently as an empty one",
    );
  }
  return parsed.map((row: unknown, i: number) => {
    const r = row as Partial<ResidualIssue>;
    if (typeof r?.number !== "number" || typeof r?.title !== "string") {
      throw new Error(`the \`${label}\` listing row ${i} carries no number/title pair`);
    }
    return { number: r.number, title: r.title };
  });
}

/** Reads a label-existence probe's exit into the one bit the register needs.
 *
 *  Three outcomes, never two: **present** (exit 0), **absent** (a 404 — the only
 *  nonzero that answers the question), and **unknown** (any other failure — an
 *  expired token, a rate limit, a partition), which throws rather than passing
 *  itself off as absence. Collapsing the third into the second is what would put
 *  "the label does not exist" on an auth error. */
export function classifyLabelProbe(
  status: number | null,
  detail: string,
  label: string = ACCEPTED_LABEL,
): boolean {
  if (status === 0) return true;
  if (/HTTP 404|Not Found/i.test(detail)) return false;
  throw new Error(
    `checking the \`${label}\` label failed for a reason other than its absence ` +
      `(exit ${status}): ${detail.slice(0, 500)}`,
  );
}
