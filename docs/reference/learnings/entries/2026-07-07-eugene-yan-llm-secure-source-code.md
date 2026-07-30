---
date: 2026-07-07
source:
  person: Eugene Yan
  link: https://eugeneyan.com/writing/secure-source-code/
  medium: post
claim: >
  A six-step agent-driven security-review framework: threat-model first, parallelize discovery agents,
  run an independent verification agent with no access to discovery reasoning, and keep humans on
  triage/patching.
stance: extends
touches: rules/security.md
status: noted
---

## Compare / contrast

Published 2026-05-27 (backfill window). Yan lays out a concrete agent-driven security-review method:
threat-model first (findings then exploitable ~90% of the time), parallelize discovery agents, then
run an **independent verification agent** with no access to the discovery reasoning (roughly halves
false positives), with humans on triage/patching where the bottleneck now sits.

This **extends** `rules/security.md` beyond "run a scanner" with a real methodology — and its
**independent-verifier-then-human-gate** shape mirrors the repo's own self-review → human-gate
structure (`verify` before a human reviewer; the adversarial-verify pattern). It is also the first
in-window finding to bear on the security rule.

## Disposition

`noted` — candidate content for `rules/security.md` (or `docs/rules/security-postmortems.md`): a
staged, verifier-separated security-review pattern for agent-written code. No change proposed this
sweep.
