# docs/reference/ — illustrative reference

Material in this directory is **illustrative reference, not part of the
[Generic Baseline](../../CONTEXT.md) guarantee.** Files here are examples a Host App is expected to
replace or extend during Customization.

Unlike the Config Bundle's business-neutral baseline (Skills, Rules Layer, Adapters), reference
content **may name specific external field sources** — it is *reference about the practice of
AI-assisted engineering*, not host-business-domain content, and not authored instructions any agent
must follow. The distinction, and why the intake pipeline's mechanism is baseline while its curated
content lives here, is recorded in [ADR 0012](../adr/0012-intake-pipeline-placement.md).

## Contents

- [`voices.yml`](voices.yml) — the machine-readable **Watchlist** the `scout` sweep polls (issue #30).
  Seeded from the #28 roster sketch; its schema is business-neutral, its entries are illustrative.
- [`learnings/`](learnings/) — the dated, append-only **Learnings Log** (issue #30): the entry
  [schema](learnings/README.md), the [index](learnings/index.md), and worked example entries.
- [`intake-inbox/`](intake-inbox/) — the **manual-drop inbox** (issue #28,
  [ADR 0014](../adr/0014-manual-drop-inbox-for-unfetchable-sources.md)): where a human drops raw
  pointers to output `scout` can't fetch (X, paywalled, feed-less) for the next sweep to turn into
  learnings. Its [drop schema](intake-inbox/README.md) is business-neutral; drops are host content.
- [`ai-engineering-voices.md`](ai-engineering-voices.md) — the curated roster prose doc of
  AI-engineering voices (issue #27): the human-readable sibling of `voices.yml`. It owns the narrative
  (per-person **Focus**, tier rationale, and the non-person *balance* documents + *master resource*);
  `voices.yml` owns the machine fields (`feeds`, `cadence`, `verified`, `status`) the sweep polls.
- [`tool-roster.yml`](tool-roster.yml) — the **Tool Roster** (issue #83,
  [ADR 0023](../adr/0023-tool-roster-facts-tracker-sibling-to-intake.md)): a current-state snapshot of the
  AI coding **harnesses** and **models** worth weighing for software development. Its schema is
  business-neutral mechanism; its entries are illustrative. A **sibling** to the Learnings Log —
  tools/facts, not voices/opinions — a *snapshot* (overwritten in place; git history is the log),
  refreshed by the `restock` skill.
