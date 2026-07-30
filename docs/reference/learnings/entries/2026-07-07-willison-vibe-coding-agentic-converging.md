---
date: 2026-07-07
source:
  person: Simon Willison
  link: https://simonwillison.net/2026/May/6/vibe-coding-and-agentic-engineering/
  medium: post
claim: >
  As coding agents get more reliable, rigorous "agentic engineering" drifts toward unreviewed "vibe
  coding"; the bottleneck moves to upstream planning and downstream integration/testing.
stance: confirms
touches: docs/standards/development-lifecycle.md
status: noted
---

## Compare / contrast

Published 2026-05-06 (backfill window). Willison catches himself accepting agent output without
scrutiny as agents get more reliable — "agentic engineering" sliding into "vibe coding" — and argues
value now sits in upstream **planning** and downstream **integration/testing**, not the code
generation itself.

This **confirms** the shape of the repo's lifecycle: the mandatory **Verify** stage,
`rules/self-review.md`, and the human **merge gate** exist precisely to resist the "trust the agent,
skip the review" drift, and the Assess → Plan … Verify → Deliver arc puts the weight on planning and
verification — where Willison says the bottleneck moved.

## Disposition

`noted` — corroborates the two human gates and the plan/verify emphasis. Distinct from the logged
Willison entries (this is about review-discipline drift, not tool fragility or delegation). No change
proposed.
