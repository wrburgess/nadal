# The learning→enforcement gap is a second self-improvement loop, closed by distributed enforcement

**Status:** accepted

## Context

`ai-config`'s entire purpose is to be the **enforceable, vendored** Config Bundle. The Claude Code
Insights self-report for 2026-06-19 → 2026-07-22 (umbrella
[#131](https://github.com/wrburgess/ai-config/issues/131)) surfaced a recurring failure mode: two of its
three friction clusters were things the AC had **already learned** — they lived in agent memory and in
prior issues — yet were never promoted into enforceable config here, so the report independently
rediscovered them. [CONTEXT.md](../../CONTEXT.md) names this the **Enforcement Gap** (the
learning→enforcement gap): an AC *operational* learning that is never promoted into the enforceable
bundle, so the same friction recurs.

The bundle already runs one self-improvement loop — the **Intake Pipeline**
([ADR 0012](0012-intake-pipeline-placement.md)), which folds *external* field voices (a Watchlist → a
Learnings Log → proposed config changes). [#126](https://github.com/wrburgess/ai-config/issues/126)
(`/fitness`) proposes a *passive drift/bloat* audit — surface rot, not un-promoted learnings. Neither
closes the loop this report exposes: a recurring **internal** AC learning has no reliable path from
"captured" to "enforced."

The question this ADR settles is *what shape* the fix takes — a **standalone mechanism** (a new
skill/tracker owning "promote learnings to config", sibling to the Intake Pipeline and the Tool Roster),
or **distributed enforcement** (fold each learning into the enforcement surface that already binds its
kind).

## Decision

1. **The Enforcement Gap is a second self-improvement loop** — AC operational learnings → enforced
   config — **distinct from** the Intake Pipeline (external voices, ADR 0012) and from a passive drift
   audit (surface rot, [#126](https://github.com/wrburgess/ai-config/issues/126)). The framing is
   recorded in [CONTEXT.md](../../CONTEXT.md) as a glossary term and cross-referenced from its
   Relationships section.

2. **We close it by distributed enforcement, deliberately not a standalone mechanism.** Each learning is
   promoted into the surface that already enforces its kind: a recurring **behavioral** learning becomes
   a Lean-Core **Anti-Pattern** ([two-tier Rules Layer](0004-two-tier-rules-layer-progressive-context.md));
   a **procedural** one becomes Skill-body procedure; an **architectural** one becomes an ADR; a
   **mechanizable** one becomes a guardrail hook
   ([ADR 0009](0009-defense-in-depth-branch-protection-all-agents.md) /
   [ADR 0031](0031-clean-tree-destructive-op-guard.md)). Umbrella
   [#131](https://github.com/wrburgess/ai-config/issues/131) demonstrates the pattern across its
   sub-issues — this one ([#132](https://github.com/wrburgess/ai-config/issues/132)) carries the
   behavioral + legibility half.

3. **The always-on backstop is a self-review guardrail, not a new gate.**
   [`rules/self-review.md`](../../rules/self-review.md) carries the standing rule: a recurring AC
   operational learning must be **enforced now or opened as a tracked enforcement issue** —
   captured-but-unenforced is how the same friction recurs. This keeps the loop running without a
   fourteenth Skill to invoke.

## Consequences

- **Honest limitation — no single dashboard.** Distributed enforcement has no one place that lists
  "learnings awaiting promotion"; the self-review guardrail is the only forcing function, and it is a
  *make-visible* prompt to a human, not a mechanical gate. The parity check stays
  structural-not-model-in-the-loop ([ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)),
  so it cannot assert that a behavioral learning was actually promoted — the behavioral changes in this
  umbrella stick through always-resident rules and *make-visible* mechanisms, not a parity assertion.
- **Why accept it.** A standalone promoter would duplicate the enforcement surfaces it must ultimately
  write to and add another mechanism to maintain; folding into the existing surfaces keeps each learning
  enforced where it already binds. If the guardrail proves insufficient in practice, a standalone tracker
  stays a future option — this ADR does not foreclose it.
