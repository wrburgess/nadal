---
date: 2026-07-08
source:
  person: Matt Pocock (AI Hero)
  link: https://www.aihero.dev/skills/skills-changelog-v1-1-wayfinder-to-spec-to-tickets-grilling-improvements
  medium: blog
claim: >
  /wayfinder charts a plan too big for one agent session as a map of session-sized GitHub issues
  linked by blocking relationships; the renamed /to-tickets emits tracer-bullet vertical-slice tickets
  whose blocking edges are either local text or native tracker links, so frontier tickets parallelize.
stance: extends
touches: docs/standards/development-lifecycle.md
status: noted
---

## Compare / contrast

Announced in the AI Hero skills v1.1 changelog (2026-07-08; captured as a manual drop — the changelog
page is JS-rendered and not fetchable by the sweep, so the human supplied the full text). This is the
**same upstream** the repo's `skills/grill-with-docs` is vendored from (see the 2026-07-07 provenance
entry, #51), so its lifecycle moves are directly comparable.

**The gap this names.** The headline skill, **`/wayfinder`**, is for a plan "too big for one agent
session" — it charts the plan as a **map saved as GitHub issues**, each decision scoped to one
agent-session and **linked with blocking relationships** so a dependent decision can't be made until
its prerequisites resolve. Its ticket types are **Research** (an AFK agent investigates and reports),
**Grilling** (a decision session), **Prototype** (raise discussion fidelity), and **Task** (config /
provisioning that needs no grilling). The renamed **`/to-tickets`** (merging the old `/to-plan` +
`/to-issues`) is the same mechanism in the small: it breaks a spec into tracer-bullet vertical-slice
**tickets**, each declaring its **blocking edges**, and the one artifact works two ways — as a local
`tickets.md` (edges as text, worked top-to-bottom) or against a real tracker (edges become native
blocking links, so any ticket whose blockers are done is on the frontier and multiple agents run in
parallel).

This **extends** how the repo works. The repo's lifecycle is deliberately **single-issue-shaped** —
one issue → one plan → one PR (`assess → cplan → impl → verify → rtr → final`,
`docs/standards/development-lifecycle.md`) — with only an **informal** umbrella/sub-PR convention
(`AGENTS.md` → *Umbrella sub-PRs and closing keywords*). Nothing in the baseline **decomposes an
oversized plan into sized, dependency-linked, parallelizable issues**; that upstream step is exactly
what wayfinder adds. The `/to-tickets` renames also **confirm** the repo's own platform-neutral-verbs
discipline (the *Lifecycle Host* artifact map, "never hardcode a platform verb"): Pocock's local-file
vs real-tracker duality is the same "map the verbs, don't hardcode the platform" move
([ADR 0006](../../../adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)).

## Disposition

`noted` — the actionable question for the human: should the lifecycle grow an explicit
**plan-decomposition stage** (plan → map to session-sized, blocking sub-issues → parallel implement)?
That would bear on `docs/standards/development-lifecycle.md`, `skills/cplan`, and `skills/ship`
(orchestration), and likely warrants a **new decomposition skill** rather than a tweak to `cplan`.
Note too that wayfinder is pitched to **replace `/grill-with-docs`** for larger planning — a signal
about the role of the repo's vendored grilling skill, and a companion to the #51 backport tracking.
