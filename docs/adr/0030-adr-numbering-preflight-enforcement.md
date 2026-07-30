# Enforce ADR-numbering discipline in existing surfaces, not a new pre-flight script

**Status:** accepted

## Context

ADR numbers are a **remote-authoritative** namespace: the next free number is a property of the
remote's **default branch**, not of any one branch. An author who scans a stale local checkout — or
reserves a number ahead of writing the ADR — collides with whatever a parallel branch merged first,
leaving the `docs/adr/` sequence with a **gap** or a **duplicate**. This has bitten the repo before:
computing the next number from a feature branch rather than the remote's default branch
([#131](https://github.com/wrburgess/ai-config/issues/131)), which the parity check then missed. Issue
[#133](https://github.com/wrburgess/ai-config/issues/133) asks for the discipline to be **enforced**
rather than remembered.

The structural parity check ([ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)) already
walks the bundle and hard-fails on drift, but it had no notion of the ADR sequence, so a gap or a
duplicate shipped green. The question this ADR settles is *where* the enforcement should live.

## Decision

Enforce the discipline in surfaces that already ship, at three complementary layers, and add no new
standalone script:

1. **Detective — a parity-check assertion.** `check_adr_numbering` in `scripts/parity_check.rb` parses
   the leading number of every file in `docs/adr/` and hard-fails on a duplicate or a gap in the
   `min..max` run. It is presence-gated on `docs/adr/`, so a minimal or partially-vendored bundle is
   unaffected — the same gate stance as the other `check_*` methods. A mis-numbered ADR is now a red
   gate on the PR that introduces it, not a latent inconsistency discovered later.

2. **Preventive — a skill-body step.** `skills/distill/ADR-FORMAT.md` now instructs the author to
   compute the next number from the remote's default branch (fetch it, list the ADRs there, take the
   highest, add one) and never to reserve a number ahead of authoring. This closes the gap *before* it is
   written, where the detective check would only catch it afterward.

3. **Guidance — a Lean-Core anti-pattern.** `rules/self-review.md` gains one always-resident
   anti-pattern generalizing the rule to every remote-authoritative namespace (ADR numbers, issue
   numbers, the default branch's commit graph): sync-before-create, search-before-file,
   fetch-before-rebase — the two-tier Rules Layer of
   [ADR 0004](0004-two-tier-rules-layer-progressive-context.md).

**Rejected: a new standalone bash pre-flight script.** A `bin/adr-preflight` or a pre-commit hook that
recomputed the next number would be a fourth place the numbering rule lives, and it helps only an author
who remembers to run it — whereas folding enforcement into the checks and bodies that already ship makes
it unconditional. The detective assertion rides the existing parity gate: no new executable, no new hook,
nothing new to install or keep green. This is consistent with
[#127](https://github.com/wrburgess/ai-config/issues/127), whose aim is to shrink the bundle's
*forced-runtime* footprint (remove Ruby, target bash) — **not** to ban scripts: the assertion adds no new
runtime or tool of its own, and it ports with the parity check if and when #127 acts.

## Considered options

- **A — a standalone `bin/adr-preflight` script (or pre-commit hook).** Rejected: it adds a fourth place
  the numbering rule lives, introduces a new executable/runtime surface the bundle would force on hosts
  (cutting against #127's goal of a smaller forced-runtime footprint), and helps only an author who
  remembers to run it — whereas the detective parity assertion is unconditional on every PR.
- **B — only the preventive skill-body step.** Rejected: guidance a body *reads* is not a gate; a run
  that skips or misreads it still ships a gap. Prose without a check is the green-but-blind gap this repo
  has closed before.
- **C — only the detective parity assertion.** Rejected as insufficient alone: it catches the collision
  but teaches nothing about avoiding it, and fires late (at the gate) rather than at authoring time.
- **D — enforce across the three existing surfaces, add no script (chosen).** Detective + preventive +
  guidance, each in a surface that already ships, and no new executable to install.

## Consequences

- A duplicate or gap in `docs/adr/` now reddens `ruby scripts/parity_check.rb`, so it cannot merge.
- The live sequence (`0001`..`0030`, this ADR included) is contiguous and unique, which the assertion
  verifies on every run.
- **Known limit — reference, not intent.** The check proves the *sequence* is well-formed; it cannot
  prove an author computed the number from the remote's default branch rather than getting lucky with a
  stale local scan. That habit is carried by the skill-body step and the Lean-Core anti-pattern, and
  re-verified by human review — the [ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)
  boundary.
