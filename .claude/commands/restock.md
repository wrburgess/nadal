---
description: Refresh the Tool Roster — re-verify each tracked harness/model entry's facts against its sources, apply only the real field-level deltas, and open a deltas-only PR (quiet when nothing changed).
---

Read and follow the canonical skill body at
[`skills/restock/SKILL.md`](../../skills/restock/SKILL.md), then execute its procedure — running one
Tool Roster refresh and opening a PR of the field-level deltas.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
