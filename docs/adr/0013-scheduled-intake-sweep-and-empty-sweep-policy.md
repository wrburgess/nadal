# Scheduled intake sweep: document the trigger, ship no live scheduler; empty sweep is log-only

**Status:** accepted — refined by [ADR 0016](0016-interactive-sequential-disposition-scout.md) (interactive vs scheduled disposition)

## Context

The [Intake Pipeline](0012-intake-pipeline-placement.md) landed the `scout` skill and its
human-gated PR flow. Its final piece (issue #32, part of the #28 umbrella) is running the sweep
**on a cadence without a babysitter**. Two questions needed a recorded answer:

1. **Where does the schedule live?** A scheduler is inherently host- and platform-specific: it names a
   concrete tool (a Claude Code on the web scheduled session, a GitHub Actions `cron` job) and often
   needs a credential. The Config Bundle ships a **Generic Baseline** that "contains no reference to
   any specific company, product, or domain," and *nothing runs unless triggered*.
2. **What happens when a scheduled sweep finds nothing?** Left unspecified, a schedule would open an
   empty PR every cadence, and the `scout` body always appended entries and opened a PR.

## Decision

- **Document the trigger; ship no live scheduler.** The scheduling *mechanism* is host-configured, not
  shipped enabled. A business-neutral guide
  ([`docs/guides/intake-sweep-scheduling.md`](../guides/intake-sweep-scheduling.md)) documents two
  paths — a Claude Code on the web scheduled session, and a copy-pasteable GitHub Actions `cron`
  recipe a host supplies its own credential for — with enable/disable steps and the cadence rationale.
  No workflow file is added to `.github/workflows/`. This mirrors how
  [Layer 1 branch protection](../guides/branch-protection.md) is documented for the host to enable
  rather than applied for it, and extends the "deferred optional CI workflow" precedent already noted
  there.
- **An empty sweep is no-PR, log-only.** When no entry survives the sweep's stance rule, `scout` opens
  **no** PR and does **not** advance the last-swept marker; it records that it swept and found nothing.
  The marker advances **only inside a merged sweep PR**, so an empty window is left intact and the next
  run re-scans it idempotently. This is written into the `scout` skill body (procedure step 6 + quality
  gate) so it holds regardless of how the sweep is triggered.
- **Default cadence: weekly**, tunable per host against the Watchlist's `cadence:` fields. The seeded
  roster skews slow (≈6 high / 11 medium / 10 low), so weekly catches medium/low sources without firing
  near-empty daily.

## Considered options

- **A — Documentation-first (chosen):** a guide documents both scheduling paths (recipe embedded as a
  fenced block), plus the empty-sweep clarification and this ADR. No workflow file ships. Keeps the
  baseline name-free and secret-free while remaining "ready to drop in."
- **B — Ship a dormant `.github/workflows/*.example`:** everything in A plus an inert workflow a host
  renames to enable. Rejected — it places a tool-specific, secret-requiring artifact in the neutral
  baseline tree, and a host that enables it naively (no credential, wrong cadence) gets red runs or
  empty PRs.
- **C — Ship a live, enabled `cron` workflow:** rejected — it needs a live credential, names a specific
  tool in the baseline, and would run a real sweep over *illustrative reference* content that is not the
  baseline's job to keep fresh, contradicting [ADR 0012](0012-intake-pipeline-placement.md).

## Consequences

- The scheduler is upheld by documentation + host action, not by a shipped file; the parity check does
  not (and need not) police `.github/workflows/` for it.
- The empty-sweep and marker-advance-on-merge semantics are now an invariant a reviewer can check
  against the `scout` body, not an implicit assumption.
- A Host App on another platform repoints the schedule by following the guide's pattern for its own
  scheduler; the `scout` body stays untouched.
