---
date: 2026-07-07
source:
  person: Matt Pocock
  link: https://www.aihero.dev/skills-catalog
  medium: docs
claim: >
  Skills are focused, repeatable markdown files (instructions + required inputs + expected outputs)
  that map to specific engineering moments, letting an engineer keep taste and standards while the
  agent does the work.
stance: confirms
touches: rules/skills.md
status: noted
---

## Compare / contrast

Published 2026-07-06. Pocock's skills catalog frames skills as focused, repeatable markdown files —
instructions plus required inputs and expected outputs — each mapped to a specific engineering moment,
so the engineer "keeps taste and standards intact while the agent does the work."

This **confirms** the repo's canonical-`SKILL.md`-body philosophy (`rules/skills.md`, `ADR-0006`):
skills as portable markdown moves with defined inputs/outputs.

**A tension the human should weigh:** Pocock's skills live in `~/.claude` — Claude-specific,
single-tool — whereas the repo's whole thesis is **tool-neutral single-sourcing** with thin per-tool
Invocation Shims. The repo effectively *extends* his single-tool model to multi-tool; that the field's
leading skills practice is still single-tool is evidence the repo's multi-tool differentiator is real,
not redundant.

## Disposition

`noted` — validates skills-as-markdown. The multi-tool differentiator is the repo's, not the field's;
worth restating explicitly in `rules/skills.md`'s rationale so the distinction is not lost as the
community pattern spreads.
