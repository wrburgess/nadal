# Intake pipeline: mechanism is Generic Baseline, curated content is illustrative reference

**Status:** accepted

## Context

The Config Bundle is growing a **feedback loop** for keeping its own guidance current: monitor how
the field of AI-assisted engineering evolves and fold durable learnings back into the Rules Layer,
Skills, and ADRs. The mechanism has three artifacts — a curated **roster** of field voices, a
machine-readable **Watchlist** the sweep polls, and a dated **Learnings Log** whose entries each
carry a *stance* (`confirms | challenges | extends | orthogonal`), a *touches* target (a rule, skill,
or ADR), and a *status* — plus a `scout` Skill that drafts entries and proposes them via a pull
request for a human to accept, edit, or reject.

This raises a placement question with a genuine trade-off. The Config Bundle ships a **Generic
Baseline** that "contains no reference to any specific company, product, or domain," yet a curated
roster necessarily names specific external people and organizations. Two in-repo precedents pull in
opposite directions: `rules/*.md` name concrete technologies and are still called business-neutral
starters, whereas the `CONTEXT.md` domain dialogue treats *named content* as Host-App Customization,
not baseline.

## Decision

Split the concern by **kind of thing**, not by file:

- **The mechanism is Generic Baseline.** The `scout` Skill, the Watchlist and Learnings-Log
  *schemas*, and this ADR are business-neutral and ship in the bundle. They name no specific person,
  company, or product; where a Skill body needs a path it reads it from Project Config rather than
  hardcoding one.
- **The curated content is illustrative reference, not baseline.** The populated roster, the filled
  Watchlist, and the accumulated Learnings Log live in-repo under `docs/reference/`, explicitly
  labeled as illustrative examples a Host App replaces or extends — outside the Generic Baseline
  guarantee. This mirrors how this repo already cites named external field sources in its ADRs and
  `docs/research/` as *reference about the practice*, which is distinct from a Host App's business
  domain.

## Considered options

- **A — Strict split:** mechanism baseline; the roster and content are Host-App Customization living
  outside this repo entirely. Rejected — it discards useful, discoverable reference material for no
  guarantee the Option C label does not already provide.
- **B — Unified starter:** ship the roster and content in the bundle as "extend per host," like
  `rules/*.md`. Rejected — it places specific named entities inside the Generic Baseline, eroding the
  "no specific company/product" invariant and setting a precedent that any named content is
  baseline-eligible.
- **C — Hybrid quarantine (chosen):** mechanism baseline; content as labeled illustrative reference
  under `docs/reference/`. Keeps the operational baseline name-free while preserving the reference
  material.

## Consequences

- A new `docs/reference/` directory is the home for illustrative, non-baseline reference content,
  each file headed with a "not part of the Generic Baseline" label. The roster (issue #27) files
  here.
- Downstream work inherits two guardrails, recorded here so they are not rediscovered painfully:
  - the `scout` Skill body must avoid the parity check's host-specific-token denylist — notably the
    substrings `docs/rules/` and `.claude/rules/`;
  - any link *from* a link-checked Adapter file to a not-yet-created target must be written as a
    backticked path, not a Markdown link, until the target exists.
- The parity check does not police any of this — ADRs, `CONTEXT.md`, and reference content are
  unchecked — so the placement is upheld by convention and review, not CI.
