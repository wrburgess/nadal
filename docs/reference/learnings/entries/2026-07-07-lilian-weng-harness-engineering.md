---
date: 2026-07-07
source:
  person: Lilian Weng
  link: https://lilianweng.github.io/posts/2026-07-04-harness/
  medium: blog
claim: >
  The "harness" — the orchestration layer between a raw model and real-world context — is as
  important as raw model intelligence and is the near-term path to self-improving systems.
stance: confirms
touches: skills/ship
status: noted
---

## Compare / contrast

Published 2026-07-04. Weng's "Harness Engineering for Self-Improvement" argues the **harness** — the
orchestration layer around a raw model (plan-execute-observe-improve loops, filesystem persistence,
sub-agent parallelization) — is as important as the model's raw intelligence.

This **confirms** the premise of a model-neutral Config Bundle: a carefully engineered layer around
*any* base model amplifies it. Her named patterns map onto the repo almost one-to-one — sub-agent
parallelization ≈ `ship`'s phase delegation; the plan-execute-observe loop ≈ the Assess → … → Verify
lifecycle; systematic failure documentation ≈ the deferred postmortem rules tier; human-oversight
placement ≈ the two mandatory human gates.

## Disposition

`noted` — broad external validation of the bundle's whole thesis (the harness is the product, not the
model). No change proposed; a strong citation for the design's rationale.
