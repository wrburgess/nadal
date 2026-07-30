# Intake front door: a `drop` skill that pushes a human-handed item into the sweep

> Note (#73): the `/drop` skill was renamed to `/clip`.

**Status:** accepted

## Context

The [Intake Pipeline](0012-intake-pipeline-placement.md) is a **pull** system: the
[`scout`](../../skills/scout/SKILL.md) sweep goes looking for new field output — polling Watchlist
feeds, searching handles, and reading the
[manual-drop inbox](0014-manual-drop-inbox-for-unfetchable-sources.md) — on a manual or scheduled
run. The inbox added a human-fed lane for sources the sweep can't fetch, but it is a **destination**,
not an entry procedure: a drop is a file a human writes by hand into a directory, then waits for the
next sweep to process.

That left a gap. Nothing was the intake pipeline's **push front door** — a way for a human who has a
specific item in hand *right now* to hand it to an agent in any session and get a reviewable proposal
back in one step. In practice a zero-context session couldn't route a pasted screenshot of, say, an X
post: there was no skill that said "capture this, write it as a well-formed drop, and run the rest of
the pipeline on it." The near-miss that surfaced the gap was worse than a no-op — lacking a real
permalink for a screenshot, the improvised path **fudged `source.link` to a profile/handle URL** to
make the drop "valid," exactly the fabricated-URL anti-pattern the Watchlist, the Learnings Log, and
the inbox each forbid. The pipeline needed an explicit front door that makes the real-URL rule
first-class and hands the compare/contrast work to `scout` rather than reinventing it.

## Decision

Ship a thin **`drop`** skill — the intake pipeline's **push front door** — that captures
human-handed field output (a screenshot, a link, or a quote), enforces a hard **real-URL gate**,
writes a well-formed **stance-less** drop into the manual-drop inbox, then **delegates to `scout`**
(scoped to that one drop) to do the compare/contrast, draft the Learnings-Log entry (its `stance` and
`touches`), clear the processed drop, and open the review PR. One invocation → a reviewable PR is the
happy path; a human **disposes on the PR**.

- **`drop` references `scout`; it never restates it** (`rules/skills.md`, single-source contract). The
  ingestion procedure lives once in `scout`'s body. `drop` adds only the front-door steps: capture,
  the URL gate, the well-formed drop, and the hand-off. This matches the
  [`ship`](0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md) orchestrator precedent —
  a composing skill that sequences others by reference.
- **The real-URL gate is promoted to a first-class rule.** A drop needs a **real permalink** to the
  item — one a human can open. The gate is *reality*, not the agent's own reach: a real-but-unfetchable
  X/paywalled/feed-less URL **passes** (that is precisely the unreachable-by-sweep output the inbox
  exists to carry), and only an **absent or fake** URL fails. When the human handed over a screenshot or
  quote with no URL, `drop` **asks the human** for the permalink — it never fudges to a
  profile/handle/home-page URL and never invents one. This is the
  same discipline the Watchlist, the Learnings Log, and the inbox already state
  ([ADR 0014](0014-manual-drop-inbox-for-unfetchable-sources.md)); `drop` makes it the front door's
  hard gate rather than an improvised judgment call.
- **`scout` gains a small, additive inbox-only / specific-drop scope.** When `drop` hands off one
  item, `scout` processes **only** the inbox drop: it skips the Watchlist feed/handle sweep, does
  **not** advance the last-swept marker (no feed window was swept — advancing it would make a later
  full sweep skip everything up to today), and surfaces no feed-staleness for un-swept sources. The
  default full-sweep behavior is unchanged. This is a guard clause on three existing steps, not a
  restructure of `scout`'s just-landed inbox handling.
- **Explicit-command-only.** `drop` is invoked deliberately (`/drop`, or the documented "read and
  follow the body" path on the native-discovery tools). There is **no passive `AGENTS.md` recognition
  line** that auto-triggers ingestion when a human happens to paste a link — the front door opens only
  when a person asks for it, keeping the pipeline's propose/dispose governance explicit.
- **The stance-less outcome is honored, not overridden.** "One invocation → a PR" is the happy path
  for a deliberately-handed item, not a licence to invent a stance. If `scout` genuinely cannot state
  whether the item *confirms / challenges / extends / is orthogonal* to how this repo works, it leaves
  the drop in the inbox and **reports back — no PR** (the empty-sweep rule,
  [ADR 0013](0013-scheduled-intake-sweep-and-empty-sweep-policy.md), and the inbox lifecycle).
- **Graceful degradation ([ADR 0003](0003-skills-canonical-body-thin-shims-graceful-degradation.md)):**
  a tool that cannot read an image asks the human to paste the text plus the URL; a tool without
  sub-agents runs `scout`'s body inline, scoped to the drop. The mechanism degrades; the URL gate, the
  stance discipline, and the human-disposes gate never do.

## Considered options

- **A — Thin `drop` that delegates to `scout` (chosen):** a front-door skill that captures, gates the
  URL, writes the stance-less drop, and hands off to `scout` for everything downstream. Zero churn to
  `scout`'s just-landed inbox handling (only an additive scope clause), matches the `ship` orchestrator
  precedent and the `rules/skills.md` single-source contract, and makes the real-URL gate first-class.
- **B — Extract a shared "process one item" core called by both `scout` and `drop`:** factor the
  compare/contrast/draft/clear/PR steps into a third body both skills invoke. Rejected — it churns
  `scout`'s working, just-merged procedure to serve a front door that only needs to *reference* it, and
  buys no single-source benefit that referencing `scout` doesn't already give.
- **C — Extend `scout` with an ad-hoc input mode + a passive `AGENTS.md` recognition line:** teach
  `scout` to accept a pasted item directly and add prose so any agent "notices" a handed-over link.
  Rejected — the passive recognition makes ingestion an implicit side effect of conversation
  (eroding the explicit propose/dispose gate), and overloading `scout` with an input mode blurs the
  pull-sweep's contract. An explicit, separately-invoked front door is clearer and safer.

## Consequences

- The baseline ships **ten** Skills; `drop` joins the `REQUIRED_SKILLS` floor in
  `scripts/parity_check.rb` (alongside `ship` and `scout`, not in `LIFECYCLE_SKILLS` — it is not a
  lifecycle stage).
- `scout` now has two documented scopes (full sweep vs. inbox-only). The full-sweep path is unchanged;
  the inbox-only path is what `drop` invokes. Both are covered by the same body, so the stance
  discipline and PR gate stay single-sourced.
- The fabricated-URL near-miss is closed by construction: the front door has no valid path that
  invents or substitutes a URL — a missing permalink stops the flow and asks the human.
- The pipeline now has symmetric doors — `scout` pulls on a schedule, `drop` pushes on demand — while
  keeping one ingestion procedure, one inbox, one Learnings Log, and one propose/dispose gate.
