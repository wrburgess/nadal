---
date: 2026-07-07
source:
  person: Thorsten Ball
  link: https://registerspill.thorstenball.com/p/joy-and-curiosity-90
  medium: post
claim: >
  Amp's "Agents in Orbs" runs agents in ephemeral sandboxed environments, reframing an agent from a
  remote-controlled machine into an asynchronous function you queue and run in parallel.
stance: extends
touches: skills/ship
status: noted
---

## Compare / contrast

Published 2026-07-04 (Joy & Curiosity #90; the Orbs section is the substantive part of a curated
newsletter). Amp's "Agents in Orbs" run agents in ephemeral, sandboxed environments — turning an
agent from a machine you remote-control into an **asynchronous function** you queue ("run tests, fix
bugs, push") and fan out in parallel without managing state.

This **extends** `ship`'s discardable-sub-agent offload (`ADR-0005`): the same delegation instinct,
pushed into isolated, parallel, throwaway execution environments. Where `ship` today delegates
output-heavy phases to sub-agents whose context is discarded, Orbs generalizes the same "fire it, keep
the result, throw away the machine" shape at the infrastructure level.

## Disposition

`noted` — a possible future direction for `ship`'s optional sub-agent execution enhancement (isolated
parallel runners), not a change to adopt now. The graceful-degradation contract stays: the mechanism
may get richer, the inline procedure and gates do not change.
