---
date: 2026-07-06
source:
  person: Hamel Husain
  link: https://hamel.dev/blog/posts/evals/
  medium: blog
claim: >
  An AI product's most common failure mode is the absence of task-specific evals; evals belong
  alongside the code as first-class, continuously-run tests.
stance: extends
touches: rules/testing.md
status: actioned
status_detail: >
  Actioned in PR #36 — rules/testing.md gained an "evals for LLM-driven behavior" Pattern and a
  matching Anti-Pattern (extend per host).
---

## Compare / contrast

"Your AI Product Needs Evals" argues that the root cause of most failing LLM products is not the model
but the **lack of a robust evaluation system** — and that evals should be built and run as a
first-class part of the development loop, not bolted on later.

This **extends** [`rules/testing.md`](../../../../rules/testing.md). That rule today covers
conventional testing (factories over fixtures, behavior-level assertions) but says nothing about
**evaluating LLM-driven behavior**, where the "assertion" is a graded rubric or an LLM-as-judge check
rather than a deterministic equality. A Host App shipping an AI feature would find a gap between the
rule's current scope and this practice.

## Disposition

`actioned` (PR #36). [`rules/testing.md`](../../../../rules/testing.md) gained an evals **Pattern**
(evaluate LLM-driven behavior with task-specific evals that run in CI against an explicit threshold,
not only example-based asserts) and a matching **Anti-Pattern** (never ship LLM-driven behavior
guarded only by deterministic asserts). The guidance is a business-neutral, *extend-per-host* starter,
consistent with the rest of the Lean Core: a Host App shipping AI features tightens the threshold and
tooling; heavier subsystem-specific case studies belong in the deferred deep doc
`docs/rules/testing-postmortems.md` when it lands. This entry is the worked example of the intake
loop closing — a field learning driving a concrete rule delta in the same change.
