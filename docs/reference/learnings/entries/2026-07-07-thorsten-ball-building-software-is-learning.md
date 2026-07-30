---
date: 2026-07-07
source:
  person: Thorsten Ball
  link: https://registerspill.thorstenball.com/p/building-software-is-learning
  medium: blog
claim: >
  Building new software is inherently a learning process, so optimize for fast feedback loops
  (prototypes, thin specs, incremental shipping) rather than a heavy up-front plan that won't survive
  contact with reality.
stance: challenges
touches: docs/standards/development-lifecycle.md
status: actioned
status_detail: >
  → #58: right-size the cplan plan to the task (spike/prototype for discovery work) and frame the
  approved plan as revisable direction, not a contract — without weakening the plan-approval gate.
---

## Compare / contrast

Published 2026-06-02 (backfill window). Ball argues that because building software is a discovery
process, teams should ship-to-learn — thin specs, prototypes, incremental delivery — instead of
investing weeks in a plan that breaks on contact with reality.

This **challenges** the repo's lifecycle on the surface — it front-loads a formal `cplan` stage behind
a **mandatory plan-approval gate**. But the conflict is mostly one of **altitude**: Ball targets
heavyweight, weeks-long plans, whereas `cplan` is **per-issue** (already close to a thin spec), and the
lifecycle as a whole is itself a ship-to-learn loop (Assess→Plan→Impl→Verify→Deliver, one increment at
a time — the same nested-loop shape as the logged Andrew Ng "loop engineering" entry). The gate's real
job — a human checkpoint against an agent confidently building the wrong thing at scale — is orthogonal
to *how much* to plan. What genuinely remains is two failure modes: **over-planning a discovery task**
(a full ordered plan written against unknowns) and the **plan-as-contract fallacy** (treating an
approved plan as frozen, discouraging mid-`impl` course-correction).

## Disposition

`actioned` (**#58**). Not a reason to weaken the plan gate — the human checkpoint is the repo's core
safety property. Instead, absorb Ball's point as a `cplan` refinement: (a) **right-size the plan to the
task** — for discovery work, a thin hypothesis + a spike + a re-plan checkpoint, not a full
implementation plan; and (b) frame the approved plan as **revisable direction, not a contract**
(discovering it was wrong mid-`impl` is an expected loop-back, not a failure). This rhymes with the
repo's existing "start simple, escalate only when it earns its keep" value (`ADR-0003`) — the same
principle applied to planning.
