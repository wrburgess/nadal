---
date: 2026-07-07
source:
  person: Anthropic
  link: https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more
  medium: blog
claim: >
  Anthropic's own breakdown of Claude Code's customization primitives — CLAUDE.md, path-scoped rules
  loaded at session start, progressive-disclosure skills, isolated-context subagents, and settings.json
  hooks.
stance: confirms
touches: rules/skills.md
status: noted
---

## Compare / contrast

Published 2026-06-18 (backfill window). Anthropic describes the exact primitive set and loading
semantics this repo is built on: **rules** (`.claude/rules/`, path-scoped, load at session start),
**skills** (name+description at start, body on invoke), **subagents** (isolated context, only results
return), and **hooks** (deterministic, event-fired in `settings.json`).

This is **first-party validation of the repo's whole architecture**: the two-tier path-scoped Rules
Layer (`ADR-0004`), the canonical-body + on-invoke skill loading (`ADR-0003`, `rules/skills.md`), the
discardable-subagent offload the lifecycle skills use, and the branch-protection hooks
(`ADR-0009`). It also names two primitives the repo could reference explicitly (output styles,
system-prompt appending).

## Disposition

`noted` — the strongest external corroboration yet of the repo's design (the vendor describing the
same primitives). Candidate to cite across `rules/skills.md`, `ADR-0003`, `ADR-0004`, `ADR-0009` as
the authoritative source for the primitives the repo builds on.
