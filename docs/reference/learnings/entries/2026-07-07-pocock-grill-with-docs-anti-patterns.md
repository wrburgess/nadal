---
date: 2026-07-07
source:
  person: Matt Pocock
  link: https://www.aihero.dev/things-people-get-wrong-with-grill-me-and-grill-with-docs
  medium: post
claim: >
  Common grilling failures: scoping too big and exhausting context, answering prototype-grade
  questions inside a grill session, passively letting the agent steer, and discarding the design value
  instead of capturing it.
stance: extends
touches: skills/grill-with-docs
status: noted
---

## Compare / contrast

Published 2026-05-25 (backfill window). Pocock — the upstream author of `grill-with-docs` (see the
2026-07-07 provenance entry, tracked in #51) — enumerates concrete failure modes of grilling: over-broad
scope that exhausts context, trying to resolve prototype-grade questions in a grill session instead of
handing off, letting the agent drive, and throwing away the resulting design value.

This **extends** the repo's own `skills/grill-with-docs`: these are ready-made **Anti-Patterns** for
that skill's required Anti-Patterns section, and they reinforce its "capture decisions inline
(`CONTEXT.md` / ADRs)" mandate (the "don't discard the value" failure).

## Disposition

`noted` — operational content distinct from the provenance entry: candidate additions to
`skills/grill-with-docs`'s Anti-Patterns (scope small, hand off prototype questions, drive the agent,
always capture the artifact). Pairs naturally with the #51 attribution/backport work.
