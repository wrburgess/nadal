---
description: The intake pipeline's roster front door — turn a bare handle or a link into the correct add-or-update on the Watchlist, deduping first so an already-tracked account is refreshed rather than duplicated, then open a review PR.
---

Read and follow the canonical skill body at
[`skills/follow/SKILL.md`](../../skills/follow/SKILL.md), then execute its procedure — normalizing the
handed-over handle or link, deduping it against the existing roster before proposing, assembling a
schema-valid add-or-update that honors the real-URL discipline, keeping the roster's prose companion in
parity, and opening the review PR.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
