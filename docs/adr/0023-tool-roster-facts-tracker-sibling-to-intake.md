# Tool Roster: a facts-and-products tracker as a sibling to the voices intake pipeline

**Status:** accepted

## Context

Issue #83 asks for a low-effort, always-current map of the AI coding landscape along the
two axes this repo turns on — **harnesses** (which carry config) and **models** (which are
declared) — to feed two consumers: the forthcoming **Efficient** value pillar (an AI
collaborator choosing the right tool for the right problem at the right price) and the human
collaborator's own tracking of a fast-moving field. The raw stream is a firehose (harness
versions move ~daily, model versions ~bi-monthly, plus changelogs); the need is its
opposite — a **condensed, decision-relevant digest**.

The obvious move is to reuse the existing [intake pipeline](0012-intake-pipeline-placement.md)
(`scout` / Watchlist / Learnings Log). But there is a **category difference** that drives the
whole design:

| | Intake pipeline | This need |
|---|---|---|
| Watches | **voices** (people who publish) | **products** (tools with version numbers) |
| Captures | opinions/techniques (qualitative) | facts — version, date, price (quantitative) |
| Core field | `stance` (a judgment) | none — a row is simply *true* |
| Shape | dated, append-only **log** | current-state **snapshot**, overwritten in place |
| A new item is | a judgment a human accepts/rejects | a fact a human **verifies** |

A version bump has no `stance`; forcing "Opus → 4.8" into `confirms | challenges | extends |
orthogonal` is a category error. And the two consumers differ: the AI collaborator needs
**dense structured data** to reason over; the human needs a **readable digest of what
changed**, pushed, because they won't pull.

## Decision

Stand up **the Tool Roster** — a curated, version-controlled, current-state snapshot of the
harnesses and models worth weighing for software development — as a **sibling** to the intake
pipeline, not an extension of it. Design:

- **Normalized, not a matrix.** Two entity lists (`harnesses`, `models`), each keyed by
  product **line** with the current version as an *attribute* (so "Opus → 4.8" is one clean
  field edit, not a row swap). The Camp A/B distinction (model-married vs. model-agnostic) is
  a single `house_model` field (`varies` for pickers like Copilot). The "Result = harness ×
  model" pairing truth lives in a **derived view / the AI collaborator's recommendation**, not
  a stored dense grid; the off-house support enum (native / router-degraded / unsupported) is
  deferred to the consuming pillar.
- **YAML canonical; digest rendered on the fly.** One committed YAML file — structured for the
  AI collaborator, browsable by the human — with the human digest rendered into the push / PR
  body at notification time (no committed generated artifact). Every value is trust-typed —
  **vendor-fact**, **benchmark** (carries `source` + `as_of`), or **estimate** (the subjective
  "Dumb Zone", always rendered flagged, never as a vendor figure). Each entry carries a
  `verified` date and real-URL `sources:`; an unconfirmable value **ages** rather than being
  fabricated (the `voices.yml` discipline). A model version bump raises a **stale-estimate
  flag** on estimates written before it.
- **Placement and delivery mirror [ADR 0012](0012-intake-pipeline-placement.md) /
  [ADR 0013](0013-scheduled-intake-sweep-and-empty-sweep-policy.md).** The *mechanism* (schema
  + refresh) is Generic Baseline and name-free; the *populated* Tool Roster is illustrative
  reference under `docs/reference/`. The refresh runs weekday mornings, is **quiet when nothing
  changed**, and pushes **deltas only** (never a rehash); its scheduler and transport (email is
  one option) are **documented, not shipped** — no secret, no live workflow, host-configured.
  The AI-collaborator recommendation skill (the Efficient pillar's consumer) is **out of scope**
  for the initial build — this delivers the pillar's *input*, not the pillar.
- **Roster gated by an inclusion test:** an entry earns a hook only if it *plausibly enters an
  AIC harness+model rotation decision for software development*. In scope: interactive
  terminal/IDE harnesses + frontier and near-frontier models (open-weight included). Out for
  v1: async/autonomous agents (Devin, Jules, Replit) — a schema mismatch (not configured, no
  picked-model pairing). Categories are top-level keys, so a new tier is added without
  restructuring.

## Considered options

- **A — Extend the intake pipeline** (harness/model release pages as Watchlist sources; version
  bumps as Learnings-Log entries). Rejected — it forces stance-less facts into a stance-bearing,
  append-only prose log; the snapshot-vs-append-only shapes conflict and a fact isn't a judgment.
- **B — A dense harness × model pairing matrix** as the primary artifact. Rejected — it
  duplicates each model's facts across every harness row (violating the single-sourcing this repo
  is built on), couples two very different change cadences (harness ~daily, model ~bi-monthly),
  and is mostly empty cells.
- **C — A normalized sibling snapshot (chosen).** Two normalized lists + a `house_model` edge,
  pairing as a derived view. Single-sources every fact, lets each list refresh on its own rhythm,
  and represents Camp A/B and (later) off-house support cleanly.

## Consequences

- Two field-monitoring loops now exist as **siblings**: *voices → Learnings Log* (qualitative,
  stance-bearing, append-only) and *tools → Tool Roster* (quantitative, current-state). `CONTEXT.md`
  gains the **Tool Roster** term.
- The refresh ships as a new baseline Skill — **`restock`**, a sibling to `scout` — joining the
  `REQUIRED_SKILLS` floor with its self-test (the baseline grows to thirteen Skills), mirroring how
  [ADR 0015](0015-intake-front-door-drop-skill.md) / [ADR 0021](0021-voice-watchlist-front-door.md)
  grew the floor.
- The build inherits guardrails already paid for: the refresh/skill body must avoid the parity
  denylist tokens (`docs/rules/`, `.claude/rules/`); links to not-yet-created targets stay
  backticked until they exist; a scheduling guide (à la
  [`intake-sweep-scheduling.md`](../guides/intake-sweep-scheduling.md)) documents the
  weekday-morning trigger, the deltas-only / quiet-when-empty policy, and the host-config
  transport without shipping a workflow or secret. `PROJECT.md` gains a Tool Roster artifact location
  during the build, alongside the intake locations.
- The pairing view and off-house support enum are deliberately deferred; the Efficient pillar
  derives them from the normalized lists rather than reading a stored grid.
- As with the intake pipeline, the parity check does not police any of this (ADRs, `CONTEXT.md`,
  and `docs/reference/` content are unchecked) — the placement holds by convention and review.
