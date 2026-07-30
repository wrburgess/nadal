# The Codex summons is the local CLI runtime, and its ready probe is the first shipped Check

**Status:** accepted

Narrowly supersedes [ADR 0027](0027-reviewer-chain-validated-against-invocation-paths.md) decision 4
("the precondition *Check* is optional and host-supplied") **for the Codex row only** — that row now
declares an executable Check the baseline itself ships. Everything else stands unmodified: ADR 0027
decisions 1–3 and 5–8 (including decision 7's harness-only *Primary* and decision 8's exact matching),
the `stop-and-ask` floor ([ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
decision 3), [`verify`](../../skills/verify/SKILL.md)'s sole ownership of the PR-gate summons
(ADR 0026 decision 2), and the bounded window for asynchronous entries. ADRs are immutable here
([ADR 0024](0024-harness-model-naming-convention.md)), so ADR 0026 decision 4's and ADR 0027
decision 6's citations of the `@codex review` mention are **not edited** — they remain accurate
statements about the file as it stood when those ADRs were written.

## Context

The HC decision of 2026-07-28 on [#151](https://github.com/wrburgess/ace/issues/151) aligns the
shipped Reviewer declaration with how this repo's backstop review **actually runs**. The Codex row in
`PROJECT.md` → *Invocation paths* read "mention `@codex review` on the PR" — the GitHub App mechanism
that failed silently in [#99](https://github.com/wrburgess/ai-config/issues/99) and that this repo
does not use. The real route, HC-confirmed repeatedly in field use, is the **local Codex CLI
runtime**: the review runs **synchronously against the checked-out PR head**, so the reviewed SHA
binds by construction, and the runtime's ready probe can run *before* summoning with no side
effect — the one thing ADR 0026 decision 4 wanted and ADR 0027 decision 4 recorded the baseline
could not then deliver.

The declaration and the practice had therefore swapped honesty: the ADRs correctly described a
shipped row that no longer described reality. Two further field facts belong in the record because
the procedure has to absorb them: a synchronous CLI reviewer's response arrives as **returned
output**, not on any PR surface — so unrelayed it would be invisible to the three-surface response
definition of ADR 0026 decision 5 and to [`listen`](../../skills/listen/SKILL.md)'s fetch — and a
first invocation can return **empty output while the ready probe passes**, a known runtime flake
that a single retry resolves.

## Decision

1. **The shipped Codex row names this repo's real mechanism.** Its *Summons* cell reads: run the
   review synchronously through the **local Codex CLI runtime** against the **checked-out PR head**
   (the reviewed SHA binds by construction). This is **mechanism-shape wording, not a machine path**:
   no plugin filesystem path and no machine-local command string appears in the machine-read cell —
   concrete command strings live in [`docs/guides/usage.md`](../guides/usage.md) as guidance. The
   hosts-replace framing is unchanged: the row is this repo's real value that a Host App overwrites
   during Customization, the same real-host-values-in-the-seed precedent as `PROJECT.md` → *Quality
   Checks* (this repo's actual parity commands) and *Attribution & Model Declaration* (this repo's
   actual model declarations). The blast radius is bounded to **fresh vendorings** by construction:
   `bin/ace-sync` preserves an existing host's `PROJECT.md` on re-sync
   ([ADR 0001](0001-distribute-as-copy-in-sync-script.md)), so no vendored host inherits this row.

2. **The Check becomes the first genuinely executable one the baseline ships** — the runtime's
   ready probe, side-effect-free and run before summoning. The Check-cell **semantics are
   unchanged**: Declared → run it before summoning, unmet falls back immediately; Absent → the
   summons is the probe, with the `precondition unverified` qualifier riding on the terminal outcome.
   Only which branch the Codex row takes changes. The Copilot Check stays host-supplied, because that
   check *is* the summons and cannot precede one without a side effect — the half of ADR 0027
   decision 4 that remains fully in force.

3. **The relay convention and the once-retry are the response-model bridge.** A synchronous CLI
   reviewer returns its review as output; the summoner (`verify`, the summons's sole owner) **posts
   that output onto a PR surface** — an issue-level PR comment carrying the reviewer's harness/model,
   the reviewed SHA, and the findings. The relay is what keeps ADR 0026 decision 5's three response
   surfaces, `listen`'s thread fetch, and `final`'s durable review-evidence record intact without
   modification. And a first invocation returning empty output while the ready probe passes is
   retried **once** before any outcome is recorded, so a known flake is not laundered into
   `unreachable`.

4. **Standing untouched, enumerated:** ADR 0027 decisions 7 and 8 (harness-only *Primary*; exact,
   markdown-aware membership matching); the non-configurable `stop-and-ask` floor; `verify`'s sole
   ownership of the PR-gate summons; the bounded window and artifact-derived reviewed SHA for
   **asynchronous** entries (the window still governs the Copilot row and any async host row — a
   synchronous run simply completes inside it); and the plan gate's double hole (no owner, no
   mechanism — ADR 0027 decision 6), which this change does not narrow: the CLI reviews a checked-out
   implementation diff, so both shipped mechanisms remain PR-gate-only and the
   [#129](https://github.com/wrburgess/ace/issues/129) residual is unchanged.

## Considered options

- **A — keep the `@codex review` mention row.** Rejected: it documents a mechanism this repo does not
  use and whose silent failure is the founding defect of the whole Reviewer section (#99). A seed
  whose one worked example is fictional teaches hosts to author fiction.
- **B — put the concrete command string in the Summons/Check cells.** Rejected: machine-read cells
  stay mechanism-shape and ASCII; a machine-local command string in the seed would rot silently and
  invite hosts to treat the cell as executable. Command strings belong in the usage guide, phrased as
  this repo's example.
- **C — teach `scripts/reviewer.rb` or the parity check to verify the mechanism.** Rejected: whether
  a runtime is installed is a runtime fact, outside the structural boundary
  ([ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)); no parser changes ship with
  this decision, and the chain values (`Codex`, `Copilot`, `30m`, `stop-and-ask`) are untouched.
- **D — host-honest row, executable ready probe as the Check, relay + once-retry conventions in
  `verify` (chosen).** The declaration matches practice, the procedure absorbs the synchronous
  response model, and drift guards pin both files to the same route.

## Consequences

- **The seed is honest again** — the one shipped summons mechanism is one that has actually produced
  reviews in this repo, and the first executable Check the baseline has ever shipped runs before the
  summons instead of being implied by prose.
- **Two new drift guards** in `test/reviewer_test.rb`: the Codex row must declare the ready probe
  while the Copilot row stays host-supplied, and the literal "checked-out PR head" must appear in
  both `PROJECT.md` and `skills/verify/SKILL.md` — retiring `verify`'s previously dangling "baseline
  CLI route" forward reference in both directions.
- **Vendored hosts see nothing change** until a deliberate reset: `PROJECT.md` is preserved on
  re-sync, so only fresh vendorings receive the new row, and they replace it during Customization
  like any other host value.
- **Known limit — the relay is procedure, not enforcement.** Nothing machine-checks that a
  synchronous review was posted to a PR surface; an unrelayed review leaves no durable evidence and
  `final` must refuse to infer one from findings alone. This sits on the same
  [ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md) boundary as the rest of the
  procedure text.
