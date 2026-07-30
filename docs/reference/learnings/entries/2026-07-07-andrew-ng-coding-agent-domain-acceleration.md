---
date: 2026-07-07
source:
  person: Andrew Ng
  link: https://www.deeplearning.ai/the-batch/coding-agents-accelerate-some-software-tasks-more-than-others/
  medium: post
claim: >
  Coding-agent acceleration ranks by domain — frontend > backend > infrastructure > research — so
  teams should set domain-specific expectations and guardrails.
stance: extends
touches: rules/backend.md
status: noted
---

## Compare / contrast

Published 2026-04-24 (backfill window, The Batch). Ng ranks where coding agents help most — frontend >
backend > infrastructure > research — and argues teams should set domain-specific expectations and
organize around where agents are strong vs. weak.

This **extends** the repo's per-domain **Rules Layer** split (`rules/frontend.md`, `rules/backend.md`,
`rules/security.md`, `rules/testing.md`): Ng's ranking both confirms that the split is the right axis
and implies the **guardrails and human gates should be weighted more heavily** in the domains
(backend, infra) where agents are least reliable — a concrete lens for how strict each domain's
Anti-Patterns should be.

## Disposition

`noted` — a candidate framing for the Rules Layer: calibrate rule strictness / gate weight by how
reliable agents are in each domain. No change proposed this sweep.
