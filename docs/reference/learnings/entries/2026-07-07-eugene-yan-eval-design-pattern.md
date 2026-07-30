---
date: 2026-07-07
source:
  person: Eugene Yan
  link: https://eugeneyan.com/writing/cybersecurity-evals/
  medium: blog
claim: >
  Effective agent evals share a four-primitive design — a sandboxed target, difficulty-tuning inputs,
  tools, and a deterministic grader — with partial credit via subtasks to reveal progress rather than
  binary pass/fail.
stance: extends
touches: rules/testing.md
status: noted
---

## Compare / contrast

Eugene Yan distills cybersecurity-agent benchmarks to a reusable **eval design pattern**: four
primitives — "a sandboxed target," "inputs that influence task difficulty," "tools," and "a grader" —
plus "awarding partial credit via subtasks that track progress," defense-aware runs, and
contamination control (post-cutoff / zero-day tasks so you measure reasoning, not memorization).

This **extends** [`rules/testing.md`](../../../../rules/testing.md). The existing evals guidance there
(from the [Hamel entry](2026-07-06-hamel-evals-first-class-tests.md)) establishes **that** an AI
feature needs task-specific evals as first-class tests — but not **how to design one**. Eugene Yan
supplies the recipe. A Host App shipping an AI feature could turn the current "add task-specific evals"
Pattern into something concrete: define a sandboxed target, tune difficulty via inputs, give the agent
tools, grade with a **deterministic grader and partial credit via subtasks** (not binary), and guard
validity with post-cutoff tasks.

**Related in the log.** This joins a cluster on `rules/testing.md`:
[Hamel — evals as first-class tests](2026-07-06-hamel-evals-first-class-tests.md) (the *why*),
[Hamel — hard-to-eval is a product smell](2026-07-07-hamel-hard-to-eval-product-smell.md) (*when to
redesign*), and [Willison — DSPy prompt evals](2026-07-07-willison-dspy-agent-prompt-evals.md)
(*tooling*). Eugene Yan supplies the missing facet — the eval **design pattern** itself — so this is
complementary, not a re-add.

## Disposition

`noted` — proposes a possible refinement to `rules/testing.md`'s evals Pattern (a four-primitive design
recipe + partial-credit grading); a human disposes. Not actioned here: `/drop` **ingests and proposes**;
the rule delta is the human's call on this PR. This is a **human drop**, so the incremental window does
not gate it.
