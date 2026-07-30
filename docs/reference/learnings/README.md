# docs/reference/learnings/ — the Learnings Log

The **Learnings Log** is the dated, append-only record of intake findings produced by the intake
pipeline (issue #28): each entry captures one claim from a field source and, crucially, **compares it
against how this Config Bundle already works** so it drives a concrete change — or a deliberate
no-change — here.

> **ILLUSTRATIVE REFERENCE — not part of the [Generic Baseline](../../../CONTEXT.md) guarantee.**
> The *entry schema* documented below is business-neutral mechanism; the *accumulated entries* under
> `entries/` are curated content a Host App replaces or extends during Customization. Placement is
> ratified in [ADR 0012](../../adr/0012-intake-pipeline-placement.md); the reference-zone label
> rationale lives in [`docs/reference/README.md`](../README.md).

## Entry schema

Every entry is one Markdown file under [`entries/`](entries/) named `YYYY-MM-DD-slug.md`, carrying a
YAML front-matter block with this fixed shape (terms are canonical — see
[`CONTEXT.md`](../../../CONTEXT.md) → *Learnings Log*):

```yaml
---
date: YYYY-MM-DD              # when the finding was logged
source:                       # who/what the claim comes from
  person: Display Name        #   (or org/channel)
  link: https://…             #   a real URL — never invented
  medium: blog | podcast | video | paper | post | docs
claim: >                      # the technique/assertion in one line
  One-sentence statement of what the source claims.
stance: confirms | challenges | extends | orthogonal   # vs. THIS repo — REQUIRED
touches: rules/… | skills/… | ADR-NNNN | none          # the artifact the learning bears on
status: noted | actioned | rejected                    # disposition
status_detail: >              # required when status is `actioned` (-> #issue / ADR) or `rejected` (the reason)
  Optional for `noted`.
---
```

The Markdown body below the front-matter holds the compare/contrast prose: *why* the stance, and what
(if anything) should change in the `touches` target.

## The one hard rule

**A `stance`-less entry is invalid by convention.** If a finding can't state whether it *confirms*,
*challenges*, *extends*, or is *orthogonal* to how this repo already works, it is noise, not a
learning, and is not added. That single rule is what keeps this log from degrading into a dead-link
dump (per #28's Anti-Patterns).

Two more conventions inherited from #28:

- **Stamp recency.** Every entry is dated, and every URL a sweep checks is date-stamped in
  [`voices.yml`](../voices.yml) (`verified:`) — silent staleness is an anti-pattern.
- **A sweep proposes; a human disposes.** Entries arrive via a reviewable PR (the `scout` flow,
  issue #31); the machine never gets the last word on what counts as a learning.

## Where entries land

- [`index.md`](index.md) — the chronological, recency-first index of every entry.
- [`entries/`](entries/) — one file per entry. See the two worked examples for the exact shape.
