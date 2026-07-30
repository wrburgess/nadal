---
date: 2026-07-07
source:
  person: OpenAI Cookbook
  link: https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop
  medium: docs
claim: >
  An improvement flywheel where real traces + human/model feedback become reusable evals, and Codex
  proposes harness changes a developer approves before merge.
stance: confirms
touches: docs/standards/development-lifecycle.md
status: noted
---

## Compare / contrast

Published 2026-05-11 (backfill window). OpenAI's cookbook describes an improvement flywheel: real
traces plus human/model feedback become **reusable evals**, and Codex proposes harness changes (the
"harness" = the full contract around the model — instructions, tools, routing, output requirements,
validation) with a developer **approving the diff before merge**.

This **confirms** two repo commitments at once: evals-as-first-class-tests (`rules/testing.md`) and
the **merge human gate** (`docs/standards/development-lifecycle.md`). Its "harness" is essentially the
repo's Config Bundle concept — the durable contract around whichever model runs.

## Disposition

`noted` — primary-source corroboration of the evals-first + human-gated-merge lifecycle from a
different vendor. No change proposed; strong external citation.
