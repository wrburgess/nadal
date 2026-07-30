---
date: 2026-07-08
source:
  person: Matt Pocock (AI Hero)
  link: https://www.aihero.dev/skills/skills-changelog-v1-1-wayfinder-to-spec-to-tickets-grilling-improvements
  medium: blog
claim: >
  v1.1's /code-review runs two parallel sub-agents (Standards vs Spec) and invokes Martin Fowler's
  refactoring smells by name to lift code quality cheaply; refactoring is moved out of the /tdd loop
  into this review phase.
stance: extends
touches: rules/self-review.md
status: noted
---

## Compare / contrast

From the AI Hero skills v1.1 changelog (2026-07-08; manual drop, full text supplied). Two review moves
here are cheap, portable, and land on how this repo reviews its own work:

- **Name the refactoring smells.** The upstream `/code-review` invokes **Martin Fowler's code smells
  by name** — mysterious name, duplicated code, feature envy, data clumps, primitive obsession,
  repeated switches, divergent change, speculative generality, message chains, middleman — on the
  insight that the model **already knows them deeply from training**, so ~10 lines of guidance
  "invokes the idea" and the agent then finds and removes them. Reported "outrageously useful" over a
  couple of weeks of testing.
- **Two-axis parallel review.** It reviews on a **Standards** axis (compliance with a
  `codingstandards.md`-style file) and a **Spec** axis (correctness vs the originating spec/ticket) as
  **parallel sub-agents**, each walking the code independently.
- **Refactor relocated.** In the same release, `/tdd` becomes reference-only and **refactoring is
  moved out of the Red-Green-Refactor loop into the code-review phase**, to keep the implementation
  session focused rather than overloaded with refactoring concerns.

This **extends** the repo's review surface. `skills/verify` (self-review before the reviewer sees it),
`skills/rtr` (review response), and `rules/self-review.md` (the before-done checklist) already ask for
quality passes, but none **names a smell vocabulary** to trigger the model's priors — a near-free
addition. The two-axis split maps onto the repo's own separation of **standards** (`rules/*.md`) from
**spec/plan fidelity** (`verify`'s drift check). The refactor-relocation is a live question for
`rules/testing.md`, whose TDD guidance currently keeps refactor inside the loop.

## Disposition

`noted` — candidate additions: (1) a named-refactoring-smell checklist line in `rules/self-review.md`
(and/or `skills/verify`) that costs ~10 lines and leverages the model's training; (2) consider the
two-axis (standards vs spec) framing for `verify`/`rtr`; (3) weigh moving refactoring out of the TDD
loop into review in `rules/testing.md`. A human decides which, if any, on the PR.
