---
date: 2026-07-06
source:
  person: Erik Schluntz & Barry Zhang (Anthropic)
  link: https://www.anthropic.com/engineering/building-effective-agents
  medium: blog
claim: >
  Prefer simple, composable patterns over frameworks; add agentic complexity only when it
  demonstrably improves outcomes.
stance: confirms
touches: ADR-0003
status: noted
---

## Compare / contrast

"Building Effective Agents" argues that most successful agent systems are built from **simple,
composable patterns** rather than heavy frameworks, and that autonomous, open-ended complexity should
be added only when a simpler workflow demonstrably falls short.

This **confirms** the design already recorded in
[ADR 0003](../../../adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md): each Skill is
a single canonical body reached through a **thin Invocation Shim**, and tool-specific execution
enhancements (e.g. sub-agent offload) **degrade gracefully** to the same inline procedure. The quality
bar is the constant; only the mechanism varies. That is the same "start simple, escalate only when it
earns its keep" principle applied to Skill authoring.

## Disposition

`noted` — no change proposed. The learning reinforces an existing decision rather than prompting a new
one; logged as external corroboration of ADR 0003 (the "external best-practice → ADR" evidence loop
Epic #1 established). If a future Skill is tempted toward a heavier mechanism, this entry is the
counter-weight to cite.
