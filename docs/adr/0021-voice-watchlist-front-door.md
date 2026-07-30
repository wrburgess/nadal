# Roster front door: a `voice` skill that adds or updates a Watchlist voice from a handle or link

> Note (#73): the `/voice` skill was renamed to `/follow`.

**Status:** accepted

## Context

The [Intake Pipeline](0012-intake-pipeline-placement.md) has two doors onto the **Learnings Log** —
[`scout`](../../skills/scout/SKILL.md) pulls field output on a sweep, and
[`drop`](0015-intake-front-door-drop-skill.md) pushes a human-handed item on demand. Both ingest
*field output* and assign it a `stance`. Neither owns the **Watchlist roster itself**
(`docs/reference/voices.yml`) — *who* the sweep watches. Adding or maintaining a roster entry was an
unowned, ad-hoc edit.

The gap surfaced from a real drop this cycle: `Add voice https://twitter.com/karpathy`. In a
zero-context session it was ambiguous — "voice" is repo jargon for a Watchlist entry, but nothing told
the agent that — and it invited two failure modes. First, with no context the agent couldn't map a
bare handle to "add/update the roster." Second, and worse, Andrej Karpathy was **already** on the
Watchlist as `x: https://x.com/karpathy` — the same account as the pasted `twitter.com/karpathy`. A
naive "add" appends a duplicate, because the roster's data test (`test/voices_watchlist_test.rb`)
asserts *structure*, never *uniqueness* — nothing downstream catches a second entry for the same
person. The correct move — recognize the existing account and offer to refresh it — had no skill to
encode it.

The roster also carries invariants a hand-edit easily violates: `tier`/`status`/`cadence` must stay
within their documented sets; every present handle and every listed feed must be a **real URL**; an
unresolved feed stays `[]` and is **never** invented; and the prose companion
(`docs/reference/ai-engineering-voices.md`) is kept in parity by
`test/voices_roster_parity_test.rb`, so a new name that isn't mirrored there reddens CI.

## Decision

Ship a thin **`voice`** skill — the intake pipeline's **roster front door** — that turns a bare handle
or a link into the correct, deterministic Watchlist action: **add a new voice, or update the existing
one.** It normalizes the input, **dedups against the existing entries first**, assembles a schema-valid
add-or-update honoring the real-URL discipline, keeps the prose companion in parity, and opens a review
PR; a human **disposes on the PR**.

- **Roster, not learnings — the boundary that justifies a separate skill.** `voice` maintains the
  **Watchlist roster** (`voices.yml` + its prose parity), a different artifact from the Learnings Log,
  with a different schema and **no `stance`**. `scout`/`drop` answer "what did this source say, and how
  does it bear on us?" (a stance); `voice` answers "who do we watch, and is this account already on the
  list?" (a roster edit). Because the artifacts and their schemas differ, `voice` does not compose,
  restate, or invoke `scout`/`drop` — it neither touches the Learnings Log nor the manual-drop inbox.
  Keeping the boundary crisp is what stops the roster front door from becoming a second learnings path.
- **Dedup-first is the load-bearing rule.** `voice` resolves the input against **every existing entry's
  handles** (not just names) before proposing. Normalization makes the match reliable: a platform's
  equivalent/alternate domains fold together (`twitter.com` ↔ `x.com`), an at-handle and its full
  profile URL fold together (`@karpathy` ↔ `https://x.com/karpathy`), and trailing-slash/case/`www.`
  variants are stripped. A match yields an **update** (bump `verified`, fill an empty handle, adjust
  `focus`/`tier`/`cadence`); no match yields a **new entry**. Since the data test enforces no
  uniqueness, this dedup is the skill's own responsibility, done deliberately at the front door — the
  Karpathy duplicate is closed by construction.
- **The real-URL discipline is honored, not re-argued.** Every recorded handle and listed feed is a
  **real URL**; an unresolved handle stays absent (`null`), an unresolved feed stays `[]` — never a
  placeholder string, never a fabricated URL. This is the same "never invent a URL" gate the Watchlist,
  the Learnings Log, and the manual-drop inbox already state
  ([ADR 0014](0014-manual-drop-inbox-for-unfetchable-sources.md)) and that `drop` made first-class
  ([ADR 0015](0015-intake-front-door-drop-skill.md)); `voice` applies it to roster fields. Feeds are an
  optimization, not a requirement — an X-only voice legitimately keeps `feeds: []`.
- **Prose parity is green by construction.** A **new** name is mirrored into the prose companion in the
  **same PR** so `test/voices_roster_parity_test.rb` stays green without a human hand-edit; an update
  touching only machine fields needs no prose change. `voice` reads both the Watchlist and its companion
  locations from `PROJECT.md` → *Intake Pipeline*, hardcoding neither.
- **Explicit-command-only, propose/dispose.** Like `drop`, `voice` is invoked deliberately (`/voice`,
  or the documented "read and follow the body" path on native-discovery tools) — **no passive
  `AGENTS.md` recognition line** auto-triggers a roster edit. It **proposes** via PR and **never commits
  the roster directly**; an input already tracked with nothing to change yields an **"already tracked"
  report**, not an empty PR.
- **Business-neutral body.** The Watchlist is an *illustrative reference*, not part of the Generic
  Baseline guarantee, and `voices.yml`'s specific tiers/handles are host content. The `voice` **body**
  therefore names no platform proper noun or hardcoded path — it references the Watchlist's *documented
  schema and invariants* and resolves locations from `PROJECT.md`. The concrete `twitter.com`/`x.com`
  and Karpathy examples live here, in this ADR under `docs/`, where host-named illustration belongs.
- **Graceful degradation ([ADR 0003](0003-skills-canonical-body-thin-shims-graceful-degradation.md)):**
  a tool with sub-agents offloads the handle/feed discovery; a tool without them runs it inline. The
  mechanism degrades; the normalization, the real-URL discipline, the dedup, and the human-disposes gate
  never do.

## Considered options

- **A — Thin `voice` roster front door, auto-detecting add-or-update (chosen):** one command that
  normalizes, dedups against existing handles, and proposes an add *or* an update accordingly, keeping
  prose parity green in the same PR. Directly kills the duplicate failure mode, satisfies the
  "one invocation → a reviewable, green PR" bar, and matches the `drop` front-door idiom and the
  `rules/skills.md` single-source contract.
- **B — `voices.yml`-only front door, human completes the prose:** edit the roster and stop, leaving
  the human to mirror the prose entry. Rejected — for a *new* voice the PR cannot go green on its own
  (roster-parity reddens), pushing mechanical work onto the human and shipping a red PR by design,
  which weakens exactly the property the skill exists to guarantee.
- **C — Explicit `voice add` / `voice update` sub-modes:** make the human declare intent up front.
  Rejected — it reintroduces the Karpathy duplicate risk the skill exists to prevent (a human typing
  `voice add` on an already-tracked account), unless the skill *still* dedups, at which point
  auto-detect (A) is strictly better for no added safety.
- **D — Extend `scout`/`drop` with a roster mode:** teach a learnings-intake skill to also edit the
  roster. Rejected — it blurs the roster-vs-learnings boundary, forces a `stance`-shaped procedure onto
  an artifact that has no stance, and overloads a body whose contract is field-output ingestion.

## Consequences

- The baseline ships **twelve** Skills; `voice` joins the `REQUIRED_SKILLS` floor in
  `scripts/parity_check.rb` (alongside `ship`, `scout`, `drop`, and `create-skill` — **not** in
  `LIFECYCLE_SKILLS`, since it is not a lifecycle stage) with a matching self-test in
  `test/parity_check_test.rb`.
- The intake pipeline now has **three** doors with a crisp division: `scout` pulls field output on a
  schedule and `drop` pushes it on demand — both onto the Learnings Log with a `stance` — while `voice`
  maintains the roster those two watch, on `voices.yml` with no stance. One artifact per door, one
  propose/dispose gate across all three.
- The duplicate-entry failure mode is closed by construction: the front door has no path that appends a
  second entry for an already-tracked account, because dedup precedes the add/update decision.
- A `voice`-authored PR is a two-file edit for a new voice (roster + prose companion) and a one-file
  edit for a machine-field update, keeping `test/voices_watchlist_test.rb` and
  `test/voices_roster_parity_test.rb` green by construction.
