---
date: 2026-07-08
source:
  person: Matt Pocock (AI Hero)
  link: https://www.aihero.dev/skills/skills-changelog-v1-1-wayfinder-to-spec-to-tickets-grilling-improvements
  medium: blog
claim: >
  v1.1 fixes the shared reference grilling skill (the upstream of the repo's vendored grill-with-docs):
  a confirmation gate barring implementation until the human confirms shared understanding, Facts-vs-
  Decisions leading words that stop the model self-grilling, and a sharper one-question-at-a-time rationale.
stance: extends
touches: skills/grill-with-docs
status: noted
---

## Compare / contrast

From the AI Hero skills v1.1 changelog (2026-07-08; manual drop, full text supplied). Because the
repo's `skills/grill-with-docs` is **vendored from this exact upstream** (provenance entry 2026-07-07,
tracked in #51), these are not abstract ideas — they are **concrete refinements to the very skill the
repo copied**, and each maps to a line in our copy:

- **Confirmation gate before implementation.** The upstream added "Do not enact the plan until I
  confirm we've reached a shared understanding," fixing sessions that ended and jumped straight into
  implementation. The repo's grill-with-docs already captures decisions inline, but a human
  **shared-understanding gate before hand-off** is a targeted addition, and it echoes the lifecycle's
  plan-approval gate.
- **Facts vs Decisions leading words (anti-self-grilling).** The upstream distinguishes **Facts**
  (things found by exploring the codebase) from **Decisions** (things the human must decide), which
  stopped the model from **grilling itself** without human input — a failure seen "especially with
  Fable." This is a portable anti-pattern for our grilling body, and it lines up with the earlier
  agent-read-authoring learning (leading words help any agent-read text, `rules/skills.md`).
- **Sharper "one question at a time" rationale.** The upstream made the *why* explicit because the
  model would still batch questions despite the instruction. The repo's grilling flow — and `scout`'s
  one-at-a-time disposition — both lean on this rule, so strengthening the rationale in the body pays
  off in more than one place.

This **extends** the repo: same skill, improved. It reinforces the existing grill-with-docs
anti-patterns entry (2026-07-07) and the #51 attribution/backport work rather than opening a new axis.

## Disposition

`noted` — ready-to-backport edits to `skills/grill-with-docs`: (1) a shared-understanding confirmation
gate before implementation; (2) Facts-vs-Decisions leading words to prevent self-grilling; (3) a more
explicit one-question-at-a-time rationale. Fold these into the #51 backport pass rather than opening a
separate track. A human decides scope on the PR.
