# Interactive scout runs dispose findings one at a time; scheduled runs open the PR for async disposition

**Status:** accepted

## Context

The [Intake Pipeline](0012-intake-pipeline-placement.md) landed `scout` with a uniform disposition
model: the sweep drafts every surviving finding, opens one PR, and a human accepts/edits/rejects the
findings as a **bulk list** on that PR. Both the `scout` body and the
[scheduling guide](../guides/intake-sweep-scheduling.md) asserted the sweep "runs the identical
procedure either way" — by hand or on a schedule.

Issue #57 asked for the [`grill-with-docs`](../../skills/distill/SKILL.md) interaction model
instead: findings presented **one at a time**, each with a recommended disposition, waiting for the
human's decision before the next ("Ask the questions one at a time, waiting for feedback on each
question before continuing"). The 2026-07-07 backfill sweep already practiced this by hand ("12
drafted, 1 dropped in sequential review"), so the request is to codify a proven workflow.

A one-at-a-time walk is strictly better **when a human is present**. But there is no human to answer in
a **scheduled/headless** run, and some tools have no interactive-question mechanism at all. So a uniform
"always one-at-a-time" rule is impossible, and a uniform "always bulk" rule forgoes the better
interactive UX. We needed a recorded answer for *how* interactive and non-interactive disposition may
diverge **without lowering the human-disposes gate**.

## Decision

- **Interactive runs walk findings one at a time.** For each surviving finding `scout` presents its
  `claim`, `stance`, `touches`, and a **recommended disposition** (accept / edit / drop) with a
  rationale, then waits for the human's decision before the next — mirroring `grill-with-docs`. A
  rejected finding is dropped before the PR; the PR reflects the decisions already made.
- **Scheduled/headless runs — and any tool without an interactive-question mechanism — skip the walk**
  and open the PR for **asynchronous** bulk disposition. Per
  [ADR 0003](0003-skills-canonical-body-thin-shims-graceful-degradation.md) this is a degradation of the
  *mechanism*, not the bar: the reviewable PR — the sweep proposes, a human disposes — is the invariant
  floor and the terminal artifact either way.
- **The "identical procedure" claim is narrowed** to the *discovery-and-drafting* procedure. Disposition
  is the one legitimate point of divergence. The `scout` body (a new procedure step 7, plus the
  reconciled what-to-do and quality-gate) and the scheduling guide are updated to say so.
- **Empty sweeps are unaffected.** The walk runs only when at least one entry survived the stance rule,
  so [ADR 0013](0013-scheduled-intake-sweep-and-empty-sweep-policy.md)'s no-PR/log-only path
  short-circuits first — there is nothing to walk on an empty sweep.
- **The single-finding case stays identical.** A [`drop`](../../skills/clip/SKILL.md) hand-off walks its
  one finding, then still opens the PR — the degenerate case feels the same as any sweep.

## Considered options

- **A — a first-class numbered disposition step + this ADR + reconciled guide/`drop` (chosen).** Makes
  the required behavior visible where a reader looks (a procedure step) and records the divergence from a
  documented invariant where a future reader will wonder about it (an ADR).
- **B — fold it into the open-PR step as a degradation clause, no ADR.** Rejected — buries a *required*
  behavior in a sub-clause and leaves the interactive-vs-scheduled divergence from the "identical
  procedure" invariant unrecorded, so a future reader hits the contradiction with no rationale.
- **C — the numbered step but no ADR.** Rejected — the divergence from ADR 0013's "identical procedure"
  framing is exactly the surprising, hard-to-find rationale an ADR exists to capture.

## Consequences

- Interactive disposition is now a documented, first-class step; a tool without interactive questions is
  fully conformant by opening the PR — **no gate is lowered**.
- The "identical procedure either way" invariant (ADR 0013, the scheduling guide) is **refined, not
  broken**: discovery/drafting is identical; disposition legitimately diverges; the PR floor and the
  quality bar are unchanged. ADR 0013 carries a forward-pointer here.
- The requirement is **not machine-checked** — the parity check is structural
  ([ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)) — so it is upheld by the skill body
  and human review, not by a test.
