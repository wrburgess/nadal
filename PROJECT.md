# PROJECT.md — Project Config

The **Project Config**: the one place a Host App declares its host-specific values so the Skills and
[Canonical Source](AGENTS.md) stay generic. A vendoring Host App edits the values in this file; it
does not edit `AGENTS.md` to change them. This file ships with **business-neutral placeholders** —
replace them during Customization.

> Section headings below are a contract: the parity check (`scripts/parity_check.rb`) asserts the
> **five required** `##` sections are present — *Quality Checks*, *Attribution & Model Declaration*,
> *Branch & PR Policy*, *Review Severity Framework*, *Lifecycle Host*. Rename one and the check fails.
> This file ships **more** sections than that floor (*Human Gates*, *Intake Pipeline*, *Tool Roster*);
> those are additive, so a Host App that predates one of them stays green.

## Quality Checks

The commands an agent must run and get green before declaring work done. The generalized Skills read
this table — they never hardcode a stack's commands. **Host Apps: replace these rows with your real
commands during Customization** (e.g. a Rails host: lint `bundle exec rubocop -a`, tests
`bundle exec rspec`, security `bin/brakeman --no-pager -q`, dependency audit `bin/bundler-audit check`;
a JS/TS host: lint `npm run lint`, tests `npm test`, dependency audit `npm audit`). A **Stack Overlay**
such as `ace-rails` can ship a ready-to-paste command set for its stack.

nadal's real command set (a JS/TS host), replacing the shipped ace config-repo rows during
Customization:

| Purpose | Command |
|---------|---------|
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Tests + coverage floor | `npm run test:coverage` |
| Structural parity | `ruby scripts/parity_check.rb` |
| CLI grammar parity | `npm test -- test/cli-grammar-parity.test.ts` |

The `npm run` rows are not yet backed by a `package.json` — Tasks 4–6 of the Foundation plan create
those commands. Until then, *Structural parity* is the effective gate.

A check whose command runs but has nothing applicable to inspect (e.g. no application code to lint) is
reported `pass`/`not_run` with a stated reason — checks are **not applicable, not skipped**, so rigor
is unchanged.

## Attribution & Model Declaration

Single source of truth for agent attribution ([ADR 0007](docs/adr/0007-attribution-includes-model-version-for-audits.md)).
Bump the model here — in one place — when the host switches models. Skills sign with the
**runtime-actual** model when determinable, reconciling against these declared defaults and recording
the actual if they differ. Use human-readable names, never API ids.

| Agent (harness) | Declared model | Identity email |
|-----------------|----------------|----------------|
| Claude Code | `Claude Opus 5` | `noreply@anthropic.com` |
| Codex | `GPT (host sets model)` | `<host sets>` |
| Copilot | `model varies (GPT / Claude / Gemini)` | `<host sets>` |
| Antigravity | `Gemini Flash (host sets model)` | `<host sets>` |
| Grok Build | `Grok (host sets model)` | `<host sets>` |

- **Commit trailer:** `Co-Authored-By: <Tool Model> <email>` — e.g.
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **PR / review / comment footer:** `— <Tool> (<Model>)` — e.g. `— Claude Code (Opus 5)`.
- Attribution shows **per-agent identity** so provenance reflects which agent did the work. The
  *Agent* column names the **harness** (Claude Code · Codex · Copilot · Antigravity · Grok Build); the *Declared
  model* column names the **model** it runs — never the harness — per the naming convention in
  [ADR 0024](docs/adr/0024-harness-model-naming-convention.md). Copilot's backing model is
  variable/unknown, so its declared model reads `model varies (GPT / Claude / Gemini)`.

## Branch & PR Policy

- **Protected branches:** `main` — this backticked list (everything up to the
  em dash) is the **authored source** the guardrails derive from. Never commit or push directly to a
  protected branch; agents work on feature branches. A host may trim or extend the backticked list,
  then run `bin/install-git-hooks` to regenerate the derived sidecar `.githooks/protected-branches`.
  Enforcement (git hooks + per-tool fast-fail) is delivered by the guardrails baseline
  ([ADR 0009](docs/adr/0009-defense-in-depth-branch-protection-all-agents.md)) and sources this list.
- **Branch naming:** `feature/` · `fix/` · `chore/` · `docs/` prefixes (host may extend).
- **One PR per branch**, opened ready-for-review (not draft).
- **Issue linking:** `Closes #N` for a leaf issue; `Part of #N` (no closing keyword, even negated) for
  an umbrella/epic sub-PR — see `AGENTS.md` → *Umbrella sub-PRs and closing keywords*.
- **Feature-branch autonomy:** commit/edit/refactor without asking on a feature branch; ask before any
  change to a protected branch.

## Review Severity Framework

Generic starter severities for `verify`/`listen`/`final` and human review. A Host App tunes the
definitions.

| Severity | Meaning | Disposition |
|----------|---------|-------------|
| **Critical** | Data loss, security hole, breaks protected-branch or auth invariants, or ships broken. | Block merge; fix before proceeding. |
| **High** | Correctness bug, missing required test, or a violated project rule. | Fix in this PR before merge. |
| **Medium** | Maintainability, clarity, or a smaller coverage gap. | Fix now or file a tracked follow-up. |
| **Low** | Style, naming, or optional polish. | Author's discretion. |

## Lifecycle Host

- **Host platform:** `GitHub` (default). The issue/PR verbs the Skills use are isolated so a Host App
  on another platform (e.g. GitLab) can remap the artifact targets without rewriting skill bodies
  ([ADR 0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)).
- **Artifact map:** assessments/plans → issue comments; implementation → a PR; SOW → a PR comment.
- **Copilot adapter mode:** `native` (Generic Baseline default) — Copilot reads `AGENTS.md` natively
  and `.github/copilot-instructions.md` is a discovery marker. Set to `render` (a byte-for-byte
  `parity:render` block in `.github/copilot-instructions.md`) only if the host drives work through a
  legacy in-editor Copilot IDE; the parity check enforces the render matches `AGENTS.md`.

## Reviewer

The **independent second-model Reviewer** the lifecycle summons at the plan and PR gates — declared
here so a generic Skill body names the *role* while the host names the *identity*
([ADR 0026](docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md), the same
argument shape as the lifecycle host in [ADR 0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)
and the gate policy in [ADR 0025](docs/adr/0025-human-gate-policy-is-a-project-config-value.md)).
The chain settings ship as **business-neutral placeholders** a Host App replaces with its real
reviewer during Customization; the *Invocation paths* Codex row below is the one exception — it
carries **this repo's real mechanism** ([ADR 0035](docs/adr/0035-codex-summons-is-the-local-cli-runtime.md)),
which hosts likewise replace.

Like *Human Gates*, this heading is deliberately **absent from the parity check's required sections**,
so an already-vendored Host App whose `PROJECT.md` predates it keeps parsing to the shipped defaults
and stays green.

| Field | Setting | Allowed values |
|-------|---------|----------------|
| **Primary** — the reviewer summoned first | `Codex` | any harness with a row in *Invocation paths* |
| **Fallback order** — tried in turn when the primary is unreachable or silent | `none` | comma-separated harnesses each with an *Invocation paths* row, or `none` alone; no blank elements and no repeat of *Primary*. Author the whole list inside **ONE pair of backticks** (`Copilot, Gemini`) — never one span per element, since the checker reads only the first span |
| **Bounded window** — how long to wait for a response before falling back | `30m` | `<integer><unit>`, unit one of `s` · `m` · `h` |
| **Degradation floor** — what happens when the whole chain is exhausted | `stop-and-ask` | `stop-and-ask` (not configurable) |

- **The degradation floor is not configurable.** `stop-and-ask` is its only allowed value and the
  parity check hard-fails any other, on the same footing as merge: a run that cannot obtain an
  independent review must not be able to certify itself. The AC stops and asks the HC — it never
  delivers unreviewed with a footnote ([ADR 0026](docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
  decision 3, affirming [ADR 0005](docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)).
- **The acting harness is excluded from the chain before any summons.** An AC is never its own
  independent backstop — a same-model review that *appears* to run is worse than none — so the harness a
  run is executing *as* is filtered out of *Primary* + *Fallback order* before the window opens
  (`scripts/reviewer.rb` → `independent_chain`, the runtime sibling of the static
  fallback-names-the-primary invariant). It is a **harness-level** guard: it catches a same-harness
  reviewer and, like the invariant it mirrors, does **not** catch two harnesses serving the same model
  ([ADR 0027](docs/adr/0027-reviewer-chain-validated-against-invocation-paths.md) decision 7 records why
  the rest is unverifiable from a static declaration). If the exclusion empties the chain, the run is at
  the exhausted-chain floor — `stop-and-ask`.
- **At the PR gate, the AC summons the Reviewer, not the HC**, and [`verify`](skills/verify/SKILL.md)
  is the **sole owner** of that summons. No other Skill issues it — a duplicated summons produces two
  review requests and two windows, and makes "did the primary respond?" unanswerable.
- **At the plan gate the HC forwards** the assessment and plan **when plan approval is `required`** (see
  *Human Gates* below) — a human is already standing at that gate. **The shipped baseline is now `auto`**
  ([ADR 0029](docs/adr/0029-baseline-ships-ungated-to-merge.md)), and under `auto` nobody is at the plan
  gate, so the plan-gate summons has no owner or mechanism yet; that residual risk is tracked in
  [#129](https://github.com/wrburgess/ace/issues/129), and
  [ADR 0026](docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
  decision 2 records it as deliberately unsettled.
- **A response** is a reply on **any** of the three surfaces — an issue-level PR comment, an **inline
  diff thread**, or a **review body**. Reading only the first makes an automated inline review
  invisible. **A summons that merely returned success is not a response** — only a reply on one of the
  three surfaces is. A summons that created **no review request** (the API "succeeded" but produced
  nothing to wait for) is a no-op → `unreachable`; a request that was created but has **not replied yet**
  is polled to the bounded-window expiry and recorded as `timed-out` if it stays silent — the two remain
  distinct. *Request accepted ≠ review produced.* For an **asynchronous** mechanism a response is
  accepted only when its review artifact **explicitly attests the reviewed commit** it covers; an
  artifact that attests none is unverified → the degradation floor, never assumed to cover the
  summon-time head.
- **Timeout and unreachable are distinct outcomes**, carried forward separately: "no second model
  exists" and "the second model is slow" call for different HC responses, and collapsing them loses
  information the SOW cannot reconstruct.

### Invocation paths

The mechanism for summoning each harness. **This table is the chain's membership list**: a harness
named in *Primary* or *Fallback order* with no row here has no summons mechanism, so it is
**unreachable** — the parity check reports it, and `verify` falls straight past it rather than
starting a window ([ADR 0027](docs/adr/0027-reviewer-chain-validated-against-invocation-paths.md)).
The Codex row names **this repo's real mechanism**, not a neutral placeholder
([ADR 0035](docs/adr/0035-codex-summons-is-the-local-cli-runtime.md)); a Host App replaces these rows
with its real commands during Customization.

The **Check** cell is **optional** — host-supplied wherever the baseline declares none — narrowly
superseding [ADR 0026](docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
decision 4's unconditional model:

- **Declared** → run it *before* summoning; an unmet precondition falls back immediately rather than
  burning the window on a summons nobody receives.
- **Absent** → **the summons is the probe**, and **`precondition unverified`** rides as a **qualifier**
  on whatever terminal outcome results — `unreachable (precondition unverified)` when no request was
  created, `timed-out (precondition unverified)` when a request was created but stayed silent through the
  window — never collapsing a *pending* request into a clean `unreachable`. (This mirrors
  [`verify`](skills/verify/SKILL.md)'s summon steps; the two must stay aligned.)

**The baseline now ships one executable check** — the Codex row's ready probe, which can run *before*
summoning without a side effect, so it is declared rather than left host-supplied
([ADR 0035](docs/adr/0035-codex-summons-is-the-local-cli-runtime.md), narrowly superseding
ADR 0027 decision 4 for that row only). The Copilot check *is* the summons — it cannot precede one
without a side effect — so that row's Check stays host-supplied.

**The first column is the harness name, by contract.** A host may rename, add, drop or reorder every
column *after* it — the mechanism column is found by its `Summons` header, falling back to the second
column when no header names it — but the harness label must stay leftmost, because it is read
positionally. Moving it fails closed rather than silently: the real harness name is never seen, so
every chain entry reads as unreachable and the parity check reddens.

| Harness | Summons | Precondition | Check |
|---------|---------|--------------|-------|
| Codex | run the review synchronously through the local Codex CLI runtime against the checked-out PR head (the reviewed SHA binds by construction) | the Codex CLI runtime is installed and authenticated | the runtime's ready probe (side-effect-free; run before summoning) |
| Copilot | request a PR review via the host platform's API; the accepted review artifact attests the reviewed commit in the review's `commit_id` field | the account has Copilot code review enabled | *(host-supplied — none shipped)* |
| *(host adds its own)* | — | — | — |

**Both shipped mechanisms are still PR-gate-only** — the CLI runtime reviews the checked-out
implementation diff of a PR head, and the Copilot path requests "a PR review via the host platform's
API". At the **plan** gate there is therefore **no summons mechanism at all**, whoever owns it: the
open question ADR 0026 decision 2 records is *who* summons, and this table is why answering that
alone would not be enough — the [#129](https://github.com/wrburgess/ace/issues/129) residual is
unchanged. A host wanting a plan-gate review must add a mechanism that does not require a PR.

A host adding an **asynchronous** row must name in that row the artifact field its platform records
the reviewed commit in, as the shipped Copilot row does with a GitHub review's `commit_id` — the
concrete field name is host territory and never appears in a skill body.

## Human Gates

Which lifecycle pauses require a human, declared here so a generic Skill body names the *gate* instead
of hardcoding a policy a host would otherwise have to fork the file to change
([ADR 0025](docs/adr/0025-human-gate-policy-is-a-project-config-value.md), the same argument shape as
the host-platform value in [ADR 0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)).
The Generic Baseline now ships **ungated to merge**: plan approval is `auto`, so a hands-off run drives
itself to the one standing human gate, and every Skill body states that default inline
([ADR 0029](docs/adr/0029-baseline-ships-ungated-to-merge.md)). **Merge stays `required` and is never
configurable** — it is the sole human gate. (A vendored `PROJECT.md` that predates this section still
parses to the strict fail-safe — plan approval `required` — through the parser default; the flip lives
in the shipped file, not in that default.)

| Gate | Setting | Allowed values |
|------|---------|----------------|
| **Plan approval** — covers both the Stage-1 option pick and the Stage-2 plan approval | `auto` | `required` · `auto` |
| **Merge** — the HC merges the delivered PR | `required` | `required` (not configurable) |

- **`auto`** (shipped default) — the AC proceeds on **its own stated recommendation** rather than
  waiting. It still **posts** the assessment and the plan to the lifecycle host — under `auto` those
  comments are the *only* durable audit trail of what was decided, so posting them becomes more
  load-bearing, not less — and it **names in the posted comment** that it self-selected under `auto`.
  Under `auto` the AC may likewise elect the exploratory (spike-then-plan) path itself, stating its
  rationale in the plan.
- **`required`** — a host may set the **plan-approval** row (and only that row) back to `required`. The
  AC then stops and waits for the HC: it does not proceed past the assessment without a chosen option,
  and it does not write code without an approved plan.
- **Merge is not configurable.** `required` is the only allowed value: **no Host App may express
  self-merge.** The parity check hard-fails any other value. `final` posts the SOW; a human merges.

**Unconditional, whatever this section says:**

- **Merge is always human** (above).
- **The plan gate is also a context boundary, and the reset survives the pause being waived.**
  "Plan posted" forces a context reset under either setting — a session boundary under `required` (the
  human crosses), `ship`'s own context reset under `auto`
  ([ADR 0028](docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md)):
  [`invoke`](skills/invoke/SKILL.md) **begins by re-reading the posted plan from the issue** and never
  continues on conversational memory, and the pre-[`final`](skills/final/SKILL.md) context check still
  applies. `auto` removes the *wait*; it never removes the context firebreak.
- **[`ship`](skills/ship/SKILL.md)'s four emergency stops** — an unresolvable check failure; a discovery
  that the change touches core logic the plan did not anticipate; an architectural or ambiguous review
  comment; a handoff verdict the orchestrator cannot resolve — always stop and ask the HC.
- **The lifecycle's "the HC decides when to compress"** remains mandatory for every row of its
  *When to skip or compress stages* table **but one**: `auto` waives exactly three pauses — the Stage-1
  option pick, the Stage-2 plan approval, and the **exploratory (spike-then-plan) election** named
  above, which chooses *how to plan* rather than skipping a stage. The trivial-fix, bug-fix,
  documentation-only and large-change rows each compress away a *stage* and stay the HC's call.
- **The intake and authoring "a human disposes" gates** — [`scout`](skills/scout/SKILL.md),
  [`clip`](skills/clip/SKILL.md), [`follow`](skills/follow/SKILL.md),
  [`restock`](skills/restock/SKILL.md), [`create-skill`](skills/create-skill/SKILL.md)
  ([ADR 0014](docs/adr/0014-manual-drop-inbox-for-unfetchable-sources.md),
  [ADR 0016](docs/adr/0016-interactive-sequential-disposition-scout.md)) — are out of scope too.
  `auto` is **not** licence to auto-merge any of their review PRs.

### nadal merge-autonomy intent (recorded, not machine-enforced)

The HC's stated intent for nadal (decision 2026-07-29): **AC merges after green Quality Checks +
adversarial second-model review (SHA-bound). No human merge gate.** This paragraph **records** that
intent; it does **not** change the *Merge* row above, and could not — `merge: required` is the only
value `scripts/human_gates.rb` accepts (`ALLOWED = { merge: %w[required] }`), and the parity check
hard-fails any other value **on every vendored host**, per the "Merge is not configurable" /
"Merge is always human" invariants this same section states above ([ADR 0025](docs/adr/0025-human-gate-policy-is-a-project-config-value.md)
decision, reaffirmed unconditionally at the end of this section). This is a **known delta**: nadal's
stated operating intent is autonomous merge on green + attested review, while the vendored floor this
repo runs today still requires a human to merge every PR, including this one. Closing that delta —
if the HC still wants it after weighing the "no Host App may express self-merge" rationale — is a
framework-level change (an ADR amending or overriding `scripts/human_gates.rb`'s `ALLOWED` set), out
of scope for a `PROJECT.md`-only Customization task; it is not something this file can express on its
own. Until such a change lands, `final` posts the SOW and **a human merges**, exactly as the table
above requires.

### Rule-suggestion disposition

How [`final`](skills/final/SKILL.md) handles the Rules-Layer / config improvements it learns during
implementation, now that a hands-off run reaches the merge gate on its own
([ADR 0029](docs/adr/0029-baseline-ships-ungated-to-merge.md)). Its shipped default is
`autonomous-fold`; allowed values `autonomous-fold | present-to-hc`. This is a **documentary** value —
prose, **not** a row in the gate table above (the parser reads a two-row table and must stay two-row),
so a host changes it by editing this paragraph.

- **`autonomous-fold`** (shipped default) — `final` **folds** well-scoped, low-risk Rules-Layer/config
  improvements into the **same PR a human merges**, so the merge gate stays the backstop for them, and
  **defers** large or contentious ones to a follow-up issue recorded in the SOW. The discretion bar:
  well-scoped **and** low-risk → fold; large **or** contentious → defer.
- **`present-to-hc`** — `final` **presents** the suggestions to the HC and waits, editing no Rules
  Layer or config without approval (the pre-ungated behavior).

This value governs only `final`'s rule-suggestion step. It does **not** touch the intake/authoring
"a human disposes" gates — [`scout`](skills/scout/SKILL.md), [`clip`](skills/clip/SKILL.md),
[`follow`](skills/follow/SKILL.md), [`restock`](skills/restock/SKILL.md),
[`create-skill`](skills/create-skill/SKILL.md) — whose review PRs a human still disposes.

## Intake Pipeline

The artifact locations the [`scout`](skills/scout/SKILL.md) sweep reads and writes, declared here so
the generic Skill body names no path ([ADR 0012](docs/adr/0012-intake-pipeline-placement.md)). These
ship as **business-neutral placeholders** pointing at the illustrative reference seed; a Host App
repoints them during Customization if it relocates its intake artifacts.

| Artifact | Location |
|----------|----------|
| **Watchlist** — the machine-readable source list the sweep polls | [`docs/reference/voices.yml`](docs/reference/voices.yml) |
| **Learnings Log** — the dated, append-only entries + their index | [`docs/reference/learnings/`](docs/reference/learnings/) |
| **Last-swept marker** — the recency stamp the next sweep reads for its incremental window | the `**Last swept:**` line in the Learnings-Log [`index.md`](docs/reference/learnings/index.md) |
| **Manual-drop inbox** — human-curated pointers to output the sweep can't fetch (X, paywalled, feed-less) | [`docs/reference/intake-inbox/`](docs/reference/intake-inbox/) |

The *schemas* for these artifacts (the Watchlist fields, the Learnings-Log entry front-matter with its
required `stance` and `touches`, the drop shape in the manual-drop inbox) are business-neutral mechanism
and live with the artifacts; only the locations are host-configurable and belong here.

## Tool Roster

The location of the [Tool Roster](docs/reference/tool-roster.yml) artifact the `restock` refresh skill
reads and writes, declared here so the generic Skill body names no path
([ADR 0023](docs/adr/0023-tool-roster-facts-tracker-sibling-to-intake.md), mirroring
[ADR 0012](docs/adr/0012-intake-pipeline-placement.md)). Ships as a **business-neutral placeholder**
pointing at the illustrative seed; a Host App repoints it during Customization.

| Artifact | Location |
|----------|----------|
| **Tool Roster** — the current-state harness/model snapshot | [`docs/reference/tool-roster.yml`](docs/reference/tool-roster.yml) |

The Tool Roster *schema* (the fields, the provenance typing, the inclusion test) is business-neutral
mechanism and lives with the artifact; only the location is host-configurable and belongs here.

## Execution Profile

Per-step model/effort routing (spec § Model routing; proving ground for ace#143).
Ceiling: **Opus / high** — Fable only on explicit HC invocation.
Executable at delegation boundaries (`.claude/agents/*.md`, subagent spawns) and via the
project model pin; step-level routing inside one session is advisory.

| Step | Model / effort |
|------|----------------|
| Driver sessions (grilling, planning, judgment) | Opus / high |
| SOW execution (TDD implement) | Sonnet / high; escalate to Opus when stuck, noted on the issue |
| Mechanical (scaffolds, fixture capture, writeups, findings appends) | Haiku or Sonnet / low |
| Adversarial PR review | GPT family via Codex / high |
| AFK research | Sonnet / medium |
