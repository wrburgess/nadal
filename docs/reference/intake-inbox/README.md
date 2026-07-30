# docs/reference/intake-inbox/ — the manual-drop inbox

The **manual-drop inbox** is where a human drops a raw pointer to field output the automated
[`scout`](../../../skills/scout/SKILL.md) sweep **can't fetch on its own** — chiefly X (Twitter)
posts, paywalled or login-walled writing, and anything without a public feed. It is the deliberate
escape hatch for the intake pipeline's one structural blind spot: the [Watchlist](../voices.yml)
sweep polls feeds and searches handles, but some of the most valuable signal lives behind surfaces no
agent can poll (issue #28).

> **ILLUSTRATIVE REFERENCE — not part of the [Generic Baseline](../../../CONTEXT.md) guarantee.**
> The *drop schema and the inbox lifecycle* documented below are business-neutral mechanism; any
> *actual drops* a host adds are curated content. Placement follows
> [ADR 0012](../../adr/0012-intake-pipeline-placement.md) (mechanism is baseline, content is
> reference); the inbox itself is recorded in
> [ADR 0014](../../adr/0014-manual-drop-inbox-for-unfetchable-sources.md).

## Why this exists (and why a subscription doesn't replace it)

`scout` reaches a source one of two ways: it polls a resolved `feeds:` entry, or it falls back to
searching the source's `handles`. Both need a **publicly fetchable** surface. Two common cases defeat
that, and no consumer subscription fixes them:

- **X (Twitter)** exposes no free/public feed (since 2023), and **consumer X Premium grants no API
  access** — that is a separate, expensive developer product. A logged-in human timeline is not
  reachable by a headless sweep.
- **Paywalled / login-walled** posts, and **feed-less** sites, are visible to a subscribed human but
  return a wall or an empty page to `WebFetch`.

For those, the human is the sensor: you paste the link and one line of context, and `scout` does the
rest of the pipeline's work on it — the compare/contrast, the stance, the proposed `touches` target.
The human still **disposes on the PR**, so the two-gate philosophy is intact: a drop is *input signal*,
never an accepted learning.

## Drop schema

One Markdown file per drop under this directory, named `YYYY-MM-DD-slug.md`, with a small YAML
front-matter block. Only `url` is strictly required — a drop is *raw input*, not a finished
[Learnings-Log](../learnings/README.md) entry, so it carries **no `stance`** (assigning the stance is
`scout`'s job, not yours):

```yaml
---
url: https://…              # the item to ingest — a real URL, required
source: Display Name        # who published it (person, org, or channel) — recommended
medium: post | video | podcast | blog | paper | docs | other
dropped: YYYY-MM-DD         # when you dropped it — optional, helps recency
---
Optional free text: why this caught your eye, or what in this repo to weigh it against
(a rule, a skill, an ADR). One or two sentences is plenty — a hint for scout, not a writeup.
```

Copy [`TEMPLATE.md`](TEMPLATE.md) to start a drop. Drop as many as you like; the next sweep takes
them all.

## Lifecycle — drop, sweep, dispose

1. **You drop.** Add a file here (copy the template). Thirty seconds: link, who, one line of why.
2. **The next sweep reads it.** `scout` treats every drop as a **first-class candidate**, alongside
   whatever the feed/handle sweep finds — it fetches/reads the `url`, compares the claim against how
   this repo already works, and drafts a Learnings-Log entry carrying a `stance` and a `touches`
   target, exactly as it does for a feed item.
3. **The same PR clears the drop.** A drop that produced an entry is **removed from the inbox in that
   same PR**, so it is never reprocessed. The drop's job ends when its learning is proposed.
4. **A drop that can't earn a stance stays put.** If `scout` can't state whether the item *confirms /
   challenges / extends / is orthogonal* to this repo, it does **not** invent one (the Learnings Log's
   one hard rule). Because a human curated the drop, `scout` **leaves it in the inbox** and flags it in
   the PR's staleness notes — feedback to you, not a silent discard. Re-word the context or drop a
   better link, or delete it yourself if it was noise.
5. **You dispose.** You accept, edit, or reject the drafted entry on the PR — the same gate as every
   other sweep finding.

## Conventions

- **Never invent a URL.** A drop with no real `url` is not a drop. (Same discipline as the Watchlist
  and the Learnings Log.)
- **A drop is not a learning.** It carries no `stance` and is not itself a log entry — it is the raw
  material `scout` turns into one. The stance rule lives on the *entry*, not the drop.
- **The inbox is transient.** Processed drops leave in the sweep PR; the steady state is empty (just
  this README and the template). A growing pile of un-cleared drops means the sweep hasn't run — that
  is visible staleness, by design.
