---
date: 2026-07-07
source:
  person: Simon Willison
  link: https://simonwillison.net/2026/Jul/4/better-models-worse-tools/
  medium: post
claim: >
  Newer Anthropic models are worse at custom third-party edit tools — inventing schema fields —
  because they were trained hard on Claude Code's built-in tools.
stance: confirms
touches: ADR-0003
status: noted
---

## Compare / contrast

Published 2026-07-04. Willison reports that newer models (Opus 4.8 / Sonnet 5) are measurably *worse*
at custom third-party edit tools — they hallucinate schema fields — because they were trained hard on
Claude Code's built-in tool shapes. The tool that works today can regress on the next model.

This **confirms** the core bet recorded in `ADR-0003` (canonical body + thin Invocation Shims +
graceful degradation): tool-specific mechanisms are **fragile across model versions**, so the
load-bearing thing must be a model/tool-neutral canonical procedure, with tool-specific enhancements
degrading gracefully rather than being depended on. This is direct field evidence for exactly that
fragility.

## Disposition

`noted` — strong external corroboration of `ADR-0003`. If a future Skill is tempted to make a
tool-specific mechanism load-bearing (rather than an optional enhancement over the inline procedure),
this entry is the counter-weight to cite.
