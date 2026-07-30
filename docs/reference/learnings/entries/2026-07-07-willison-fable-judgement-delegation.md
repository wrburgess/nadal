---
date: 2026-07-07
source:
  person: Simon Willison
  link: https://simonwillison.net/2026/Jul/3/judgement/
  medium: post
claim: >
  Delegate routine implementation to cheaper subagent models while keeping judgment, review, and
  synthesis in the premium main loop.
stance: confirms
touches: skills/ship
status: noted
---

## Compare / contrast

Published 2026-07-03. Willison's "Fable's judgement" argues for pushing routine implementation work
down to cheaper subagent models while keeping the judgment, review, and synthesis in the premium main
loop.

This is almost verbatim the `ship` skill's **hybrid-delegation** contract (`ADR-0005`): offload
output-heavy work to discardable sub-agents while protecting the human/premium judgment and the two
mandatory gates. An independent voice arriving at the same offload-the-churn / keep-the-judgment split
is corroboration of that design.

## Disposition

`noted` — external validation of `ADR-0005`; no change proposed. Reinforces the delegation policy
`ship` already encodes.
