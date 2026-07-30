---
name: listen
description: Review-response step of the Deliver stage. Fetch every review thread on an existing PR, classify findings by severity, then dispose — autonomously within a `ship` run (backstopped by `ship`'s emergency stop #3), or by asking the HC which to address when run standalone — then fix, re-check, and reply. Use when a Reviewer (human or AI) has left feedback on the PR.
---

<what-to-do>

Read and respond to the review comments on the existing PR named in the invocation. This supports
**Stage 5 (Deliver)** of the [development lifecycle](../../docs/standards/development-lifecycle.md).

Read host-specific values — the review severities from [`PROJECT.md`](../../PROJECT.md) → *Review
Severity Framework*, the quality-check commands from *Quality Checks*, the lifecycle host from
*Lifecycle Host*, the attribution/model from *Attribution & Model Declaration*. Never hardcode them.

**This stage operates on the existing PR — it never opens one.** Its disposition is **context-aware**
([ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md) decision 6),
because the backstop that makes autonomy safe lives only in `ship`:

- **Within a `ship` run** it disposes **autonomously** — classify by severity, apply the clear findings,
  and escalate only the architectural / ambiguous / multiply-interpretable ones. `ship`'s **emergency
  stop #3** always catches those, as a *pause* the run re-seeds from, not a termination.
- **Run standalone** (`/listen` with no `ship` around it) there is no emergency stop #3, so it stays
  **human-in-the-loop**: you summarize and propose, but you change nothing until the HC chooses which
  findings to address.

This replaces the former blanket "wait for the HC to choose"; the surviving escalation is emergency
stop #3 ([ADR 0026](../../docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
decision 7).

</what-to-do>

<procedure>

1. **Fetch every review thread** via the lifecycle host ([`PROJECT.md`](../../PROJECT.md) → *Lifecycle
   Host*). Capture **all** thread kinds, not just top-level PR comments: issue-level PR comments,
   **inline diff-thread comments**, and **review bodies**. A common trap is reading only the
   issue-level comments — an inline review (e.g. from an automated code-review tool) is then invisible.
   Pull whichever surfaces your host exposes so no reviewer is missed.

   These are the same three surfaces [`PROJECT.md`](../../PROJECT.md) → *Reviewer* defines as
   constituting a **response**, and [`verify`](../../skills/verify/SKILL.md) polls when it summons —
   keep the two readings identical, or a review that counted as a response there becomes invisible
   here. **`verify` owns the summons; this stage never issues one** — if there are no threads to
   fetch, the Reviewer was never summoned or its floor was skipped: stop and recheck, don't proceed on
   an unreviewed PR.
2. **Classify each finding by severity** using [`PROJECT.md`](../../PROJECT.md) → *Review Severity
   Framework* (Critical / High / Medium / Low), plus a **Discussion** bucket for architectural
   questions, alternatives, or clarification requests that aren't defects.
3. **Summarize the classified findings** as a table — for the HC when standalone, and as the disposition
   record on the PR under `ship`:
   ```markdown
   | # | Comment | Severity | Proposed Resolution |
   |---|---------|----------|---------------------|
   | 1 | [summary] | Critical | [specific fix] |
   | 2 | [summary] | Medium | [fix or explain why not] |
   | 3 | [summary] | Discussion | [recommendation with reasoning] |
   ```
4. **Dispose by context** ([ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md)
   decision 6):
   - **Within a `ship` run — autonomously.** Address every actionable finding (Critical / High / Medium
     correctness) and reply to Discussion / Low with rationale, **without waiting for the HC**. Escalate
     a finding **only** when it is architectural, ambiguous, or open to more than one interpretation —
     that is `ship`'s **emergency stop #3**, a *pause* the run records durably and re-seeds from, never a
     termination. The bar is not severity; it is *"can I resolve this without guessing at intent?"*
   - **Standalone — ask the HC.** Present the options and **wait before making any change**:
     - **A** — Address all findings (recommended if straightforward).
     - **B** — Address Critical + High, respond to the rest with rationale.
     - **C** — Custom selection: the HC chooses which to address.

*Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0005](../../docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)):* the
output-heavy fetch-and-fix churn may be offloaded to a sub-agent, but the severity classification and
the escalate-vs-resolve (stop-and-ask) judgment stay with the orchestrator. On a tool without sub-agents,
run it all inline.

## Applying the disposition

Once the disposition is decided — autonomously under `ship`, or by the HC standalone:

1. Make the changes the disposition selected.
2. Run every check in [`PROJECT.md`](../../PROJECT.md) → *Quality Checks* and get them green.
3. Self-review the changes against [`rules/self-review.md`](../../rules/self-review.md) — don't
   introduce new problems while fixing old ones.
4. Commit with a message referencing the review feedback (attribution trailer per
   [`PROJECT.md`](../../PROJECT.md) → *Attribution & Model Declaration*), and push to the PR branch.
5. **Reply to each addressed thread** explaining what changed:
   ```markdown
   Fixed in [commit] — [brief description of the change].
   ```
6. For findings intentionally **not** addressed, reply with rationale (or a link to a follow-up issue):
   ```markdown
   Acknowledged — [why this was not changed, or deferred to follow-up #N].
   ```
7. Post a summary comment on the PR:
   ```markdown
   ## Review Response Summary

   | # | Finding | Severity | Action |
   |---|---------|----------|--------|
   | 1 | [summary] | High | Fixed in [commit] |
   | 2 | [summary] | Low | Deferred — [reason] |

   All quality checks pass. Ready for the deliver skill (`final`).
   ```
   Sign every lifecycle-host comment with the attribution footer from
   [`PROJECT.md`](../../PROJECT.md) → *Attribution & Model Declaration*.

**Terminal artifact:** replies on the addressed review threads + the summary comment on the PR.

**Next step:** once all addressed findings are resolved and the checks are green, proceed to the deliver
skill (`final`) to generate the SOW and prepare for merge — automatically under a `ship` run's driving
loop, or by the HC running `final` standalone.

</procedure>
