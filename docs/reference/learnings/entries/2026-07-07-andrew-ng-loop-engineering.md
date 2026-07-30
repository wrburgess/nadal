---
date: 2026-07-07
source:
  person: Andrew Ng
  link: https://www.deeplearning.ai/the-batch/issue-359/
  medium: post
claim: >
  "Loop engineering" is three nested feedback loops — agentic coding (minutes), developer feedback
  (hours), external/user (days/weeks) — and humans retain a context advantage that keeps
  human-in-the-loop essential.
stance: confirms
touches: docs/standards/development-lifecycle.md
status: noted
---

## Compare / contrast

Published 2026-06-26 (The Batch, Issue 359, Ng's letter). Ng frames "loop engineering" as three nested
feedback loops — the agentic coding loop (minutes), the developer feedback loop (hours), and the
external/user loop (days/weeks) — and stresses that humans retain a "context advantage" that keeps
human-in-the-loop development essential.

This **confirms** `docs/standards/development-lifecycle.md`: the repo's Assess → Plan → Implement →
Verify → Deliver lifecycle plus its two mandatory human gates is a near one-to-one instantiation of
the nested-loop model, with the human owning the higher-level loops. It's strong external validation
of the lifecycle's core premise — staged discipline with humans at the decision points, not hands-off
autonomy.

## Disposition

`noted` — external corroboration of the lifecycle design; no change proposed.
