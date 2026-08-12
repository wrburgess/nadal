// Composes a summons at dispatch time, from the canonical documents — never
// from copies. The summons carries the standards (Chapter 0, mechanism one);
// its content and bounds are Chapter 2's *The summons, completed*.

export const PERMANENT_LENS = "what class is not on this list?";

// Dispatch bound, not a posting bound: over this, the tool stops rather than
// truncates — a truncated scope is a review of something else.
export const MAX_DIFF_BYTES = 200_000;

export interface SummonsInput {
  prNumber: number;
  subject: string;
  commit: string;
  lenses: string[];
  severityFramework: string;
  acceptedEntries: string[];
  diff: string;
  reviewerName: string;
}

/** Reads the severity framework out of `config/review.md` — nadal's own review
 *  configuration, alongside the roster and the lens menu that `roster.ts` and
 *  `lenses.ts` already parse from that file (#155).
 *
 *  Upstream this read deuce's `sds/02-review-and-findings.md` -> *The severity
 *  framework*. nadal cannot: canon is read at its source and never vendored
 *  (CLAUDE.md), so a runtime read of a chapter file could only ever fail here.
 *  Section-shaped, not frontmatter, for the reason `config/review.md` states
 *  about itself — this repository is pinned before deuce's frontmatter
 *  migration. */
export function extractSeverityFramework(configMarkdown: string): string {
  const at = configMarkdown.search(/^##\s+Severity framework\s*$/m);
  if (at === -1) {
    throw new Error(
      "config/review.md carries no '## Severity framework' section — the summons has no severity vocabulary to send",
    );
  }
  // Bounded at the next section, the way parseRoster bounds its own: running on
  // would send the reviewer a neighbouring policy as though it were severity.
  return configMarkdown.slice(at).split(/\n##\s/)[0]!;
}

export function composeSummons(input: SummonsInput): string {
  const diffBytes = Buffer.byteLength(input.diff, "utf8");
  if (diffBytes > MAX_DIFF_BYTES) {
    throw new Error(
      `diff is ${diffBytes} bytes, over the ${MAX_DIFF_BYTES}-byte dispatch bound — ` +
        "narrow the scope; the tool never truncates a scope silently",
    );
  }
  const lenses = [...input.lenses, `${PERMANENT_LENS} (the permanent lens)`];
  const accepted =
    input.acceptedEntries.length > 0
      ? input.acceptedEntries.join("\n")
      : "- none accepted to date";

  return `# Review summons — PR #${input.prNumber} at \`${input.commit}\`

You are summoned as a contractor reviewer: ${input.reviewerName}. Read \`AGENTS.md\` at the
repository root — you review; you never implement, commit, push, or modify a file. Your
standards are in this summons; if something you need is missing from it, say so in your
response rather than inventing a standard.

## Subject

- **Pull request:** PR #${input.prNumber} — ${input.subject}
- **Commit reviewed:** \`${input.commit}\` — bind your review to exactly this commit and name it in your output.
- **Scope:** the whole diff below. Nothing outside it is commissioned; anything you notice
  outside it, report as an observation and it will be routed, never dropped.

## Lens set

Answer every lens. A lens with no findings is answered explicitly with a line of the shape
\`- **Lens:** <the lens> — no findings\` — never silently skipped. An unanswered lens makes
the review nonconforming.

${lenses.map((l, i) => `${i + 1}. ${l}`).join("\n")}

## Severity framework — use only this vocabulary

${input.severityFramework.trim()}

## Findings already accepted — do not re-litigate

New evidence about an accepted finding is a new finding that cites the old one, never a
re-opening.

${accepted}

## Required output shape

For each finding, exactly these fields:

- **Lens:** the lens that raised it
- **Type:** defect | risk | improvement | lesson
- **Severity:** must-fix | should-fix | note
- **Location:** file and line, or section
- **Defect:** stated concretely enough to be disposed of

End your review with these two lines:

- **Commit reviewed:** \`${input.commit}\`
- **Signed:** your tool and your model, human-readable

## Diff

\`\`\`diff
${input.diff}
\`\`\`
`;
}
