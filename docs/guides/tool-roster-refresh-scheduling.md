# Scheduling the Tool Roster refresh

The [`restock`](../../skills/restock/SKILL.md) skill runs one **Tool Roster refresh**: it re-verifies each
tracked harness/model entry's facts against that entry's own `sources:`, applies only the real
field-level deltas (reconfirm-or-age, never fabricate), and opens a **deltas-only pull request** for a
human to review. This guide covers running that refresh **on a cadence, without a babysitter** — the
sibling of the [intake-sweep scheduling](intake-sweep-scheduling.md) guide, and the same
documented-not-shipped stance ([ADR 0023](../adr/0023-tool-roster-facts-tracker-sibling-to-intake.md),
[ADR 0013](../adr/0013-scheduled-intake-sweep-and-empty-sweep-policy.md)).

Everything here is **host-configured**. The `restock` skill body is business-neutral and names no
schedule, no transport, and no product; a Host App wires the cadence in its own environment using one of
the two paths below. Nothing in this guide ships a live, enabled scheduler or a credential — the same
stance the bundle takes with the intake sweep and with
[Layer 1 branch protection](branch-protection.md#layer-1--github-server-side-branch-protection).

## Two ways to drive it

- **Manually** — invoke `/restock` (Claude) or follow the skill's documented procedure (Codex, Copilot,
  Antigravity, Grok Build) whenever you want a refresh. This needs no setup.
- **On a schedule** — a recurring job invokes the *same* skill on a cadence and files the review PR for
  you. The refresh runs the identical **re-verify-and-reconcile** procedure either way; the one
  difference is disposition — an interactive run may walk the deltas first, a scheduled run opens the PR
  for **asynchronous** disposition.

The output is always a **review PR, never an auto-merge**: `restock` proposes the deltas, a human
disposes.

## Scheduling path 1 — Claude Code on the web scheduled session

1. Create a scheduled/recurring session against this repository.
2. Set its prompt to a single instruction: **`/restock`**.
3. Set the cadence (see [Cadence rationale](#cadence-rationale) — **weekday mornings** is the default).
4. Save it.

Each firing opens a session, runs the refresh, and — when a fact has changed — pushes a feature branch
and opens the deltas-only review PR under the repo's
[Branch & PR Policy](../../PROJECT.md#branch--pr-policy). When nothing changed it is
[quiet](#empty-refresh-behavior) and opens no PR. No secret is required beyond the session's own
repository access.

## Scheduling path 2 — GitHub Actions `cron` recipe

A **host-supplied, opt-in** recipe — intentionally *not* shipped as a live workflow (it would name a
specific tool and need a host secret, which the Generic Baseline does not assume;
[ADR 0013](../adr/0013-scheduled-intake-sweep-and-empty-sweep-policy.md)). Copy it into
`.github/workflows/`, supply your own credentials, and tune the cadence:

```yaml
name: tool-roster-refresh
on:
  schedule:
    - cron: "0 13 * * 1-5"   # weekday mornings (13:00 UTC ~ 9am US-Eastern) — tune to your timezone
  workflow_dispatch: {}       # allow a manual run too

permissions:
  contents: write             # push the refresh branch
  pull-requests: write        # open the review PR

jobs:
  restock:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Run the agent your host uses with a tool-neutral instruction — "read and follow
      # skills/restock/SKILL.md and run one refresh". On Claude that is the /restock shim;
      # Codex/Copilot/Antigravity/Grok Build reach the same body via native AGENTS.md discovery.
      # Supply the agent's credential as a repository secret (e.g. an API key);
      # the Generic Baseline names no specific tool or secret here.
      # The step must open a REVIEW PR — never merge. Branch protection (Layers 1-3)
      # is the backstop that keeps a direct push to a protected branch from landing.
```

Whatever agent the step invokes, two invariants hold: it runs the **same skill** — via the `/restock`
shim on Claude, or by reading and following `skills/restock/SKILL.md` on the native-discovery tools
(Codex, Copilot, Antigravity, Grok Build) — and it opens a **review PR**, never an auto-merge.

## Notifying the maintainer — the push transport

The refresh's value to a human is a **push**: the maintainer wants to *see what changed* without having
to pull the file. `restock` already renders a **deltas-only digest** as the PR body — so the change
summary exists as a byproduct, and the committed snapshot (plus its git diff) is the full record.

Delivering that digest as a push (email, chat, or another channel) is **host-configured and
documented-not-shipped**, the same stance as the scheduler: the Generic Baseline wires no transport and
holds no credential or recipient. A host that wants email, for example, adds a step to its scheduled job
that sends the PR body (or the diff) to its maintainer. The push *notifies*; it never bypasses the human
gate — the review PR remains the source of truth and the merge still happens there.

## Cadence rationale

**Default: weekday mornings (Mon–Fri).** Harness versions move fast (roughly daily) and model versions
more slowly (roughly bi-monthly), but the Tool Roster is a **condensed current-state snapshot**, not a
changelog — so the goal is a prompt, digestible "here's what moved" on business mornings, not capturing
every intermediate bump. Paired with [quiet-when-empty](#empty-refresh-behavior), most mornings are
silent; you hear from it only when a fact actually changed.

A Host App tunes this against its own Tool Roster: a board weighted toward fast-moving harnesses can justify
every weekday; one that tracks only slow-moving models can drop to weekly. Weekends are skipped by
default (`1-5`) because releases rarely land then.

## Empty-refresh behavior

A refresh where **no** tracked fact changed is a valid, expected result — most mornings, in fact. When
nothing moved:

- **No PR is opened.** An empty PR is noise; the refresh stays quiet.
- **Nothing is committed** — not even a `verified` bump. The board is left exactly as it was, so the next
  run re-checks the same entries; an entry whose facts drift between runs is not skipped.
- **The run is log-only.** A scheduled session records that it refreshed and found nothing, then exits
  clean.

This is enforced in the [`restock` skill body](../../skills/restock/SKILL.md) itself (procedure step 5
and the quality gate), so it holds no matter how the refresh is triggered.

## Enable / disable

| Path | Enable | Disable |
|------|--------|---------|
| Claude Code on the web scheduled session | Create the recurring session with prompt `/restock` | Delete or pause the scheduled session |
| GitHub Actions `cron` | Add the workflow above to `.github/workflows/` and set the repo secret | Delete the workflow file, or comment out its `schedule:` block (a `workflow_dispatch`-only workflow never fires on its own) |

Turning the schedule off never removes the ability to run it by hand — `/restock` is always available
manually.
