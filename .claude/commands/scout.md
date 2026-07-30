---
description: Sweep the intake Watchlist for new field output, draft dated Learnings-Log entries that each carry a stance and a touches target, then — on an interactive run — walk them one finding at a time for a human to accept, edit, or reject before opening the PR (a scheduled run opens the PR for asynchronous disposition).
---

Read and follow the canonical skill body at
[`skills/scout/SKILL.md`](../../skills/scout/SKILL.md), then execute its procedure — running one
intake sweep and opening a PR of the drafted learning entries.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
