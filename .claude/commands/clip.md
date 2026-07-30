---
description: The intake pipeline's push front door — capture human-handed field output (a screenshot, a link, or a quote), enforce the real-URL gate, write a stance-less manual-drop inbox drop, then delegate to scout to draft the entry and open the review PR.
---

Read and follow the canonical skill body at
[`skills/clip/SKILL.md`](../../skills/clip/SKILL.md), then execute its procedure — capturing the
handed-over item, enforcing the real-URL gate, writing a stance-less inbox drop, and delegating to
`scout` to draft the entry and open the review PR.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
