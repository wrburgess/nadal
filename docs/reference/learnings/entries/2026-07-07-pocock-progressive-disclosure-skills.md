---
date: 2026-07-07
source:
  person: Matt Pocock
  link: https://www.aihero.dev/skills/skills-changelog-v1-announcement
  medium: post
claim: >
  Skills v1 cuts session token cost ~63% via progressive disclosure — load short skill summaries
  first, pull full bodies only when needed — plus a `disable-model-invocation` flag that keeps a
  skill's description out of the selection context.
stance: confirms
touches: ADR-0003
status: noted
---

## Compare / contrast

Published 2026-06-18 (backfill window). Pocock's skills v1 release reports a ~63% session-token
reduction from **progressive disclosure**: load a short summary first, load the full skill body only
on invocation — plus a `disable-model-invocation` flag that removes a skill's description from the
model's selection context entirely.

This **confirms** the repo's `ADR-0003` skill design (canonical body reached through a thin shim, body
loaded on invoke) and its `ADR-0004` context-economy goal — the same "summary resident, body deferred"
shape, now with a measured token payoff. The `disable-model-invocation` flag is a concrete idea worth
noting against the shim design (a way to keep rarely-used skills out of selection context).

## Disposition

`noted` — external, quantified validation of progressive-disclosure skill loading. Distinct from the
already-logged "kill the bloat" entry (that one trims *unused tools* via a proxy; this one is about
*skill loading architecture*). Candidate note for `ADR-0003` / `rules/skills.md`.
