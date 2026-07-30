# The human-gate policy is a Project Config value, machine-checked — with merge non-configurable

**Status:** accepted

## Context

The [development lifecycle](../standards/development-lifecycle.md) has two human gates — **plan
approval** and **merge**. Until now that policy was *prose*, restated near-verbatim wherever a stage
touched a gate: `AGENTS.md`, `README.md`, [`docs/guides/usage.md`](../guides/usage.md), the lifecycle
standard, and the `assess` / `devise` / `invoke` / `ship` / `final` skill bodies. An audit of the
current tree counts roughly **60 gate assertions across 22 files**.

That is a Project Config value wearing prose clothes. Every other host-variable thing in this bundle —
the quality-check commands, the attribution/model, the branch policy, the review severities, the
lifecycle host ([ADR 0006](0006-baseline-skill-set-and-github-default-lifecycle-host.md)), the intake
locations ([ADR 0012](0012-intake-pipeline-placement.md)), the Tool Roster location
([ADR 0023](0023-tool-roster-facts-tracker-sibling-to-intake.md)) — was moved into
[`PROJECT.md`](../../PROJECT.md) for exactly one reason: so a Host App can change it **without forking
a vendored file**. The gate policy was the outlier. A host running a lower-stakes internal repo, or an
autonomous overnight track, had only one way to express "don't stop for me at the plan" — edit the
vendored skill bodies, which breaks the canonical-source discipline
([ADR 0002](0002-agents-md-canonical-pointer-projection.md),
[ADR 0003](0003-skills-canonical-body-thin-shims-graceful-degradation.md)) and reddens its own parity
check on the next re-sync.

The argument shape is identical to ADR 0006's: the *lifecycle host* is host-variable, so the skill
bodies name the lifecycle **verb** and read the platform from `PROJECT.md`. Here the skill bodies
should name the **gate** and read its setting from `PROJECT.md`.

Two things constrain the change. First, **not everything a gate does is an approval.** The plan gate
also functions as a *session boundary* — the context firebreak that stops a run carrying a
half-remembered plan into implementation. Waiving the pause must not delete the firebreak, and today
the two are fused in one sentence in `skills/ship/SKILL.md`. Second, **merge is not the same kind of
value as plan approval.** "The AC never merges" is a safety invariant, not a preference.

### Relationship to ADR 0020 (narrow supersession)

[ADR 0020](0020-right-size-plan-revisable-direction.md) decided that "**the two human gates are
unchanged**," that their "near-verbatim restatements across `AGENTS.md`, `README.md`,
`docs/guides/usage.md`, `skills/ship`, and `skills/final` are **left untouched**," and recorded as a
consequence that "**no gate is lowered**."

This ADR **narrowly supersedes those three statements** — and only those. ADRs are immutable in this
repo ([ADR 0024](0024-harness-model-naming-convention.md) states the rule and applies it), so ADR 0020
is **not edited**; the supersession is recorded here, where a reader who arrives via ADR 0020's text
will find it.

What is superseded, precisely:

- **"Left untouched" no longer holds.** The restatements are rewritten to name the host value.
- **"No gate is lowered" is refined, not reversed.** The *shipped baseline is unchanged* — both gates
  ship `required`, so a host that does nothing is byte-for-byte in ADR 0020's world. What changes is
  that a host can now *declare* a lower plan-approval bar for itself, explicitly and visibly, instead
  of forking a file to get it. Merge cannot be lowered at all, by anyone.
- **ADR 0020's file estimate undercounts.** It reasoned about "**the ~7 gate-restatement files**." The
  real surface is ~60 assertions across 22 files — an order of magnitude more coupling than the ADR
  that chose to leave it alone believed it was leaving alone. That gap is itself an argument for
  making the value machine-checked rather than prose-maintained.

Everything else in ADR 0020 — right-sized plans, the spike-then-plan path, "an approved plan is
revisable direction," `verify`'s sanctioned-re-plan vs. scope-creep line — stands unmodified.

## Decision

1. **Add a `## Human Gates` section to [`PROJECT.md`](../../PROJECT.md)** — a two-row table declaring
   `plan-approval` and `merge`. It sits between *Lifecycle Host* and *Intake Pipeline*, deliberately
   **not** between *Branch & PR Policy* and its `- **Protected branches:**` bullet, which
   `scripts/protected_branches.rb` scans to the next `## `.
2. **`plan-approval` accepts `required` (shipped default) or `auto`.** It covers **both** the Stage-1
   option pick and the Stage-2 plan approval — one decision, not two. Under `auto` the AC proceeds on
   its own stated recommendation, still **posts** the assessment and the plan (under `auto` those
   comments are the *only* audit trail, so posting becomes more load-bearing), and **names in the
   comment** that it self-selected.
3. **`merge` accepts `required` and nothing else.** Merge is non-configurable; no Host App may express
   self-merge. `scripts/parity_check.rb` **hard-fails** any other value with its own distinct message,
   separate from the generic bad-value message — it is a policy boundary, not a typo.
4. **Resident default, never a bare pointer.** Every body that reads the value **states the baseline
   inline** ("plan approval is `required`; a host may set it to `auto` in `PROJECT.md` → *Human
   Gates*"). `PROJECT.md` is the **override**, not the sole source. This follows `rules/skills.md`'s
   "never trim length by moving a load-bearing instruction behind a link" — Copilot does not follow
   links, so a body reduced to "see PROJECT.md" would ship Copilot no policy at all.
5. **Split gate-as-approval from gate-as-session-boundary.** The boundary is **unconditional**: "plan
   posted" ends the session under either setting. `invoke` gains an explicit **Step 1 — re-read the
   posted plan from the issue**, closing a real pre-existing gap (only `verify` re-read the plan;
   `invoke`, the phase that starts immediately after the gate, never did). `auto` waives the *wait*,
   never the firebreak.
6. **Enumerate what the setting does not reach.** Merge; the session boundaries; `ship`'s four
   emergency stops; `listen`'s "wait for the HC to choose" and "the HC decides when to compress"; and
   the intake/authoring "a human disposes" gates
   ([ADR 0014](0014-manual-drop-inbox-for-unfetchable-sources.md),
   [ADR 0016](0016-interactive-sequential-disposition-scout.md)) — all out of scope and unchanged.
   `auto` is not licence to auto-merge a `scout` / `clip` / `follow` / `restock` / `create-skill` PR.
7. **Under `auto`, the AC may elect the exploratory (spike-then-plan) path itself**, stating its
   rationale in the posted plan — so `devise`'s "the HC elects it — the AC never self-selects" is
   scoped to `required` rather than left self-contradictory. Compressing away a whole *stage* stays
   the HC's call under either setting.
8. **Machine-check it.** A new `scripts/human_gates.rb` (mirroring `scripts/protected_branches.rb`)
   parses the section; `parity_check.rb` validates the values and asserts each gate-aware body names
   *Human Gates*. The heading is deliberately **absent from `REQUIRED_PROJECT_SECTIONS`**, matching
   the *Intake Pipeline* / *Tool Roster* precedent: the parser returns the strict defaults when the
   section is missing, so an already-vendored Host App stays green.

## Considered options

- **A — leave it as prose (status quo, ADR 0020's choice).** Rejected: it makes a host fork vendored
  files to change one policy, which is the exact failure ADR 0001/0002/0003 are built to prevent, and
  it leaves ~60 assertions to drift by hand.
- **B — a Project Config value, unchecked** (declare it, keep the prose unverified). Rejected: prose
  and setting would silently diverge, which is how the ~60 assertions got there. A declared value with
  no check is a false green.
- **C — a Project Config value, machine-checked, merge non-configurable (chosen).** Adds the section,
  the parser, and two classes of check; keeps the shipped baseline strict; and separates the
  session-boundary role so the firebreak survives.
- **D — make both gates configurable** (allow `merge: auto`). Rejected outright: "the AC never merges"
  is a safety invariant that a config file must not be able to express away. Encoding it as a
  hard-fail is strictly better than leaving it implicit in prose.
- **E — a full "autonomy level" abstraction** (one `autonomy: supervised|auto|full` knob spanning
  gates, emergency stops, and intake disposition). Rejected as over-reach and as actively dangerous:
  it would couple the plan pause to the emergency stops and the intake gates, which must **not** move
  together.

## Consequences

- A Host App declares its gate policy in **one place** and never forks a vendored file to get it. The
  Generic Baseline's behavior is **unchanged** — both gates ship `required`.
- The `merge: auto` hard-fail means the "AC never merges" invariant is now **enforced**, not merely
  asserted. It was previously prose that a fork could quietly delete.
- `invoke`'s new re-read step closes a real gap that predates this ADR and is independent of it: the
  phase starting right after the plan gate never re-read the plan.
- **Known limit — the check verifies *reference*, not semantic consistency.** `parity_check.rb`
  asserts that each gate-aware body *contains the string* "Human Gates"; it cannot tell whether that
  body's surrounding prose actually agrees with the declared setting, states the resident default
  correctly, or contradicts itself. A body could name the value and still describe the wrong policy.
  This is the same structural-check boundary as
  [ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md), and the same blind spot ADR 0020
  recorded for its own reconciliation: prose consistency is upheld by the skill bodies and human
  review, not by a test. The check turns a *silent* drift into a *loud* one only for the
  reference-shaped failure (a body that drops the value entirely).
- The parser is fail-**safe**, not fail-closed: a missing section reads as the strict defaults. That is
  the right default for a *policy* value (the safe answer is "require a human") and it is what keeps
  vendored hosts green — but it does mean a **typo'd heading** reads as "absent" and silently yields
  the baseline rather than erroring. A host intending `auto` and mistyping gets the *strict* policy,
  which fails safe.
