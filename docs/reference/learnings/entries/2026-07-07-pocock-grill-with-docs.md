---
date: 2026-07-07
source:
  person: Matt Pocock
  link: https://www.aihero.dev/grill-with-docs
  medium: docs
claim: >
  An AI interview that stress-tests design decisions one question at a time, capturing settled
  vocabulary as a glossary and hard-to-reverse choices as ADRs before any code is written.
stance: challenges
touches: skills/grill-with-docs
status: actioned
status_detail: >
  → #51: credit Matt Pocock as the upstream source of skills/grill-with-docs (copied, verified
  uncredited) and track his version for backports.
---

## Compare / contrast

Published 2026-07-06. **Provenance:** the repo's `skills/grill-with-docs` is **adapted from Matt
Pocock's skill of the same name — his is the upstream original; the repo did not originate it.** Pocock's
version is the same move the repo ships: an AI interview that stress-tests design one question at a
time, capturing settled vocabulary as a glossary and hard-to-reverse choices as ADRs before code.

Because the repo's Skill is **downstream** of Pocock's, this is not independent validation — it's an
**attribution gap plus a maintenance pointer**. A grep of `skills/grill-with-docs/` and its shim finds
**no mention of Pocock or any source** — so the repo currently ships a copied Skill uncredited. His
published version is the canonical upstream to (a) credit as the source and (b) watch for refinements
(prompt shape, capture format) worth backporting into the repo's copy.

## Disposition

`noted` — the stance is `challenges` because the confirmed lack of attribution is a gap in how the
repo works today, not corroboration of it. Two actions for the human: **credit Pocock as the upstream
source** of `skills/grill-with-docs` (verified missing today), and **track his version** for
improvements to backport. This likely warrants a follow-up issue, not only a log note.
