# Manual-drop inbox: a human-fed lane for sources the sweep can't fetch

**Status:** accepted

## Context

The [Intake Pipeline](0012-intake-pipeline-placement.md) reaches a source one of two ways: the
`scout` sweep polls a resolved `feeds:` entry in the [Watchlist](../reference/voices.yml), or it falls
back to `WebSearch`/`WebFetch` against the source's `handles`. Both require a **publicly fetchable**
surface. Resolving the Watchlist's feeds (issue #28 follow-up) made this concrete: a class of
high-signal sources structurally defeats automated fetch and **no consumer subscription closes the
gap**:

- **X (Twitter)** has exposed no free/public feed since 2023, and consumer **X Premium grants no API
  access** — programmatic reading is a separate, expensive developer product. A logged-in human
  timeline is unreachable by a headless sweep.
- **Paywalled / login-walled** writing and **feed-less** sites return a wall or an empty page to
  `WebFetch` even when a subscribed human reads them fine.

Left unaddressed, these become a silent blind spot: the sweep looks "all clear" while missing exactly
the material a maintainer most wants folded in. The pipeline already has the right governance
(propose-via-PR, human disposes) and the right home for durable learnings (the Learnings Log) — what
it lacked was an **input lane for signal a human can see but the agent cannot fetch.**

## Decision

Add a **manual-drop inbox** — a directory where a human drops a raw pointer (a real `url`, who
published it, one line of why) to output the sweep can't reach. `scout` reads the inbox as a
**first-class source** alongside the Watchlist: it fetches/reads each drop, does the same
compare/contrast, and drafts a Learnings-Log entry carrying a `stance` and a `touches` target.

- **A drop is raw input, not a learning.** It carries **no `stance`** — assigning the stance is
  `scout`'s job. This keeps the Learnings Log's one hard rule (a stance-less *entry* is invalid) on the
  entry, not on the human's 30-second drop.
- **The human disposes on the PR.** A drop is input signal; the drafted entry still routes through the
  same review PR as every sweep finding. The two-gate philosophy is untouched — the human is now the
  *sensor* for unfetchable sources, but not the accepter of the learning.
- **Processed drops are cleared in the sweep PR**, so nothing is reprocessed; a drop that can't earn a
  stance is **left in place and flagged** in the PR (feedback, not a silent discard). The steady state
  is an empty inbox — an un-cleared pile is visible staleness.
- **Placement follows [ADR 0012](0012-intake-pipeline-placement.md):** the inbox *mechanism* (the drop
  schema, the lifecycle, `scout`'s handling of it) is business-neutral Generic Baseline; any *actual
  drops* are curated content that lives in the reference zone. Its location is declared in
  [`PROJECT.md`](../../PROJECT.md) → *Intake Pipeline* so the `scout` body names no path.

## Considered options

- **A — Manual-drop inbox (chosen):** a human-fed directory `scout` sweeps as a first-class source.
  Closes the unfetchable-source gap with ~30 seconds of human effort per item, reusing the existing
  stance-drafting and PR gate. No new credential, no scraping, no ToS risk.
- **B — Accept X/paywalled as a permanent blind spot:** simplest, but silently drops the highest-signal
  sources and makes the sweep's "all clear" a lie. Rejected — it abandons the material the pipeline
  most exists to catch.
- **C — Integrate a paid X/developer API or a scraper:** rejected — it puts a specific paid product and
  a live credential into the Generic Baseline (contradicting ADR 0012's neutrality), risks ToS
  violations, and still doesn't cover arbitrary paywalled sources. Brittle and non-neutral.

## Consequences

- The `scout` body gains one input source and two housekeeping rules (clear processed drops; flag
  un-stanceable ones); the procedure, stance discipline, and human-disposes gate are unchanged.
- X-only and feed-less Watchlist entries can keep `feeds: []` honestly — the inbox, not a faked feed,
  is their coverage path.
- The inbox is transient by design; its emptiness is the healthy state, and a growing pile signals the
  sweep hasn't run — staleness stays visible rather than hidden.
