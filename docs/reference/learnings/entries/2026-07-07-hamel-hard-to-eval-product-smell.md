---
date: 2026-07-07
source:
  person: Hamel Husain
  link: https://hamel.dev/blog/posts/eval-smell/
  medium: blog
claim: >
  When AI output is hard to verify, that signals a product-design problem, not an eval problem —
  redesign for verifiability to make automated evals tractable.
stance: extends
touches: rules/testing.md
status: noted
---

## Compare / contrast

Published 2026-06-29. Husain's "'It's Hard to Eval' Is a Product Smell" reframes eval difficulty:
when output is hard to verify, that's a **product-design** problem, not an eval problem. Redesign for
verifiability — smaller checkable units, clear provenance — and automated evals become tractable;
"evals thinking is aligned with good product design."

This **extends** `rules/testing.md`'s evals-as-first-class-tests stance (logged 2026-07-06) with a
design principle it doesn't yet state: *hard-to-eval is a smell to fix at design time*, not a harder
test to grind out afterward.

## Disposition

`noted` — candidate anti-pattern for `rules/testing.md` (or the deferred
`docs/rules/testing-postmortems.md`): "if you can't eval it, redesign for verifiability before you
write a bigger test." No change proposed this sweep; flagged for the human.
