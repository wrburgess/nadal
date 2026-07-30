---
date: 2026-07-07
source:
  person: Simon Willison
  link: https://simonwillison.net/2026/Jul/2/dspy-datasette-agent-prompts/
  medium: blog
claim: >
  Use DSPy to systematically evaluate and optimize an agent's system prompts against live databases
  with auto-generated gold datasets — measured prompt iteration, not hand-tuning.
stance: extends
touches: rules/testing.md
status: noted
---

## Compare / contrast

Published 2026-07-02. Willison drives an agent's SQL system prompts through DSPy: auto-generate a
gold-standard eval set, measure the prompt against live databases, and let the optimizer iterate —
finding that presenting schema/columns explicitly removes error-retry loops.

This **extends** `rules/testing.md`, which already treats task-specific evals as first-class tests
(logged 2026-07-06 from Hamel Husain), by adding a concrete, tool-backed mechanism *under* that
principle: gold datasets plus measured prompt optimization, not just "write evals."

## Disposition

`noted` — candidate to cite in the deferred `docs/rules/testing-postmortems.md` as a worked
prompt-eval technique. No rule change required; the existing evals-first stance already admits it.
