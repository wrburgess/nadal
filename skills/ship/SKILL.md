---
name: ship
description: The hands-off orchestrator. Sequences the six lifecycle skills (assess → devise → invoke → verify → listen → final) end to end while keeping a lean orchestrator context — delegating output-heavy work to discardable sub-agents and honoring the human gates as PROJECT.md declares them — merge is always human, and plan approval is host-settable (`auto` by default). Use to run the whole development lifecycle for one issue in a single driven flow.
---

<what-to-do>

Run the full [development lifecycle](../../docs/standards/development-lifecycle.md) for the tracked
issue named in the invocation, from Assess through Deliver, by **sequencing the six lifecycle
skills** — [`assess`](../../skills/assess/SKILL.md) → [`devise`](../../skills/devise/SKILL.md) →
[`invoke`](../../skills/invoke/SKILL.md) → [`verify`](../../skills/verify/SKILL.md) →
[`listen`](../../skills/listen/SKILL.md) → [`final`](../../skills/final/SKILL.md). `ship` **adds no phase
procedure of its own**: each phase's steps, gates, and terminal artifact remain defined once in that
phase's canonical body, which `ship` reads and follows in order. What `ship` owns is the *sequencing*
— the delegation policy, the **context boundaries** and the **driving loop** (a stop is a pause that
re-seeds, never a termination — [ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md)),
the two human gates, the emergency stops, and the faithfulness backstop.

Read host-specific values — the lifecycle host and its artifact map, the branch/PR policy, the
quality-check commands, the review severities, the attribution/model, and the **human-gate policy** —
from [`PROJECT.md`](../../PROJECT.md). Never hardcode them here. **Baseline: plan approval is
`auto` and merge is `required`**; a Host App may set *plan approval* back to `required` in `PROJECT.md` →
*Human Gates*, and **merge is never configurable**. Read that section at the start of a run so the
gates below are honored as the host declares them.

**Design goal: a lean main-thread context** ([ADR 0005](../../docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)).
`ship` reaches it by delegating **output-heavy, signal-light** work to sub-agents whose context is
discarded, and **keeping judgment-heavy** work in a clean orchestrator — *not* by delegating every
phase uniformly. The cure for context degradation is to keep the *thinking* in a clean window and
offload the *reading*. A dry run should complete without a mid-run compaction.

**`verify` is the deliberate exception, and it costs.** Verification is kept in the main loop as a rule
([ADR 0033](../../docs/adr/0033-verification-stays-in-main-agent-loop.md)), so the orchestrator reads
the full PR diff — the largest single read in the lifecycle, and a real charge against the target above.
It is accepted, not overlooked: the mitigation is the **pre-`verify` context reset** below, not a return
to offloading. Do not "optimize" this row back.

</what-to-do>

<delegation-policy>

Delegate by **output-weight**, not per phase. Each delegated phase returns a compact **handoff
contract** and its sub-agent context is discarded; each kept phase runs in the clean orchestrator so
the decisions that matter are made on context the orchestrator actually saw.

| Phase | Disposition | What the orchestrator keeps | Handoff contract |
|-------|-------------|------------------------------|------------------|
| entry: resume derivation + driving loop | **Keep** | The resume-point read over durable artifacts; the pause/re-seed control flow across every phase | — (judgment-heavy; no offload) |
| `assess` exploration | **Delegate** | Assessment synthesis, option framing, the recommendation | `exploration-summary` ([`assess`](../../skills/assess/SKILL.md)) |
| `devise` | **Keep** | Plan authoring + reconciliation against the codebase | — (judgment-heavy; no offload) |
| `invoke` code + check + fix loop | **Delegate** | Branch setup, commit, push, open PR, issue linking | `check-result` ([`invoke`](../../skills/invoke/SKILL.md)) |
| `verify` full-diff review | **Keep** | The whole diff read, the severity classification, the self-review | — (verification belongs in the main loop; no offload) |
| `listen` fetch-and-fix churn | **Delegate** | Severity classification, the escalate-vs-resolve call, the autonomous disposition under `ship` (HC summary when standalone) | `review-response` (defined below) |
| `final` merge-readiness | **Keep** | The green-gate + no-open-must-fix judgment; the SOW | — (judgment-heavy; no offload) |

**Keep in the orchestrator (never delegate):** the resume derivation and the driving loop, assessment
synthesis, plan authoring/reconciliation, **the whole of `verify`**, `listen` severity + the
escalate-vs-resolve (stop-and-ask) call, and the `final` merge-readiness call. These are the decisions a
lossy summary would corrupt. `verify` is on this list for a distinct reason from the rest —
**verification belongs in the main agent loop as a rule, not as a context-management preference**
([ADR 0033](../../docs/adr/0033-verification-stays-in-main-agent-loop.md)) — and it is the one row that
costs context rather than saving it (see *Design goal* above).

### review-response (sub-agent → orchestrator)

The two delegated phases above consume contracts already defined in their own bodies
(`exploration-summary`, `check-result`). The `listen` fetch-and-fix churn is offloaded the same way but
its contract is defined here, so every delegated phase has one:

```
{ threads: [ { id, surface: "issue_comment"|"inline_thread"|"review_body",
               author, severity, summary, quoted_excerpt } ],
  severity_tally: { critical, high, medium, low, discussion },
  proposed_resolutions: [ { thread_id, source_url, action: "fix"|"explain"|"defer", detail,
                            status: "pending"|"applied"|"replied" } ],   # source_url + status pair each back to its thread
  quality_checks: [ { purpose, status: "pass"|"fail"|"not_run" } ],   # one row per PROJECT.md → Quality Checks
  verdict: "clean" | "needs_human_call" }
```

`severity` uses [`PROJECT.md`](../../PROJECT.md) → *Review Severity Framework* plus a `discussion`
bucket for non-defect questions. `verdict` is `needs_human_call` whenever any thread is architectural,
ambiguous, or open to more than one interpretation — that is **`ship`'s emergency stop #3, not a
severity threshold.** A Critical finding that is *unambiguous* is auto-addressed under `ship`, per
[ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md) decision 6;
the bar is *"can I resolve this without guessing at intent?"* The sub-agent proposes; the
**orchestrator** owns the escalate-vs-resolve call — under `ship` it autonomously applies the resolvable
findings and pauses only past the ambiguity line. The sub-agent gathers and drafts; it never posts to
the lifecycle host — the orchestrator owns that I/O and the attribution.

*Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0005](../../docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)):* on a
tool without sub-agent fan-out, run every phase **inline** and **compact between phases**. The
mechanism degrades; the phase procedures, the handoff contracts, and the quality bar do not.

</delegation-policy>

<procedure>

**Every `/ship {issue}` run begins by deriving its resume point** (below), then runs the remaining
phases in order under the driving loop — following each phase's canonical body for its steps and
terminal artifact. `ship` layers the sequencing controls below on top and adds no phase procedure of
its own.

## Entry — derive the resume point (runs first, every run)

`/ship {issue}` is **idempotent and safe to re-run at any point**: it does not assume it starts at
Assess. It reads the durable artifacts and resumes from the first incomplete stage, because *a stage is
not done until its terminal artifact exists* (the
[development lifecycle](../../docs/standards/development-lifecycle.md)). The derivation is a **pure
function over those artifacts** — no 14th skill and no separate `resume` command
([ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md) decision 3):

| Durable artifacts present | Resume point |
|---|---|
| nothing | `assess` |
| assessment, no plan | `devise` |
| plan, no PR | `invoke` |
| PR, no self-review | `verify` — review, then summon the Reviewer |
| self-review posted, Reviewer **not yet summoned** | `verify` — issue the summons |
| self-review posted, summons issued to the current chain entry, its window still open, no response | `verify` — await **that entry**; do not re-summon **it** (the double-summons defect ADR 0026 closed — "never re-summon" is scoped to the same entry) |
| self-review posted, the current entry's window **expired** and a fallback entry remains | `verify` — advance to the **next** chain entry and summon it |
| self-review posted, Reviewer **responded**, findings still open | `listen` |
| self-review posted, chain **exhausted** (every entry unreachable/silent) | `needs_human_call` — the `stop-and-ask` floor (posted as a durable stop pair; see below) |
| Reviewer response **resolved**, green, no open must-fix, no SOW | `final` |
| SOW posted | await human merge |

Two reads are finer than "does an artifact exist," and both are load-bearing
([ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md) decisions 4–5):

- **A durable stop is a *pair*.** A stop posts its question to the issue/PR; resume advances only when a
  **paired answer** is present. A posted-but-unanswered stop is *not* the same as no stop — it resumes
  as "still paused at that phase, awaiting the HC," never as "start the run over."
- **`listen` vs `final` turns on the findings, not on the self-review comment.** Both leave a self-review
  comment, so the derivation reads the Reviewer findings' **addressed/open** state: findings open →
  `listen`; findings addressed → `final`.

Then run the phases from the derived point:

1. **Assess** — follow [`assess`](../../skills/assess/SKILL.md), delegating the codebase exploration
   and folding the returned `exploration-summary` into the assessment you synthesize. Post the
   assessment to the issue.
2. **Plan** — follow [`devise`](../../skills/devise/SKILL.md) **in the orchestrator** (no offload). Post
   the plan to the issue. **→ Human gate 1 (plan approval).** Baseline `auto`: proceed on the posted
   plan and **name in the comment** that you self-selected under `auto`. If the host set it back to
   `required` (`PROJECT.md` → *Human Gates*), stop and wait for the HC instead. Either way still **cross
   the context boundary here** (see *Gates as context boundaries*), resetting context before Implement.
3. **Implement** — follow [`invoke`](../../skills/invoke/SKILL.md), which **re-reads the posted plan
   from the issue first** (unconditional): the orchestrator owns branch setup and
   all lifecycle-host I/O; the code + check + fix loop is delegated, returning a `check-result`.
   Reconcile git state, gate on `verdict`, then commit → push → open the PR.
4. **Verify** — **reset context first** (see *Gates as context boundaries*), then follow
   [`verify`](../../skills/verify/SKILL.md) **in the orchestrator** (no offload): read the full diff and
   the plan from the PR and issue, produce the `drift-report`, classify findings by severity, post the
   self-review on the PR.
5. **Review response** — follow [`listen`](../../skills/listen/SKILL.md): delegate the fetch-and-fix churn
   (`review-response` contract), make the severity and escalate-vs-resolve calls in the orchestrator, and
   **dispose autonomously — post the disposition record and apply the resolvable findings, pausing to ask
   the HC only on emergency stop #3** (an architectural/ambiguous finding).
6. **Deliver** — follow [`final`](../../skills/final/SKILL.md) **in the orchestrator**: re-verify the
   PR is green with no open must-fix findings, post the Statement of Work, link it from the issue. Run
   the **run-level ask-completeness check** ([`rules/self-review.md`](../../rules/self-review.md)) at this
   terminal: reconcile `build-brief.asks_ledger` — the **durable** record each phase appended to as asks
   arrived (below) — and confirm every explicit ask is delivered or handed to a tracked follow-up. Because
   the ledger is durable rather than in-context, this terminal pass still catches a late ask that landed
   *after* `invoke`-time self-review even though the pre-`final` reset discarded the conversation that
   raised it — the exact gap an in-memory ledger would drop.
   **→ Human gate 2 (merge) — always human, never configurable.**

## The driving loop — a stop is a pause, not a termination

The phases above are sequenced by a loop in which **an emergency stop or a gate pauses the run; it never
ends it** ([ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md)
decision 2). The orchestrator seeds each build stretch from a compact **build brief**, runs to the next
stop or to delivery, and — on a stop — records the question and its answer **durably** (see *Gates as
context boundaries*), folds the answer into the brief, **resets its context, and resumes from the
re-derived point**. The loop exits **only** at `delivered`, where the HC merges (the one standing stop).
There is no path where `ship` returns the HC a list of commands to run.

**Emit a stage-transition heartbeat.** At each phase boundary — entering `assess`, `devise`, `invoke`,
`verify`, `listen`, `final`, or `await-merge` — emit a one-line progress marker naming the phase just
entered (and, on a resume, the re-derived point). The run is already legible *asynchronously* through
the artifact each phase posts (assessment, plan, PR, self-review, review replies, SOW); the heartbeat
closes the *synchronous* gap, so a human watching a long hands-off run sees motion between those posts.
It is a progress signal only — it changes no gate, no context boundary, and no control flow (it rides
the same pause-not-terminate loop, [ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md)).

### build-brief (orchestrator → the next build stretch)
```
{ issue_ref, plan_comment_url?, branch?,   # `?` = present once that artifact exists (null at assess/devise)
  resume_point:    assess | devise | invoke | verify | listen | final | await-merge,
  human_decisions: [ { stop_id, at, question, answer, artifact_url } ],  # stable id + source ref per pair
  asks_ledger:     [ { ask, at, status: "delivered"|"handed-off", ref } ],  # each explicit ask recorded DURABLY (issue/PR comment, or a tracked follow-up) as it arrives; reconstructed from those artifacts on every reseed, so `final` reconciles a run-complete ledger, never from in-context memory
  gates:           { plan_approval, merge } }       # read from PROJECT.md -> Human Gates
```

### build-result (a build stretch → orchestrator)
```
{ pr_url?,               # null until invoke opens the PR
  sow_posted, quality_checks: [ { purpose, status } ], open_must_fix: [...],
  verdict: "delivered" | "awaiting_reviewer" | "reseed" | "needs_human_call",
  paused_at, question, stop_id }   # stop_id set on needs_human_call; pairs back to human_decisions
```

Fields marked `?` are **null until their artifact exists** (no `pr_url` before `invoke` opens the PR; no
`plan_comment_url`/`branch` at `assess`/`devise`), so the contracts represent every resume point rather
than assuming a PR. Beyond `delivered` and `needs_human_call`, two verdicts are **reset-only transitions
that need no human call** — preserving a firebreak without a pause: `awaiting_reviewer` (summoned, still
inside the bounded window, no response yet — the loop re-polls) and `reseed` (a pure context reset, e.g.
the `auto` plan-boundary cross or the pre-`final` check). `needs_human_call` is raised by any
emergency stop or an exhausted Reviewer chain (the *Faithfulness backstop* below), and carries a
`stop_id` that pairs its durable question to the answer folded back into `build-brief.human_decisions`. On it the orchestrator **owns** the severity call and the stop-and-ask: it posts the
question durably, waits for the HC's answer (**the pause**), folds it into `build-brief.human_decisions`,
and re-seeds. On `delivered` it reports and the HC merges. *Who* crosses each boundary, and how the
context reset happens, is *Gates as context boundaries* below.

## The two human gates

`ship` replaces every per-stage "wait for the HC" pause with exactly **two** gates, per the
[development lifecycle](../../docs/standards/development-lifecycle.md). Which of them *pauses* is
declared in [`PROJECT.md`](../../PROJECT.md) → *Human Gates*; **the shipped baseline is ungated to
merge — plan approval `auto`, merge `required` — so out of the box only the merge gate waits for the
HC**:

1. **Plan approval** — after `devise` (and any Reviewer plan review), before any code. Baseline
   **`auto`**: `ship` proceeds on the plan it just posted, **naming in that comment** that it
   self-selected under `auto`. A host may set it back to `required`, and `ship` then does not write
   code without an approved plan. The assessment and plan are posted either way — under `auto` they are
   the only audit trail of what was decided.
2. **Merge** — after `final` posts the SOW with a green gate and no open must-fix findings. **`required`
   is its only legal value: merge is not configurable and `ship` never merges** — merge is the HC's.

`auto` waives a *pause*, nothing else: the emergency stops below, the context boundaries below, and the
intake/authoring skills' "a human disposes" gates all still apply in full. (`listen`'s disposition is no
longer on this list — it is decoupled from the gate setting and disposes autonomously under `ship`, per
[ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md) decisions 6–7.)

## Emergency stops (unconditional)

Beyond the two gates, `ship` **stops and asks the HC** the moment any of these appears — it never
works around them:

- A quality check fails and the fix is not obvious / cannot be auto-resolved.
- A discovery that the change touches core logic the plan did not anticipate.
- A review comment that is architectural, ambiguous, or open to more than one interpretation.
- Any handoff contract returns a `needs_human_call` / `failing` verdict the orchestrator cannot
  resolve from context.

## Gates as context boundaries (unconditional)

A gate does two separate jobs: it **pauses for a human** (gate-as-approval, configurable per *Human
Gates*) and it **forces a context reset** (gate-as-boundary, a context firebreak). **Only the pause is
ever waived, never the reset.** Waiving the pause must never delete the firebreak — that is precisely
the failure where a run carries a half-remembered plan straight into implementation.

*Who* performs the reset, and *how*, follows the plan-approval setting
([ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md) decision 1):

- **`required`**: the reset **is a session boundary** — the human crosses. "Plan posted" ends
  the session; `ship` stops there and the run resumes when the HC re-runs `/ship {issue}` (or runs
  `/invoke`) in a fresh session.
- **`auto`** (the shipped baseline — [ADR 0029](../../docs/adr/0029-baseline-ships-ungated-to-merge.md)):
  **`ship` resets its own context in place** — the *same agent*, re-seeded from the `build-brief`,
  never a spawned orchestrator (nested delegation is hard-blocked — ADR 0026 / ADR 0028). `auto` stops
  the *pause*, not the firebreak: `ship` still discards its context at "plan posted" before Implement.

To keep the orchestrator lean through the delegated heavy ops, **externalize state** to the issue / PR /
git rather than carrying it in context — under either setting:

- Run **assess + plan with a clean context**; "plan posted" is the boundary under `required` *and* under
  `auto` (a session end under `required`; `ship`'s own context reset under `auto`).
- Cross into **build (`invoke` → `final`) with a fresh context** so the orchestrator starts lean before
  the delegated code loop and the review churn. `invoke` opens by **re-reading the posted plan from the
  issue**, never from carried-over context.
- A **pre-`verify` context reset** — also unconditional — because `verify` is kept in the main loop
  ([ADR 0033](../../docs/adr/0033-verification-stays-in-main-agent-loop.md)) and reads the full diff
  there. It is free: `verify` Steps 1–2 re-read the PR and the plan from durable artifacts anyway, so
  nothing in-context is load-bearing across this boundary. This reset is the accepted mitigation for the
  context cost that keeping `verify` in-loop imposes — it does not reduce the read, it just makes room
  for it.
- A **pre-`final` context check** forces another reset before the merge-readiness judgment — also
  unconditional.
- **Record each explicit ask durably as it arrives**, never only in context — post it (or a tracked
  follow-up) to the issue/PR the moment it lands, exactly as a stop posts to `human_decisions`. The
  `build-brief.asks_ledger` is then reconstructed from those durable records on every reseed, so a late
  ask cannot be lost to the pre-`final` reset; `final`'s terminal ask-check reconciles against that
  durable ledger, not a memory the reset already discarded.
- On resume, a fresh phase **re-reads its durable artifacts** (the issue, the plan comment, the PR)
  rather than trusting a compaction summary — a stage is not done until its terminal artifact exists
  (see the [development lifecycle](../../docs/standards/development-lifecycle.md)).

## Faithfulness backstop

The plan gate and the PR each get an **independent second-model review** — the chain declared in
[`PROJECT.md`](../../PROJECT.md) → *Reviewer* — so a delegated summary the orchestrator never saw
cannot silently steer the outcome.

**[`verify`](../../skills/verify/SKILL.md) owns the summons; `ship` does not issue one.** `ship` adds
no phase procedure of its own, and a second summons would produce two review requests, two windows,
and an unanswerable "did the primary respond?" ([ADR 0026](../../docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)).
`ship`'s job here is only to **honor the outcome `verify` carries forward**: proceed when a reviewer
answered, and treat an exhausted chain as an emergency stop — a `needs_human_call` the driving loop
**pauses** on and re-seeds from, never a termination
([ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md) decision 2).

If **the whole chain is exhausted**, the backstop applies its degradation floor: **`stop-and-ask` is
the shipped default and is not configurable** — the orchestrator stops and asks the HC. It is never
silently dropped, and a run may not certify itself by delivering unreviewed with a footnote. Under the
pause-not-terminate loop the floor is cheap — one durable question and a re-seed — which is exactly the
reasoning [ADR 0026](../../docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
decision 3 used to keep it at full strength.

</procedure>

<quality-gate>

`ship` changes **no quality bar** — every phase's gate runs at full strength, in order:
`assess`'s option rigor, `devise`'s testing strategy, `invoke`'s green *Quality Checks* +
[`rules/self-review.md`](../../rules/self-review.md), `verify`'s drift/test-quality review, `listen`'s
severity discipline, and `final`'s merge-readiness. A weaker tool degrades the delegation *mechanism*
(inline + compact between phases), never a gate.

Before declaring a `ship` run complete: both human gates were honored **as
[`PROJECT.md`](../../PROJECT.md) → *Human Gates* declares them** (baseline: plan approval `auto`, merge
`required`; merge is `required` always — a run that merged its own PR is a failed run regardless of the
setting), and each
gate's **context reset** was observed even where the pause was waived; no emergency stop is
outstanding (a stop is a pause the loop re-seeds from, not a silent skip); every delegated phase
returned and was reconciled against its handoff contract; the
terminal artifact of each phase exists (assessment, plan, PR, self-review, review replies, SOW); and the
**run-level asks-ledger** was reconciled at `final` from its durable record (`build-brief.asks_ledger`,
which survives every context reset), with every explicit session ask delivered or handed to a tracked
follow-up. Sign
every lifecycle-host comment with the attribution footer from [`PROJECT.md`](../../PROJECT.md) →
*Attribution & Model Declaration*, using your runtime-actual model.

**Terminal artifact:** a delivered PR carrying the SOW, with the two human gates intact and the issue
linked — ready for the HC to merge.

</quality-gate>
