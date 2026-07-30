---
date: 2026-07-07
source:
  person: OpenAI Cookbook
  link: https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex
  medium: docs
claim: >
  A closed Review → Repair → Validate loop that repeats until the delta hits zero, with four explicit
  stop conditions; demonstrated on repairing stale/broken docs.
stance: extends
touches: skills/verify
status: noted
---

## Compare / contrast

Published 2026-05-11 (backfill window). OpenAI's cookbook shows a bounded **Review → Repair →
Validate** loop that repeats until the delta hits zero, with four explicit stop conditions (validation
passes, max iterations, delta stops shrinking, or human review needed) — demonstrated on keeping
stale/broken API & SDK docs in sync.

This **extends** the repo's `verify` → `rtr` review-response cycle with a **stop-conditioned** repair
loop, and its exact use case — keeping drifting docs/config in sync via validation feedback — maps
onto the repo's single-source-of-truth problem and its `scripts/parity_check.rb` gate. The stop
conditions are a useful guard against unbounded self-repair.

## Disposition

`noted` — candidate pattern for `skills/verify` / `skills/rtr` (and `ship`): bound the repair loop
with explicit stop conditions, one of which is "human review needed" (preserving the gate). No change
proposed this sweep.
