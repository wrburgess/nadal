# Scheduling the intake sweep

The [`scout`](../../skills/scout/SKILL.md) skill runs one **intake sweep**: it polls the Watchlist,
drafts dated Learnings-Log entries (each carrying a `stance` and a `touches` target), and opens a
**pull request** for a human to accept, edit, or reject. This guide covers the *last* piece of the
[Intake Pipeline](../../CONTEXT.md) ([ADR 0012](../adr/0012-intake-pipeline-placement.md),
[ADR 0013](../adr/0013-scheduled-intake-sweep-and-empty-sweep-policy.md)): running that sweep
**on a cadence, without a babysitter**, while keeping the human gate.

Everything here is **host-configured**. The `scout` skill body is business-neutral and names no
schedule; a Host App wires the cadence in its own environment using one of the two paths below and
tunes it against its Watchlist. Nothing in this guide ships a live, enabled scheduler — the same
stance the bundle takes with [Layer 1 branch protection](branch-protection.md#layer-1--github-server-side-branch-protection),
which is documented for the host to enable, not applied for it.

## Two ways to drive it

- **Manually** — invoke `/scout` (Claude) or follow the skill's documented procedure (Codex, Copilot,
  Antigravity, Grok Build) whenever you want a sweep. This needs no setup.
- **On a schedule** — a recurring job invokes the *same* skill on a cadence and files the review PR
  for you. That is what this guide sets up. The sweep runs the identical **discovery-and-drafting**
  procedure either way — there is no scheduled-only fast path. The one legitimate difference is
  **disposition**: an interactive run walks each finding one at a time before opening the PR, while a
  scheduled run (no human present) opens the PR for **asynchronous** disposition
  ([ADR 0016](../adr/0016-interactive-sequential-disposition-scout.md)).

The output is always a **review PR, never an auto-merge**: the sweep proposes, a human disposes.

## Scheduling path 1 — Claude Code on the web scheduled session

The most direct path on Claude Code on the web: a **scheduled session** that opens on a cadence and
runs the sweep as its prompt.

1. Create a scheduled/recurring session against this repository.
2. Set its prompt to a single instruction: **`/scout`**.
3. Set the cadence (see [Cadence rationale](#cadence-rationale) below — **weekly** is the default).
4. Save it.

Each firing opens a session, runs the sweep, and — when there is new material — pushes a feature
branch and opens the review PR under the repo's [Branch & PR Policy](../../PROJECT.md#branch--pr-policy).
When there is nothing new, it is [log-only](#empty-sweep-behavior) and opens no PR. No secret is
required beyond the session's own repository access.

## Scheduling path 2 — GitHub Actions `cron` recipe

For a host that prefers CI-driven scheduling, a GitHub Actions workflow on a `cron` schedule can
invoke the sweep. This is a **host-supplied, opt-in** recipe — it is intentionally *not* shipped as a
live workflow in this bundle (it would name a specific tool and require a host secret, which the
Generic Baseline does not assume; see [ADR 0013](../adr/0013-scheduled-intake-sweep-and-empty-sweep-policy.md)).
Copy it into `.github/workflows/`, supply your own credentials, and tune the cadence:

```yaml
name: intake-sweep
on:
  schedule:
    - cron: "0 13 * * 1"   # Mondays 13:00 UTC — weekly; tune to your Watchlist
  workflow_dispatch: {}      # allow a manual run too

permissions:
  contents: write            # push the sweep branch
  pull-requests: write       # open the review PR

jobs:
  scout:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Run the agent your host uses with a tool-neutral instruction — "read and follow
      # skills/scout/SKILL.md and run one sweep". On Claude that is the /scout shim;
      # Codex/Copilot/Antigravity/Grok Build reach the same body via native AGENTS.md discovery.
      # Supply the agent's credential as a repository secret (e.g. an API key);
      # the Generic Baseline names no specific tool or secret here.
      # The step must open a REVIEW PR — never merge. Branch protection (Layers 1-3)
      # is the backstop that keeps a direct push to a protected branch from landing.
```

Whatever agent the step invokes, two invariants hold: it runs the **same skill** — via the `/scout`
shim on Claude, or by reading and following `skills/scout/SKILL.md` on the native-discovery tools
(Codex, Copilot, Antigravity, Grok Build) — and it opens a **review PR**, never an auto-merge. Enabling auto-merge
here would violate the two-gate philosophy and is out of scope.

## Cadence rationale

**Default: weekly.** The cadence should track the Watchlist's own `cadence:` fields
([`docs/reference/voices.yml`](../reference/voices.yml)). The seeded roster skews toward slower
publishers — roughly **6 `high` / 11 `medium` / 10 `low`** — so a weekly window comfortably catches
`medium`- and `low`-cadence sources without firing near-empty every day. A daily schedule against this
distribution would spend most runs producing an empty sweep; a monthly one risks missing time-sensitive
`high`-cadence output. Weekly sits between.

A Host App tunes this against **its** Watchlist: raise the frequency if you add many `high`-cadence
sources, lower it if the roster is mostly `low`. The `cadence:` field per source is the input to that
decision — not a global guess.

## Empty-sweep behavior

A sweep that finds **no** new material is a valid, expected result — especially for `low`-cadence
sources, and especially early while many `feeds:` are still unresolved. When no entry survives the
sweep's stance rule:

- **No PR is opened.** An empty PR is noise; the sweep stays quiet.
- **The last-swept marker is not advanced.** The marker (`**Last swept:**` in
  [`docs/reference/learnings/index.md`](../reference/learnings/index.md)) advances **only inside a
  merged sweep PR**. An empty sweep leaves the window intact, so the next run re-scans the same window
  idempotently — a source that publishes between runs is not skipped.
- **The run is log-only.** A scheduled session records that it swept and found nothing, then exits
  clean.

This is enforced in the [`scout` skill body](../../skills/scout/SKILL.md) itself (procedure step 6 and
the quality gate), so it holds no matter how the sweep is triggered.

## Enable / disable

| Path | Enable | Disable |
|------|--------|---------|
| Claude Code on the web scheduled session | Create the recurring session with prompt `/scout` | Delete or pause the scheduled session |
| GitHub Actions `cron` | Add the workflow above to `.github/workflows/` and set the repo secret | Delete the workflow file, or comment out its `schedule:` block (a `workflow_dispatch`-only workflow never fires on its own) |

Turning the sweep off never removes the ability to run it by hand — `/scout` is always available
manually.
