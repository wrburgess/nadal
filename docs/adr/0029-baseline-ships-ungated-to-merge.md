# The baseline ships ungated to merge — plan approval `auto`, merge the sole human gate

**Status:** accepted

Narrowly supersedes the **strict-baseline framing** of
[ADR 0025](0025-human-gate-policy-is-a-project-config-value.md) (the shipped human-gate policy),
[ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md) decision 2 (the
plan-gate summons was "consistent while plan approval is `required`"), and
[ADR 0028](0028-context-reset-boundary-resumable-stops-autonomous-listen.md) decision 8 (which shipped
the `auto` cross **dormant**, "flipped later" by [#116](https://github.com/wrburgess/ai-config/issues/116)).
This ADR is the flip: it moves the shipped **default**, not the mechanism. Every non-default decision in
ADR 0025 / 0026 / 0027 / 0028 stands unmodified — merge stays non-configurable, the parser is unchanged,
the pause-not-terminate loop and autonomous `listen`-under-`ship` are as ADR 0028 enacted them. The old
ADRs are **not edited** — ADRs are immutable here
([ADR 0024](0024-harness-model-naming-convention.md)); their wording stands as the point-in-time record
and the supersession is recorded here, where a reader arriving via their text will find it.

## Context

The bundle shipped its human-gate policy **strict**: plan approval `required`, so a hands-off `/ship`
run stopped and waited for a human at the plan gate on every issue. ADR 0028 built the machinery for an
unattended run — a same-agent context reset across the plan boundary, pause-not-terminate stops, a pure
resume derivation, and autonomous `listen` disposition inside a `ship` run — but shipped it **dormant**:
plan approval still `required`, the `auto` cross never exercised, awaiting a deliberate flip
([#128](https://github.com/wrburgess/ai-config/issues/128)).

The mechanism now exists and is exercised under `required`; leaving the default strict means the bundle
advertises a "hands-off orchestrator" that no host receives without first editing `PROJECT.md`. The
decision is which posture the Generic Baseline should *ship*: strict-by-default (the AC waits at the plan
gate) or ungated-to-merge (the AC drives itself to the one gate a human always owns).

## Decision

1. **The shipped baseline is ungated to merge.** Two Project-Config defaults flip, and **only the
   defaults** — the allowed sets, the parser, and the merge invariant are unchanged:

   | Value | Was (shipped) | Now (shipped) | Allowed values |
   |---|---|---|---|
   | Plan approval (`PROJECT.md` → *Human Gates*) | `required` | **`auto`** | `required` · `auto` |
   | Merge (`PROJECT.md` → *Human Gates*) | `required` | `required` (unchanged) | `required` (not configurable) |
   | Rule-suggestion disposition (`PROJECT.md` → *Human Gates*, documentary) | *(did not exist)* | **`autonomous-fold`** | `autonomous-fold` · `present-to-hc` |

   **Merge is the sole human gate.** It stays `required` and non-configurable everywhere — no host may
   express self-merge, and the parity check hard-fails any other value. A host that wants the plan pause
   back sets *plan approval* to `required`; that path is now the opt-in, not the default.

2. **`final` disposes rule suggestions by the `autonomous-fold` default.** Once a run reaches the merge
   gate on its own, the improvements `final` learns during implementation need a disposition that does
   not silently reintroduce a human pause. Under **`autonomous-fold`**, `final` **folds** well-scoped,
   low-risk Rules-Layer/config improvements into the **same PR a human merges** — so the merge gate stays
   their backstop, never edited into `main` without a human — and **defers** large or contentious ones to
   a tracked follow-up issue, recording **both** in the SOW. The **discretion bar**: *well-scoped **and**
   low-risk → fold; large **or** contentious → defer.* Under **`present-to-hc`** (the opt-in) `final`
   presents and waits, editing nothing without approval — the pre-ungated behavior. This value is
   **documentary** prose, not a gate-table row: the `human_gates.rb` parser reads a two-row table and
   must stay two-row, so the disposition is authored as a `### Rule-suggestion disposition` subsection a
   host edits directly. It governs only `final`'s rule-suggestion step and does **not** touch the
   intake/authoring "a human disposes" gates (`scout` / `clip` / `follow` / `restock` / `create-skill`).

3. **The parser fail-safe stays strict; only the shipped file flips.** `HumanGates::DEFAULTS` in
   `scripts/human_gates.rb` still returns `{ plan_approval: "required", merge: "required" }` when the
   `## Human Gates` section is **absent**. That default protects an already-vendored Host App whose
   `PROJECT.md` predates the section: it keeps parsing to the strict policy and is unaffected by this
   flip. The new default lives in the **shipped `PROJECT.md`'s authored table**, which declares
   `auto` — a host that re-syncs and adopts the new file gets the ungated posture; a host that keeps its
   older section-less file does not silently change behavior. Flipping the parser default instead would
   reach into vendored hosts that never opted in, the exact fail-open ADR 0025 built the fail-safe to
   prevent.

## Considered options

- **A — flip the parser `DEFAULTS` too, so absent-section hosts also go ungated.** Rejected: an additive
  section's whole contract (ADR 0025) is that a host predating it is unaffected. Flipping the parser
  default would silently move every section-less vendored host to `auto` — a gate change nobody
  authored, in the unsafe direction.
- **B — a `present-to-hc` default for rule suggestions.** Rejected as the *default*: it reintroduces a
  human pause into the run the flip exists to make hands-off, and the merge gate already backstops a
  folded change (a human reads and merges the same PR). It remains available as the opt-in for a host
  that wants every rule edit reviewed separately.
- **C — fold everything, defer nothing.** Rejected: a large or contentious Rules-Layer change riding in a
  feature PR buries a real judgment call under the feature's own review. The discretion bar keeps the
  merge-gate backstop meaningful — small and low-risk rides along; large or contentious earns its own
  issue and its own review.
- **D — flip only the shipped `PROJECT.md`, keep the parser strict, add `autonomous-fold`, defer the
  residual risks (chosen).** Ships the intended posture, changes no already-vendored host, and keeps
  merge the one human gate.

## Consequences

- **Out of the box, `/ship {issue}` drives to the merge gate without a human at the plan gate.** The
  assessment and plan are still posted (under `auto` they are the sole audit trail), and the plan
  boundary still forces its context reset — `auto` waives the *wait*, never the firebreak (ADR 0028
  decision 1).
- **The living docs now say "ungated to merge / plan approval `auto`" while ADR 0025 / 0026 / 0028 still
  say "strict" / "`required`" / "dormant."** This is a supersession chain, not a contradiction — the same
  shape ADR 0027 and ADR 0028 already left. A reader arriving at an old ADR's text follows it forward to
  here.
- **Deferred residual risk — tracked in [#129](https://github.com/wrburgess/ai-config/issues/129).**
  Flipping the default makes live three gaps ADR 0028 could leave dormant while `auto` was unused:
  - **The plan-gate Reviewer summons is unowned under `auto`.** ADR 0026 decision 2 and ADR 0027
    decision 6 left the plan-gate summons without an owner *or* a mechanism, on the reasoning that a
    human stood at the `required` gate. Under the shipped `auto` nobody stands there, so the plan gets
    **no** independent review before code is written. The PR-gate backstop (`verify` owns it) is
    unaffected; the plan-gate one needs an owner and a non-PR summons mechanism.
  - **A folded rule/config change gets no independent review of its own.** It rides the feature PR's
    review and the merge gate; a Reviewer looking at the feature may not scrutinize a bundled convention
    edit. The discretion bar (defer large/contentious) narrows this, but does not close it.
  - **`ai-config-sync` reseed.** ADR 0028 decision 8 paired the flip with the sync reseed that lets a
    re-syncing host pick up the new default deliberately; that reconciliation guidance is already in
    [`docs/guides/usage.md`](../guides/usage.md) → *Update / re-sync* and is exercised here.
- **Nothing a section-less vendored host runs changes.** The parser still hands it the strict policy; the
  flip is visible only to a host that adopts the new shipped `PROJECT.md`.
- **Known limit — reference, not semantics.** Parity verifies the gate/reviewer references survive the
  rewrites and that the shipped `PROJECT.md` parses to `plan_approval: auto, merge: required`; it cannot
  verify that the reframed prose *agrees* across ~15 files. That is the
  [ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md) boundary — upheld here by the skill
  bodies, the `human_gates_test.rb` data-contract assertions (which now guard the merge floor while
  plan-approval is `auto`), the implementing PR's contradiction sweep, and human review.
