# Usage & Customization Guide

How a **Host App** adopts this Config Bundle end to end: **vendor** the Generic Baseline in,
**activate** the guardrails, **customize** through the Project Config, and **run** the development
lifecycle from any of the five configured agents (Claude, Codex, Copilot, Antigravity, Grok Build).

- Vocabulary (Config Bundle, Generic Baseline, Adapter, Skill, Project Config, Customization…) →
  [`CONTEXT.md`](../../CONTEXT.md).
- This guide is **business-neutral**: it names no company, product, or stack. Every host-specific value
  lives in [`PROJECT.md`](../../PROJECT.md), never here.

---

## 1. Vendor the baseline in

Copy the baseline into your Host App — distributed by **copying files in**, no submodule/package/upstream
tracking ([ADR 0001](../adr/0001-distribute-as-copy-in-sync-script.md)). The `ace-sync`
script is never vendored into a Host App, so these commands always run **from a clone of the
ace bundle repo** (if you are reading a vendored copy of this guide inside a Host App, that
means your upstream ace clone, not this repo):

```bash
# Preview what would be copied (writes nothing):
ruby bin/ace-sync --dry-run /path/to/host-app

# Vendor the bundle in:
ruby bin/ace-sync /path/to/host-app
```

- The Host App owns **plain files** at their expected paths (real files, never symlinks).
- Copies each top-level surface **only if it exists**, so it behaves the same as the baseline grows.
- Does **not** copy this repo's meta files (`README.md`, `LICENSE`, `.gitignore`, `test/`, the
  `ace-sync` script itself), and never touches your Host App's own `.gitignore`.
- Preserves your Host App's own `PROJECT.md` and `bin/setup` on a re-sync (see §6).

**Vendoring into a brand-new (zero-commit) repository?** Create the PR base first: make an empty
root commit on the default branch and push it (`git checkout -b main && git commit --allow-empty
-m "Initial commit" && git push -u origin main`), then do all vendoring work on a feature branch.
Without this, the first feature-branch push becomes the repository's default branch and no PR can
ever target it. This bootstrap push is the **one sanctioned direct push to a protected branch**: it
carries no content and happens before §2 activates the guardrails that would block it.

## 2. Activate the guardrails

Wire the defense-in-depth branch protection that stops any agent — or accidental human — from
committing/pushing to a protected branch
([ADR 0009](../adr/0009-defense-in-depth-branch-protection-all-agents.md)). Git hooks are inactive on a
fresh clone until `core.hooksPath` is set:

```bash
bin/setup   # runs bin/install-git-hooks (sets core.hooksPath, regenerates the sidecar)
```

- Run this **once after vendoring, before your first commit**.
- The protected-branch list is authored in [`PROJECT.md`](../../PROJECT.md) → *Branch & PR Policy* and
  derived into the sidecar the guards read.
- Full setup + the AI-vs-human exemption → [`branch-protection.md`](branch-protection.md).

## 3. Customize through the Project Config

Author host-specific content as **Customization**, never by editing the baseline files in place — that
split is what keeps future updates mergeable.

1. **Edit [`PROJECT.md`](../../PROJECT.md)** — the single Customization surface the agents read. Replace
   the business-neutral placeholders in its sections. The parity check requires five of them — *Quality
   Checks*, *Attribution & Model Declaration*, *Branch & PR Policy*, *Review Severity Framework*,
   *Lifecycle Host* — and the rest are additive: omitting *Human Gates* falls back to the parser's strict
   fail-safe (plan approval `required`), which is **not** the shipped `auto` baseline — a host that wants
   `auto` keeps the section — while omitting *Intake Pipeline* or *Tool Roster* leaves `scout`/`restock`
   with no artifact locations, so author those two if you use those skills:
   - **Quality Checks** — the real commands an agent must run green before "done" (lint, tests,
     security, dependency audit).
   - **Attribution & Model Declaration** — the per-agent tool + model for commit trailers and comment
     footers ([ADR 0007](../adr/0007-attribution-includes-model-version-for-audits.md)).
   - **Branch & PR Policy** — protected branches, branch-naming prefixes, issue-linking rules. After
     editing the protected-branch list, re-run `bin/install-git-hooks` to regenerate the sidecar.
   - **Review Severity Framework** — tune the Critical/High/Medium/Low definitions the
     `verify`/`listen`/`final` skills classify against.
   - **Lifecycle Host** — the platform hosting issues/PRs and the artifact map (GitHub by default,
     remappable — [ADR 0006](../adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)).
   - **Human Gates** — which lifecycle pauses require a human
     ([ADR 0025](../adr/0025-human-gate-policy-is-a-project-config-value.md),
     [ADR 0029](../adr/0029-baseline-ships-ungated-to-merge.md)). Ships **ungated to merge**: plan
     approval `auto`, merge `required`. Under `auto` the AC proceeds on its own recommendation — it
     still posts the assessment and the plan (under `auto` those comments are the sole audit trail) and
     names that it self-selected; set *plan approval* back to `required` if your host wants the AC to
     stop and wait for a human. **Merge is not configurable:**
     `required` is its only legal value, so no host can express self-merge, and parity hard-fails any
     attempt. Leaving this section out falls back to the parser's strict fail-safe (plan approval
     `required`) — the safe default for a vendored copy that predates the section, **not** the shipped
     `auto` baseline; keep the section to ship `auto`.
   - **Reviewer** — the independent second-model reviewer chain the lifecycle summons: primary,
     fallback order, bounded window, degradation floor, plus an *Invocation paths* table giving each
     harness's summons mechanism ([ADR 0026](../adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md),
     [ADR 0027](../adr/0027-reviewer-chain-validated-against-invocation-paths.md)). **The degradation
     floor is not configurable:** `stop-and-ask` is its only legal value, so no host can express
     "deliver unreviewed", and parity hard-fails any attempt. Omitting this section is fine — a
     vendored copy that predates it parses to the same shipped chain. But the *Invocation paths* table
     has **no default**, so the PR gate then has no summons mechanism at all and every run resolves to
     the floor, `stop-and-ask`. Author *Invocation paths* to actually get a review. The shipped Codex
     row is **this repo's real mechanism** — a synchronous run through the local Codex CLI runtime
     against the checked-out PR head — which hosts replace with their own
     ([ADR 0035](../adr/0035-codex-summons-is-the-local-cli-runtime.md)). The synchronous-CLI *shape*
     is valid for any host: run the reviewer and read its returned output, have the summoner relay
     that output onto a PR surface (an issue-level comment carrying harness/model, reviewed SHA, and
     findings), and declare an executable, side-effect-free ready probe as the *Check*. Concrete
     command strings belong here in guidance, not in the machine-read cells. This repo's two
     commands come from the Codex **companion runtime** — a script this host's installed Codex
     plugin provides, **external to this bundle** (a plugin script, not bare-CLI subcommands): the
     script is not on `PATH` — each command runs as
     `node <plugin-dir>/scripts/codex-companion.mjs <command>` from the plugin's install location.
     The Check is its `setup --json`, which reports `"ready": true` when installed and
     authenticated (bare-CLI equivalent: `codex doctor --json`); the summons is its
     `review`, which synchronously reviews the checked-out head **against the
     PR's base branch** (its default base is the repository default — pass the base explicitly when
     the PR targets anything else) and prints the review for the summoner to relay. A host without
     that runtime authors its own commands the same way — an executable probe plus a review
     invocation with the PR base and success criteria named.
   - **Intake Pipeline** / **Tool Roster** — the artifact locations `scout`/`clip` and `restock` read
     and write (also additive; repoint them if you relocate those artifacts).
2. **Add your domain rules** to the [Rules Layer](../../rules/) as Customization — host-specific
   Patterns and Anti-Patterns, kept separate from the baseline starters
   ([ADR 0004](../adr/0004-two-tier-rules-layer-progressive-context.md)). Heavy, subsystem-specific case
   studies go in the deferred Tier-2 deep docs (`docs/rules/`), read on demand via the trigger table.
3. **Keep the bundle glossary and your domain glossary separate.** The vendored
   [`CONTEXT.md`](../../CONTEXT.md) is the *config-layer context* — the bundle's own vocabulary that
   `AGENTS.md` links to. When your host's first domain term crystallises (typically in a `distill`
   session), do **not** extend or overwrite that file: add a root `CONTEXT-MAP.md` and give the
   domain its own `CONTEXT.md` (see `skills/distill/CONTEXT-FORMAT.md` → *Single vs multi-context
   repos*).
4. **Leave [`AGENTS.md`](../../AGENTS.md) and the Adapters as the baseline** so every tool stays in
   lockstep. Host values flow in through `PROJECT.md`, not by forking the Canonical Source — the parity
   check (§5) enforces this.

## 4. Run each skill per tool

The bundle ships **thirteen Skills**, each authored **once** as a canonical body at `skills/<name>/SKILL.md`
and reached through a thin, tool-specific **Invocation Shim** — so the procedure and quality gates are
identical on every tool, and only tool-specific execution enhancements degrade gracefully
([ADR 0003](../adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)):

- `distill` — the plan-grilling / glossary + ADR capture session.
- The six **lifecycle** skills — `assess`, `devise`, `invoke`, `verify`, `listen`, `final`.
- `ship` — the orchestrator that sequences those six end to end.
- `scout` — the intake sweep; `clip` — the intake push front door.
- `create-skill` — the authoring front door (scaffolds a new, conforming skill from full repo context).
- `follow` — the roster front door (adds/updates a Watchlist voice from a handle or link).
- `restock` — the Tool Roster refresh (re-verifies the harness/model snapshot's facts, opens a deltas-only PR).

**How each configured agent invokes a Skill:**

| Tool | Invocation |
|------|------------|
| **Claude Code** | A slash command from the thin shim at `.claude/commands/<name>.md` — e.g. `/assess 11`, `/devise 11`, `/invoke 11`, `/ship 11`, `/scout`, `/clip`, `/create-skill`. The shim points at the canonical body. |
| **Codex** | Reads `AGENTS.md` natively, so **the documented procedure is the shim**: to run a Skill, read `skills/<name>/SKILL.md` and follow it. |
| **Copilot** | Same — its PR surfaces read `AGENTS.md` natively; read `skills/<name>/SKILL.md` and follow it. |
| **Antigravity** | Same — `GEMINI.md` imports `AGENTS.md`; read `skills/<name>/SKILL.md` and follow it. |
| **Grok Build** | Same — reads `AGENTS.md` natively (like Codex); read `skills/<name>/SKILL.md` and follow it. |

No tool needs a per-tool copy of a procedure: Claude reaches the one canonical body through its slash
shim, and the native-discovery tools reach the same body by the documented "read and follow it" path
([ADR 0010](../adr/0010-repo-layout-canonical-skills-at-root.md)).

**The lifecycle** runs **Assess → Plan → Implement → Verify → Deliver**, plus a review-response step:
`assess` → `devise` → `invoke` → `verify` → `listen` → `final`.

- Issue-scoped stages (`assess`, `devise`, `invoke`) take the **issue** id; PR-scoped stages (`verify`,
  `listen`, `final`) take the **PR** id that `invoke` opens.
- Two human gates punctuate it — **plan approval** (after `devise`) and **merge** (after `final`).
  Which of them *pauses* is declared in [`PROJECT.md`](../../PROJECT.md) → *Human Gates*; the shipped
  baseline is **ungated to merge** (plan approval `auto`), so out of the box only merge waits for the
  HC. **Merge is never configurable.** And
  whatever the setting, "plan posted" stays a **context boundary**: `invoke` re-reads the posted plan
  from the issue rather than trusting conversational memory.
- Full stage spec, terminal artifacts, and when to compress stages →
  [`development-lifecycle.md`](../standards/development-lifecycle.md).
- To run the whole lifecycle hands-off, the [`ship`](../../skills/ship/SKILL.md) orchestrator sequences
  all six while protecting exactly those two gates, as your *Human Gates* setting declares them.

### The intake pipeline (`scout` + `clip`)

Two Skills run **outside** the issue/PR lifecycle, keeping the bundle's reference material current —
`scout` is the **pull** sweep, `clip` is the **push** front door.

[`scout`](../../skills/scout/SKILL.md) polls a **Watchlist**, drafts dated entries into an append-only
**Learnings Log**, and opens a PR for a human to accept, edit, or reject — the sweep proposes, a human
disposes ([ADR 0012](../adr/0012-intake-pipeline-placement.md)). The artifact locations it reads and
writes are host-configurable in [`PROJECT.md`](../../PROJECT.md) → *Intake Pipeline* (they ship pointing
at an illustrative reference seed; repoint them per host). Run it two ways:

- **By hand** — Claude: `/scout`; the native-discovery tools (Codex, Copilot, Antigravity, Grok Build): read and follow
  `skills/scout/SKILL.md`. Use for a one-off sweep or to try it before scheduling.
- **On a schedule** — wire it to run automatically (e.g. nightly). Cadence, enable/disable, and the
  empty-sweep behavior (when nothing new is found, it logs and opens **no** PR) →
  [intake-sweep scheduling guide](intake-sweep-scheduling.md)
  ([ADR 0013](../adr/0013-scheduled-intake-sweep-and-empty-sweep-policy.md)).

Either way the discovery-and-drafting procedure and its quality bar are identical; only the trigger and
the disposition differ — an interactive run walks findings one at a time, a scheduled run opens the PR
for asynchronous disposition ([ADR 0016](../adr/0016-interactive-sequential-disposition-scout.md)).

The [`clip`](../../skills/clip/SKILL.md) skill is the pipeline's **push front door**: when a human
already has a specific item — a screenshot, a link, or a quote — and wants it ingested now rather than at
the next sweep, `clip` captures it, enforces a hard **real-URL gate**, writes a **stance-less** drop into
the manual-drop inbox, then delegates to `scout` (scoped to that one drop) to draft the entry and open
the review PR ([ADR 0015](../adr/0015-intake-front-door-drop-skill.md)). One invocation → a reviewable PR
is the happy path; a human disposes (on the single finding interactively when present, otherwise on the
PR). Invoke it like any Skill — Claude: `/clip`; the native-discovery tools: read and follow
`skills/clip/SKILL.md`.

**Don't want the intake pipeline?** Leaving it in place costs nothing at rest — the skills are inert
unless invoked — so ignoring it is the recommended default. If your host really must remove it, the
pipeline is woven through the bundle rather than bolted on, and a partial trim leaves either a red
parity check or a live command pointing at a deleted body. The full file manifest, the ordering hazard,
and the per-update cost of re-syncing are in
[detaching the intake pipeline](detaching-the-intake-pipeline.md).

## 5. Keep the bundle green in-host

A vendored copy must keep the shipped [`parity_check.rb`](../../scripts/parity_check.rb) **green
in-host**. Run it any time after vendoring or customizing:

```bash
ruby scripts/parity_check.rb
```

Because the Host App runs the same structural check this repo does
([ADR 0008](../adr/0008-structural-parity-check-not-model-in-the-loop.md)), two invariants hold for the
vendoring installer — and a Customization must not break them:

- **Every parity-link target is shipped.** The whole `docs/` tree is vendored because `AGENTS.md` and
  `.github/copilot-instructions.md` link into it; a copy missing any link target would redden the host's
  own parity check.
- **Content is copied faithfully.** `ace-sync` never rewrites files on copy — that would drift the
  Adapters from the Canonical Source and break the re-sync `git diff` a host uses to reconcile.

Both are guarded by `test_vendored_copy_passes_parity_check`, which runs `parity_check.rb --root DEST`
against a vendored copy of the real bundle. Before changing what `ace-sync` copies, remember:
dropping a link target or rewriting content on copy would break a host silently.

## 6. Update / re-sync

Updating is a **re-run of the sync followed by a manual merge**
([ADR 0001](../adr/0001-distribute-as-copy-in-sync-script.md)) — again from a clone of the
ace bundle repo, since the script is not vendored:

```bash
ruby bin/ace-sync /path/to/host-app
```

- Baseline files are overwritten; **`PROJECT.md` and an existing `bin/setup` are preserved** (pass
  `--force` to overwrite `PROJECT.md` too for a deliberate reset).
- **Because it is preserved, your `PROJECT.md` may predate an additive section the new baseline
  expects.** That stays green by design — the parser supplies shipped defaults — so nothing tells you
  it is missing. Diff your `PROJECT.md` against the baseline's after each re-sync and add what is new.
  The current instance is **Reviewer** (§3): without its *Invocation paths* table there is no summons
  mechanism, so the PR gate resolves to `stop-and-ask` on every run.
- Review the changes with `git diff` in the Host App and reconcile any Customization.
- Re-run the quality gate (§5) to confirm the bundle is still green.
