---
name: devise
description: Stage 2 of the development lifecycle. Turn the chosen option into a right-sized plan — a concrete, ordered implementation plan with its testing strategy decided up front for well-understood work, or an exploratory spike/re-plan plan (a plan to learn) whose production test strategy is decided in the post-spike re-plan. Use after an option is picked and before writing any code; who picks the option, and who elects the exploratory path, follows PROJECT.md → Human Gates (the AC self-selects its recommendation under the shipped `auto` baseline; the HC picks where a host sets plan approval back to `required`).
---

<what-to-do>

Create an implementation plan for the tracked issue named in the invocation, based on the chosen
option from the [assessment](../../skills/assess/SKILL.md) — the AC's own recommendation under the
shipped `auto` baseline, or the HC's pick where a host set plan approval back to `required`. This is
**Stage 2 (Plan)** of the
[development lifecycle](../../docs/standards/development-lifecycle.md).

Read host-specific values — the lifecycle host and artifact map, the branch/PR policy, the
quality-check commands, the attribution/model, and the **human-gate policy** — from
[`PROJECT.md`](../../PROJECT.md). Never hardcode them here. **Baseline: plan approval is `auto`**
— the AC posts the plan and proceeds on it — and a Host App may set it back to `required` in `PROJECT.md` →
*Human Gates*, where the AC instead waits for the HC. Read that section before writing the Next Step.

</what-to-do>

<procedure>

1. **Read the issue and its comments** — the assessment and the chosen option (the AC's own
   recommendation under the shipped `auto` baseline, or the HC's pick under `required`), and any answers
   to the assessment's open questions.
2. **Right-size the plan to the task.** Match the plan's altitude to how much is actually known. For a
   well-understood change, write the full ordered plan below. For an **exploratory/discovery issue** —
   where the outcome is genuinely uncertain and a full ordered plan would be written against unknowns —
   produce instead a **thin hypothesis + a spike/prototype step + an explicit re-plan checkpoint**: the
   smallest experiment that resolves the uncertainty, plus the named question it must answer before the
   real plan is written. That *is* the right-sized plan for a discovery task — *a plan to learn*, not a
   lighter gate: it is still posted and still approved.

   **Who elects it depends on the gate setting.** Under `required`, the AC **surfaces**
   the exploratory path and its rationale and the **HC elects it** — the AC never self-selects a
   compressed or exploratory workflow (see the
   [development lifecycle](../../docs/standards/development-lifecycle.md)). Under the baseline `auto`
   ([`PROJECT.md`](../../PROJECT.md) → *Human Gates*), the AC **may elect the
   exploratory path itself** — it must then state the rationale in the posted plan and name that it
   self-selected under `auto`, so the choice stays auditable. Compressing away a whole *stage* remains
   the HC's call under either setting.
3. **Break the work into discrete, ordered tasks** — each specific enough to implement without
   guessing, with the files it creates or modifies named. (For an exploratory plan, the ordered tasks
   are the spike itself, run to *learn*; its exit is the re-plan checkpoint. The spike is a Plan-stage
   activity — it opens **no** PR. The production tasks, and the PR that delivers them, are authored and
   opened by `invoke` only after the post-spike re-plan is re-approved, never straight from the spike.)
4. **Define the testing strategy — decided now, not during implementation.** This is the load-bearing
   part of the plan. Following [`rules/testing.md`](../../rules/testing.md), decide:
   - Which test types the change needs (unit, integration, end-to-end, and whatever tiers the Host
     App's stack uses).
   - The specific scenarios each test covers — the happy path *and* the sad paths.
   - Edge cases: invalid input, duplicates, boundary values, concurrent operations.
   - Any shared fixtures/helpers/contexts to build (building test infrastructure is part of the work,
     not a reason to skip a test).
   - If the Host App enforces a coverage floor, how the change stays above it.

   **For an exploratory (spike-then-plan) issue,** this full strategy is decided in the **post-spike
   re-plan, before any production code** — the spike step itself names only what it must *learn*.
   "Decided now" means *when the plan for the production work is authored*; for discovery work that is
   after the spike. Test planning is deferred in detail, **never skipped**.
5. **Plan any data/schema change** — the migration or data-backfill steps, and their safety
   (reversibility, lock risk, multi-step rollout) per the host's migration rules.
6. **Determine the development environment** — a simple feature branch for single-focus work, or an
   isolated worktree when the work needs isolation (parallel agents, or a long-running change beside
   hotfixes). Branch naming follows [`PROJECT.md`](../../PROJECT.md) → *Branch & PR Policy*.
7. **Recommend an agent strategy** (the AC recommends; the HC decides) — a single agent for tightly
   coupled work; parallel agents (each owning an exclusive set of files) for large, independent
   subsystems if the host supports them; a background agent for a long-running check while the main
   agent continues.
8. **Check for risks** — schema/migration safety, authorization changes, breaking changes to existing
   behavior, search/index implications, deployment implications.
9. **Write the plan** in the structured format below.

</procedure>

<output>

Post the plan to the issue via the lifecycle host's issue-comment mechanism
([`PROJECT.md`](../../PROJECT.md) → *Lifecycle Host*), and also display it in the conversation for HC
review. Use this template:

```markdown
## Implementation Plan

### Development Environment
- Plan type: [full | exploratory: spike-then-plan]
- Environment: [simple branch | worktree]
- Branch: [name per PROJECT.md → Branch & PR Policy]
- Agent strategy: [single agent | parallel agents]
- Estimated scope: [X files, Y tests]

### Tasks
1. [Task] — [files affected]
2. [Task] — [files affected]

### Re-plan Checkpoint
- Exploratory plans only: what the spike must resolve before the production plan is authored (the named
  question, and how its answer feeds the re-plan). Omit for a full plan.

### Testing Strategy
Define EVERY test that will be written — by test type, the scenarios each covers, and the edge cases
(invalid input, duplicates, boundary values, concurrent operations). Note any shared fixtures/helpers
to build and how coverage stays above the host's floor. (For an exploratory plan, define these in the
post-spike re-plan; here, state only what the spike must *learn*.)

### Data / Schema Considerations
- [Migration/backfill steps and their safety — or "None"]

### Risks & Considerations
- [Migration, authorization, search/index, or breaking-change concerns]

### Next Step
[plan approval `auto` — the shipped baseline]
Plan approval is `auto` in PROJECT.md -> Human Gates (the shipped baseline), so I am proceeding on this
plan without waiting for approval; this comment is the record of what was decided. [If exploratory: I
elected the spike-then-plan path myself under `auto`, because <rationale>.] Next: the implement skill
(`invoke`) for the same issue, which re-reads this posted plan before writing any code.

[plan approval `required` — only if PROJECT.md -> Human Gates sets it back]
HC: send this plan to the Reviewer, then approve to proceed with the implement skill (`invoke`) for the
same issue.
```

Emit **one** of those two variants — the one the host's setting selects — never both.

Sign with the attribution footer from [`PROJECT.md`](../../PROJECT.md) → *Attribution & Model
Declaration*, using your runtime-actual model.

**Terminal artifact:** the plan posted on the issue — posted under **every** setting; it is the durable
record the next stage re-reads. **This is the first human gate (plan approval).** Its setting comes from
[`PROJECT.md`](../../PROJECT.md) → *Human Gates*: the shipped baseline is **`auto`**, and the AC proceeds
on this plan, naming that in the comment; a host may set it back to `required`, and the AC then does not
write code without an approved plan.

**The gate is also a context boundary, and that role is unconditional.** "Plan posted" forces a context
reset under `required` *and* under `auto` — a session boundary under `required`, `ship`'s own context
reset under `auto` ([ADR 0028](../../docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md));
`auto` waives the *wait*, never the context firebreak.
[`invoke`](../../skills/invoke/SKILL.md) begins by re-reading this plan from the issue rather than
carrying it in conversational memory.

An approved plan is **revisable direction, not a frozen contract.** Discovering mid-`invoke` that the
plan was wrong — an assumption broke, the spike taught something the plan didn't foresee — is an
**expected, valid outcome** that loops back to re-plan (re-run `devise` → plan approval), not a
deviation or a failure. This **does not weaken the plan-approval gate**: the gate's job is a human
checkpoint against confidently building the wrong thing at scale, which a re-plan *serves* rather than
bypasses ([ADR 0020](../../docs/adr/0020-right-size-plan-revisable-direction.md)).

## Quality standard

Before posting, self-review: is every task specific enough to implement without guessing? Does the
testing strategy cover the full definition of done in [`rules/testing.md`](../../rules/testing.md) —
including edge and sad paths? Would a critical reviewer find a missing scenario or an unstated risk? If
the plan is exploratory, is the spike the *smallest* experiment that resolves the uncertainty, is the
re-plan checkpoint explicit, and was the path elected by whoever the gate setting says elects it — the
HC under `required`, the AC (with its rationale stated) under the baseline `auto`?

</output>
