---
date: 2026-07-07
source:
  person: Matt Pocock
  link: https://www.aihero.dev/how-to-kill-the-bloat-in-claude-codes-system-prompt
  medium: blog
claim: >
  Use a logging proxy to identify unused tools/features in an agent's requests, then disable them via
  config to cut token cost and context bloat.
stance: extends
touches: ADR-0004
status: noted
---

## Compare / contrast

Published 2026-07-07. Pocock uses a logging proxy to observe which tools and features an agent
actually uses, then disables the unused ones via config — a measurement-driven way to cut token cost
and context bloat.

This **extends** the two-tier Rules Layer (`ADR-0004`: an always-resident lean core plus deferred
deep docs loaded on demand). The repo pursues lean context *statically* — by tiering what's resident
vs. deferred. Pocock's technique adds a *dynamic, measured* angle: instrument real usage, then trim.
The two are complementary — measurement could validate where the tier boundary should sit.

## Disposition

`noted` — a candidate technique (measure real usage → trim) the repo could adopt to check its
tier-1/tier-2 boundaries empirically. Additive, not contradictory; no change proposed this sweep.
