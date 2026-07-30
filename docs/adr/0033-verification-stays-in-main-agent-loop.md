# Verification stays in the main agent loop — `verify` is never delegated

**Status:** accepted

**Amends** [ADR 0005](0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md) — specifically
the one bullet in *The rule* that lists "the `verify` full-diff review" among the delegated,
output-heavy phases. ADR 0005's governing principle (**offload retrieval, protect judgment**) and its
three other delegated phases stand unchanged; this ADR moves a single row and records why the principle
does not reach it. It is an amendment, not a supersession: ADR 0005 remains the delegation policy.
The older ADR is **not edited** beyond a pointer — ADRs are immutable here
([ADR 0024](0024-harness-model-naming-convention.md)) — so its text stands as the point-in-time record.

Same for the historical references in
[ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md) and
[ADR 0028](0028-context-reset-boundary-resumable-stops-autonomous-listen.md), which name `verify`'s diff
review as a delegated phase while reasoning about the nested-delegation block. Those arguments are
unaffected — they turn on a spawned orchestrator being unable to re-delegate, and one less delegable
phase only strengthens them.

## Context

[`ship`](../../skills/ship/SKILL.md)'s delegation table sent `verify`'s full-diff review to a read-only
sub-agent, which returned a compact `drift-report`; the orchestrator then classified findings by severity
and posted the self-review. The motive was pure context management — the diff is the largest read in the
lifecycle, and ADR 0005's goal is an orchestrator that finishes a run without a mid-run compaction.
[`verify`](../../skills/verify/SKILL.md)'s own body carried the same offload as an option, so the path
also existed for a standalone `/verify` invocation, independent of `ship`.

Anthropic's Claude Opus 5 migration guidance points the other way, and unusually plainly:

> Do NOT use subagents for: … Review, verification, or to double check your work. **Verification belongs
> in your main agent loop.**

**Provenance, stated at its real strength.** That text was read for the
[#142](https://github.com/wrburgess/ai-config/issues/142) assessment via the harness-bundled `claude-api`
skill reference — a vendor-supplied document with no public URL, and **not retained in this repository**.
A future reader therefore **cannot audit the quote from the bundle**, and should not treat it as a
verifiable citation. What *is* durable and auditable is the decision it informed: the HC weighed this
guidance and chose it explicitly, in a linkable comment on
[#142](https://github.com/wrburgess/ai-config/issues/142#issuecomment-5105831496). **The binding
authority for this ADR is that decision; the guidance is the input to it, recorded here for the reasoning
rather than as proof.**

The two positions are not reconcilable by scoping. The intent differs — context management, not a second
opinion — but the *mechanism* is identical: the agent that classifies the findings never read the diff.
This was raised as the sole open question of the [#142](https://github.com/wrburgess/ai-config/issues/142)
survey and answered by the HC on that issue.

## Decision

1. **Verification runs in the main agent loop. `verify` is never offloaded** — not under `ship`, and not
   standalone. In `ship`'s delegation table the `verify` full-diff review row moves **Delegate → Keep**
   and joins the never-delegate list; in `verify`'s own body the offload option is **removed**, not merely
   left unused. Removing it from both is the point: `verify` is invocable on its own, so an option left in
   the canonical body would readmit the delegated path through the side door.

2. **The reason is categorical, not contextual.** Every other never-delegate row on `ship`'s list is there
   because *a lossy summary would corrupt a judgment call*. `verify` is there because **verification is
   the one thing a sub-agent should not carry**, whatever the context math says. Stated separately so a
   future reader optimizing for orchestrator context does not weigh this row on the same scale as the
   others and move it back.

3. **The `drift-report` contract is unchanged.** It stays the schema `verify` produces and `ship`
   consumes — same fields, same severities, same `verdict`. Only its *producer* moves, from a sub-agent
   into the loop. `ship`'s verify handoff therefore still composes, and no other skill is touched.

4. **The context cost is accepted, and paid for with a reset rather than a delegation.** `ship` gains an
   unconditional **pre-`verify` context reset**, alongside the existing plan-gate and pre-`final` ones.
   It is free by construction: `verify` Steps 1–2 re-read the PR and the plan from durable artifacts, so
   nothing in-context is load-bearing across that boundary.

5. **Graceful degradation collapses here.** [ADR 0003](0003-skills-canonical-body-thin-shims-graceful-degradation.md)'s
   "on a tool without sub-agents, run inline" note becomes a statement of fact rather than a fallback:
   in-loop is the only path, on every harness. This is the rare case where the *mechanism* stops varying
   by tool — and consistent with ADR 0003, the quality bar is unchanged either way.

6. **The independent second-model Reviewer is untouched and is the real backstop.** Nothing here weakens
   [ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md): `verify` still owns
   the PR-gate summons, the chain still excludes the acting harness, and the `stop-and-ask` floor is still
   not configurable. Self-verification in-loop and independent review are different controls — the
   guidance above removes the sub-agent, never the second model.

## Considered options

- **A — keep delegating `verify`, treat the guidance as inapplicable** (the intent is context management,
  not a second opinion). Rejected: the mechanism is what fails, not the intent. The orchestrator that
  assigns severities would still be grading a summary it wrote no part of.
- **B — delegate only the *reading*, keep the classification** — i.e. the status quo, which already
  splits it that way. Rejected as the same thing: the split is exactly what produces the lossy handoff.
- **C — supersede ADR 0005 outright.** Rejected: three delegated phases and the output-weight principle
  survive intact. Superseding a policy to move one row overstates the change and loses the principle.
- **D — remove it from `ship` but leave the option in `verify`'s body (chosen only in part).** Rejected as
  incomplete: `verify` is a standalone skill, so the option would remain reachable.
- **E — amend ADR 0005, flip the row in both bodies, add a pre-`verify` reset (chosen).**

## Consequences

- **`ship`'s orchestrator now reads the full PR diff**, which is a real charge against ADR 0005's
  "complete without a mid-run compaction" target. The pre-`verify` reset makes room for the read; it does
  not shrink it. If compactions start appearing mid-run at this stage, that is data for a follow-up, not
  grounds to restore the offload.
- **One fewer handoff contract crosses a sub-agent boundary.** `ship` still delegates **three** phases —
  `assess` exploration, the `invoke` code loop, and `listen`'s fetch-and-fix churn — but only **two** of
  them now consume a contract defined in another skill's body (`exploration-summary`, `check-result`);
  `listen`'s `review-response` is defined in `ship` itself, and `drift-report` is produced in-loop. The
  count that changed is the contracts crossing a boundary, not the delegated phases.
- **The Claude adapter gains a matching spawn cap** in [`CLAUDE.md`](../../CLAUDE.md) — never delegate
  review or verification, prefer one sub-agent to several, no wide fan-out unasked. Adapter-only by
  classification: a spawn cap is a harness-capability statement, and it composes with the one-level
  nesting ceiling recorded in ADR 0026 (a sub-agent cannot spawn sub-agents) — that bounds the *depth*,
  this bounds the *breadth*.
- **Known limit — unmeasured, and unverifiable by the checker.** This is instruction text with no test.
  Parity proves the bundle is **well-formed** — links resolve, ADR numbering is contiguous, required
  sections are **present**. It proves nothing about whether this flip is stated *consistently* across the
  files that restate it: the Tier-1 rule check asserts section presence, **not content**
  (`scripts/parity_check.rb`), and this ADR's only mechanical guarantee is that it appears in the
  link-checked manifest. That consistency rests on the implementing PR's manual sweep and on human
  review — the [ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md) boundary, not a gap in
  it. Nor can any of it prove the posture produces *better* reviews; the evidence is the guidance below
  plus the argument above, not a measurement.
