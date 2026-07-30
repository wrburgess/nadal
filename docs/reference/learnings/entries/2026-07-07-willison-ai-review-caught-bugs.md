---
date: 2026-07-07
source:
  person: Simon Willison
  link: https://simonwillison.net/2026/Jul/5/sqlite-utils-fable/
  medium: post
claim: >
  An AI-run comprehensive code review of a release caught critical bugs (including
  transaction-handling issues) before shipping.
stance: confirms
touches: skills/verify
status: noted
---

## Compare / contrast

Published 2026-07-05. sqlite-utils 4.0rc2 was mostly written by Claude Fable; before release, an
AI-run comprehensive code review caught critical bugs — including transaction-handling issues — that
would otherwise have shipped.

This **confirms** the `verify` stage and `rules/self-review.md`: an agent-driven review pass *before*
a human reviewer sees the work is a genuine bug-catcher, not ceremony. The repo already positions
`verify` as a self-review gate between `impl` and the human reviewer; this is field evidence that the
gate earns its keep.

## Disposition

`noted` — corroborates the `verify` stage's value; no change proposed.
