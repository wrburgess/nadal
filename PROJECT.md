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

nadal's Host App gate, replacing the shipped ace config-repo rows during Customization. Only
**currently-runnable** checks are registered as rows: [`AGENTS.md`](AGENTS.md) → *Quality gate*
requires every `invoke`/`verify` run to run every row here, so listing a command with no backing
script would exit "Missing script" on every lifecycle run from Task 3 onward, never reaching green —
not something an "effective gate" caveat in prose can override.

| Purpose | Command |
|---------|---------|
| Structural parity | `ruby scripts/parity_check.rb` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| CLI grammar parity | `npm test -- test/cli-grammar-parity.test.ts` |
| Tests + coverage floor | `npm run test:coverage` |

All rows are live: the coverage floor is enforced at 75% lines / 75% functions via
`vitest.config.ts` thresholds, with every file under `src/` in scope and no vitest coverage
exclusions — `src/cli/main.ts` included. Task 6 turned that floor green by adding real tests that
exercise `src/db/schema.ts` and `src/cli/commands/db-migrate.ts` end-to-end via `openDb`/
`runMigrations` and `dispatch(["db", "migrate"])`, rather than padding with tautological tests — see
the Task 6 report.

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
- **Commit signing, and the fallback when the signer is unavailable.** Commits are signed
  (`commit.gpgsign=true`, `gpg.format=ssh`, via 1Password's `op-ssh-sign`). That signer needs an
  **unlocked 1Password**, which a long unattended run cannot guarantee — the agent's commit then fails
  with `error: 1Password: failed to fill whole buffer` / `fatal: failed to write commit object`, and the
  run stalls holding finished, verified work it cannot record.

  **When, and only when, the signer fails that way: retry once with `git commit --no-gpg-sign`, and say
  so — in the run output and in the PR body.** The fallback is **per-commit and visible**. Never set
  `commit.gpgsign=false` in any config to route around it: a config change is silent, outlives the
  incident, and would drop signing for the HC's own interactive commits too — the failure this rule
  exists to avoid is an *unattended stall*, not signing itself.

  Why this is safe here, checked rather than assumed (2026-07-31): nothing requires signed commits —
  `main` has no branch protection and no rulesets; feature-branch signatures **do not verify on GitHub
  anyway** (the key is not registered as a *signing* key on the account, so the API reports
  `verified: false, reason: unknown_key`); and squash-merge discards those commits, replacing them with
  a merge commit GitHub signs itself (`verified: true`, `reason: valid`). So an unsigned feature commit
  costs no verifiable provenance that a signed one was providing.

  **This rule expires the moment any of those three facts changes** — if `main` gains a signed-commits
  requirement, if the signing key is registered on the account, or if the merge strategy stops squashing,
  re-derive it rather than carrying it forward.

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
- **With `Fallback order: none`, that exclusion is unconditional whenever Codex is the acting
  harness** — `chain` is just `[Codex]`, so `independent_chain` always empties it, and every
  Codex-run `invoke`/`verify` would hit `stop-and-ask` with no other entry to try (a Codex reviewer
  finding on this exact PR: nothing app-specific, the same logic applies to any host that names a
  single-entry chain). nadal's mitigation is *not* a second *Invocation paths* row — it's
  [§ Execution Profile](#execution-profile): Codex is routed **only** to the Adversarial-PR-review
  step, never Driver/SOW-execution/Mechanical/AFK, so Codex is not expected to be the acting harness
  for a lifecycle run in the first place. If a future task ever assigns Codex a Driver role, add back
  a working fallback (e.g. `Copilot`, whose *Invocation paths* row already ships below) before doing
  so, or this chain empties for it too.
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
([ADR 0029](docs/adr/0029-baseline-ships-ungated-to-merge.md)). **The baseline ships merge `required`**;
**nadal sets it to `attested`** — the AC merges the delivered PR, but only against an independent
external-model adversarial review bound to the SHA being merged
([ADR 0037](docs/adr/0037-merge-gate-accepts-attested.md)). (A vendored `PROJECT.md` that predates this
section still parses to the strict fail-safe — plan approval `required`, merge `required` — through the
parser default; the flip lives in the shipped file, not in that default.)

| Gate | Setting | Allowed values |
|------|---------|----------------|
| **Plan approval** — covers both the Stage-1 option pick and the Stage-2 plan approval | `auto` | `required` · `auto` |
| **Merge** — who merges the delivered PR | `attested` | `required` · `attested` |

- **`auto`** (shipped default) — the AC proceeds on **its own stated recommendation** rather than
  waiting. It still **posts** the assessment and the plan to the lifecycle host — under `auto` those
  comments are the *only* durable audit trail of what was decided, so posting them becomes more
  load-bearing, not less — and it **names in the posted comment** that it self-selected under `auto`.
  Under `auto` the AC may likewise elect the exploratory (spike-then-plan) path itself, stating its
  rationale in the plan.
- **`required`** — a host may set the **plan-approval** row (and only that row) back to `required`. The
  AC then stops and waits for the HC: it does not proceed past the assessment without a chosen option,
  and it does not write code without an approved plan.
- **Merge — nadal runs `attested`.** `final` posts the SOW and then **may merge, but only on evidence**:
  every *Quality Checks* row green and the required checks green **at the delivered head**, no open
  must-fix findings, an independent external-model adversarial review on record (see *Reviewer*), and
  that review **bound to a literal SHA equal to the PR head**. Any one of those failing means no merge —
  post the SOW, name the condition that failed, and stop. **`auto` remains forbidden** and the parity
  check hard-fails it: unconditional self-merge is the claim [ADR 0025](docs/adr/0025-human-gate-policy-is-a-project-config-value.md)
  refused, and `attested` is not that claim. What makes the difference real rather than semantic is
  *Reviewer* below, which filters the acting harness out of its own review chain and forces
  `stop-and-ask` when no independent review can be obtained — so the AC still cannot certify its own
  work ([ADR 0037](docs/adr/0037-merge-gate-accepts-attested.md)).
- **`attested` does not reach the intake and authoring PRs.** `scout` / `clip` / `follow` / `restock` /
  `create-skill` still end with **a human disposing on the PR** ([ADR 0025](docs/adr/0025-human-gate-policy-is-a-project-config-value.md)
  decision 6, unchanged). Those gates exist for *content judgment*, not code correctness.
- **The harness must also permit it.** Repo policy and agent-runtime permission are independent layers:
  `attested` authorizes the merge, it does not make the runtime allow the command. If the runtime denies
  it, `final` stops and says so rather than treating the denial as a gate failure.

**Unconditional, whatever this section says:**

- **Merge is never unconditional** (above). Under `attested` the AC merges only against a SHA-bound
  external review; there is no setting under which a PR merges on the AC's own say-so.
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

### Rule-suggestion disposition

How [`final`](skills/final/SKILL.md) handles the Rules-Layer / config improvements it learns during
implementation, now that a hands-off run reaches the merge gate on its own
([ADR 0029](docs/adr/0029-baseline-ships-ungated-to-merge.md)). The shipped default is
`autonomous-fold`; the shipped values are `autonomous-fold | present-to-hc`. **nadal sets it to
`log-and-continue`, which is deliberately neither of them** — see *How nadal reads it* below. This is a
**documentary** value — prose, **not** a row in the gate table above (the parser reads a two-row table
and must stay two-row), so a host changes it by editing this paragraph.

- **`autonomous-fold`** (shipped default) — `final` **folds** well-scoped, low-risk Rules-Layer/config
  improvements into the **same PR a human merges**, so the merge gate stays the backstop for them, and
  **defers** large or contentious ones to a follow-up issue recorded in the SOW. The discretion bar:
  well-scoped **and** low-risk → fold; large **or** contentious → defer.
- **`present-to-hc`** — `final` **presents** the suggestions to the HC and waits, editing no Rules
  Layer or config without approval (the pre-ungated behavior).

#### How nadal reads it

**Both branches of `autonomous-fold` are forbidden here, which is why nadal does not run it.** *Fold*
would mean editing the vendored Rules Layer, and this project writes **zero** local rules files
(spec § *Factory model and SDLC*). *Defer to a follow-up issue* is the move
[*Findings-Log Discipline*](#findings-log-discipline) below prohibits outright. That is not theoretical:
[#34](https://github.com/wrburgess/nadal/issues/34) was opened by the `/ship 15` run as exactly such a
Rules-Layer follow-up, and was closed `not planned` and converted back into findings entries in
`59a34c3`. The setting produced the violation, so the setting changes.

**`present-to-hc` is not the answer either, and nadal does not claim it.** That value means `final`
presents the suggestions **and waits**. nadal does not wait: its operating loop states that *nothing
waits on the HC* outside the six enumerated HC steps, so a blocking wait would contradict the same spec
this section enforces.

**So nadal declares a third value: `log-and-continue`.** The findings log **is** this project's
HC-presentation surface — the HC's own enumerated steps include *"triage the findings log at will"*, and
that triage, not `final`, is where a suggestion becomes work.

##### What `final` does at Step 1 under `log-and-continue` — the instruction, not a value to match

**Read this as `final`'s Step 1 procedure for this repo. It replaces both bullets of that step; do not
run either of them.**

1. **On a run that posts a plan, the plan must carry a standing task:** *"append this run's
   process/config learnings to `docs/findings.md`."* This is a **host requirement on the plan the AC
   authors**, and it is declared *here* because this file is where [`devise`](skills/devise/SKILL.md)
   reads its host values. **Stated plainly so it is not mistaken for shipped behavior: the vendored
   `devise` body does not name this task, and nadal cannot add it there** — whoever authors the plan
   includes it because *this line* requires it, exactly as the Step-1 procedure above is the branch
   `final`'s body does not contain. A plan posted without the task is incomplete: add it and re-post
   before implementing, rather than appending later and calling it unplanned.
   **This is deliberately not an exemption:** the append is *inside the approved plan*, so
   [`verify`](skills/verify/SKILL.md)'s normal drift test passes on it **truthfully** — its self-review
   can still assert *"only files in the final approved plan changed"* without that record being false.
   Everything else in the same commit gets the ordinary drift review; nothing is suppressed by
   filename, so an unplanned change cannot ride along beside a findings line.

   **On a run with no plan, the append inherits the authorization the run itself has.** The lifecycle
   expressly permits compressing a **trivial fix** past Plan and a **documentation-only change** past
   both Assess and Plan, and that compression is *the HC's call, not the AC's*. On such a run there is
   no approved plan for **anything** in the diff — not for the findings line and not for the fix it
   accompanies — so `verify` has no plan-alignment baseline to assert against in either direction. The
   findings line is therefore **exactly as sanctioned as the change it rides with, and no more**: it
   claims no exemption the rest of that diff does not already have, and it is not "unplanned drift"
   relative to a plan that does not exist. What a compressed run does **not** change is the
   *disposition*: the learning is still one line in [`docs/findings.md`](docs/findings.md), and still
   never an Issue, PR, rule, or ADR.
2. **Append as you learn** — in the phase that learned it, committed with that phase's own work, rather
   than batched at delivery. This mirrors the durable-as-it-arrives rule
   [`ship`](skills/ship/SKILL.md) already applies to its asks-ledger. **A learning from `assess`,
   `devise`, or the orchestrator has no branch yet**: record it in that stage's durable artifact (the
   assessment or plan comment on the issue, where `ship` already records its stops and asks) and
   transcribe it into `docs/findings.md` in the first phase that has a branch — `invoke`.

   **If the run never reaches `invoke`, that transcription never happens — so the ending is what has to
   carry it.** An emergency stop, an abandoned option, or an issue closed without implementation all
   terminate before any branch exists, and *"it is in an issue comment"* is **not** an acceptable
   terminal disposition: the issue comment is not the triage artifact, and a learning left only there
   fails **open**, silently, which is precisely what *"one findings line, always"* must not permit.
   Before such a run ends it must therefore **name each untranscribed learning in its terminal comment
   under a literal `Untranscribed findings:` heading**, quoting the line it would have written. Any
   later run that reaches `invoke` on that issue transcribes every such block it finds, as part of the
   standing plan task above. **This is the one path on which the line lands late or by the HC's hand,
   and it is labelled rather than hidden** — the label is what turns a silent loss into a visible debt.
3. **At `final` Step 1: append nothing, commit nothing.** Confirm the run's learnings are already in
   the log, and that is the whole step. Fold nothing (edit no Rules Layer, no skill body, no
   `docs/standards/` file — all vendored). File nothing: no Issue, no PR, no ADR. Wait for nothing —
   there is no HC pause here.
4. **Record it in the SOW** where Step 5's *Folded Rule/Config Changes* section expects a fold and a
   deferral: write `Folded: None — nadal runs log-and-continue` and
   `Deferred (follow-up): None — N suggestion(s) appended to docs/findings.md during the run`, so the
   section is answered rather than left blank or filled with a follow-up link.

**What this does *not* claim, because two drafts claimed it and were wrong.** A learning that arrives
**after the Reviewer has responded** — during [`listen`](skills/listen/SKILL.md), or at `final` — moves
the head when it is committed, and [*Human Gates*](#human-gates) → `attested` then requires a fresh
review bound to the new head. **That cost is real and is not avoided by anything on this page.** It is
also not special: it is the standing lifecycle behavior for **any** post-review change, and a `listen`
round that fixes a finding already pays it. A findings line gets **no** distinct mechanism, no exemption
from it, and no promise of a free ride. Appending early is a *preference* that usually avoids the extra
round — not a guarantee that it will.

**And the residual is named rather than papered over.** The lifecycle has no cheap, terminating path for
a durable append that arrives after the PR-gate summons; `verify` owns the summons
([ADR 0026](docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)) and
re-entering it is a full stage, not a summon. **That is a gap in the lifecycle, not something a host
config can legislate**, and trying to legislate it here produced three successive Reviewer findings on
[PR #55](https://github.com/wrburgess/nadal/pull/55) — a delivery-time append that was never committed,
then one that mandated an unowned `verify` re-entry, then a drift exemption that would have made
`verify`'s own self-review untrue. It belongs upstream with the rest of this section, at
[wrburgess/ace#159](https://github.com/wrburgess/ace/issues/159). **This section settles the
*disposition* — where a process learning goes, and where it does not. It does not settle the
*mechanism*, and no longer pretends to.**

**A learning that genuinely arrives during `final` is an ordinary late change**, handled by the rule
this project already runs on: make it, re-run *Quality Checks*, and obtain a fresh SHA-bound review
before merging, because [*Human Gates*](#human-gates) → `attested` requires the review to bind the head
being merged. That is the gate working as designed, not a special re-attestation mode — **and no such
mode is invented here.** Appending per phase is what keeps that case rare.

**If you looked for `log-and-continue` in [`final`](skills/final/SKILL.md) Step 1 and found no matching
branch: that is expected, and it is not a reason to skip the step.** That body is vendored and ships
only the two baseline values, so it cannot name this one. **This block is the branch.** A Reviewer
finding on [PR #55](https://github.com/wrburgess/nadal/pull/55) raised precisely this risk — that an
agent meeting an unrecognized value performs *neither* documented branch and silently does nothing,
which at this step is how the prohibited follow-up got created in the first place. The remedy is that
the disposition is written here as an **imperative procedure** rather than as a token requiring a
matching conditional: there is nothing to match, so there is nothing to fall through.

**Why a new name instead of redefining `present-to-hc`** — this was a Reviewer finding on
[PR #55](https://github.com/wrburgess/nadal/pull/55), and it changed the answer. An earlier draft set
`present-to-hc` and redefined its "and waits" clause, on the reasoning that staying inside the shipped
value set avoided drift. That reasoning was wrong: `final`'s canonical body defines `present-to-hc` as
*present and wait*, so an agent executing `final` would hold **two authoritative, mutually exclusive
meanings for one token** — and the in-set name would make the divergence look like conformance instead
of announcing it. Nothing parses this value (`grep -rn "autonomous-fold" scripts/` → 0), so being
"in the set" bought no mechanical safety at all; it bought only the appearance of it. A token `final`
does **not** recognize forces a reader to this paragraph, which is the correct outcome.

**This value is nadal-local and wants canonicalizing upstream** — the same destination as the rest of
this section, tracked at [wrburgess/ace#159](https://github.com/wrburgess/ace/issues/159) and recorded
in [`docs/ace-sync-manifest.md`](docs/ace-sync-manifest.md). Until an upstream value exists, the
divergence is stated here in the open rather than hidden inside a redefined word. Everything else the
shipped values require — **edit no Rules Layer or config without approval** — holds unchanged, and that
is the part doing the work.

This value governs only `final`'s rule-suggestion step. It does **not** touch the intake/authoring
"a human disposes" gates — [`scout`](skills/scout/SKILL.md), [`clip`](skills/clip/SKILL.md),
[`follow`](skills/follow/SKILL.md), [`restock`](skills/restock/SKILL.md),
[`create-skill`](skills/create-skill/SKILL.md) — whose review PRs a human still disposes.

## Findings-Log Discipline

Where an **operational or process learning** goes in nadal, and — more importantly — where it does
**not**. This is a Project Config value in the same sense as *Human Gates* above: the spec
(§ *Factory model and SDLC*) is its origin, and this is the copy an agent actually reaches, since the
instruction chain is `CLAUDE.md` → [`AGENTS.md`](AGENTS.md) → this file and reaches no spec directory.

**The artifact** is [`docs/findings.md`](docs/findings.md) — append-only, one line per finding. Its
header states the line format and the type vocabulary; read the format there rather than from a second
copy here, so the two cannot drift.

**The disposition set is `do-now` / `upstream-to-ace` / `drop`, and only the HC applies one.** Findings
become work **only** at an explicit HC-triggered triage session — one of the HC's own enumerated steps
is *"triage the findings log at will."*

> **No Issues, PRs, rules, or ADRs spawn directly from findings.**

That sentence is the rule. An agent that has just learned something process-shaped writes **one line**
and continues.

### Precedence — this overrides four instructions that say otherwise

The instruction chain does not merely omit the rule above; in four places it **directs the opposite** —
and each sits where an agent is standing at the moment it decides. All four are **vendored** — nadal
never edits `rules/`, `skills/`, or `docs/standards/` — so they are overridden here, from the host's own
config layer, which is what that layer exists for. For a **process/operational** finding in nadal, none
of the following applies:

| Vendored instruction | What it says | Here |
|---|---|---|
| [`rules/self-review.md`](rules/self-review.md) → *Anti-Patterns* (Tier-1 Lean Core, resident on every run) | *"promote it now … or open a tracked enforcement issue"* | **Does not apply.** Write the findings line. |
| [`rules/self-review.md`](rules/self-review.md) → the **asks-ledger**, stated three times (Patterns, Checklist, Anti-Patterns), and executable in [`ship`](skills/ship/SKILL.md)'s `asks_ledger` contract as `status: "handed-off"` with a `ref` | *"each one is either delivered or **handed to a tracked follow-up**"* | **The findings line IS delivery.** For a process/operational learning the log is the correct terminal destination, so such an ask closes as `delivered` with the findings line as its `ref` — never as `handed-off` to an Issue. The asks-ledger rule is not weakened: nothing may be silently dropped. |
| [`final`](skills/final/SKILL.md) Step 1 (executed at every delivery) | *"defer the large or contentious ones to a tracked follow-up issue"* | **Does not apply.** See *Rule-suggestion disposition* above — nadal runs `log-and-continue`. |
| [`scout`](skills/scout/SKILL.md) / the Learnings Log — the only logging pattern the Config Bundle ships | a logged entry carries a `stance` + `touches` and `scout` **opens a PR** proposing Rules/Skills/ADR changes | **A different artifact.** The Learnings Log folds *external* field voices and is meant to open PRs; [`docs/findings.md`](docs/findings.md) records the AC's *own* operational experience and is meant to open nothing. Do not carry the reflex across. |

Two of these are easy to miss for opposite reasons. The **last** row is the trained reflex: the only
logging pattern the bundle ships has the opposite disposition, so an agent pattern-matching on "I
learned something, I should log it" lands on "…and open a PR." The **second** row is the completion
rule: it fires at the moment an agent is trying to *finish*, and "handed to a tracked follow-up" reads
as the responsible option precisely when dropping something feels like the alternative. Naming the
findings line as **delivery** removes that pressure — there is no third state to be anxious about.

### What this does not cover — and how to tell

The override is scoped to **process/operational findings**. It is not a rule against filing work, and it
never withholds a work path from something that is **broken**. Ask the two questions in order:

| Ask, in this order | Disposition |
|---|---|
| **1. Is something broken** — does it not work as it must? This covers nadal the product (schema, CLI, parsers, queries, reports, MCP surface, its data) **and the repo's own infrastructure** (CI workflows, `scripts/`, git hooks, a config value that does not do what it says). | **It is a defect, and defects get fixed.** Fix it in the running PR when the fix is in hand (the standing fold rule); a tracked Issue when it is not. Filing that Issue is **correct**, not a violation — nothing on this page forbids it. |
| **2. Otherwise — is it a learning, or a proposal about how agents should work?** Process, rules, config, skills, the lifecycle, review practice, tooling discipline. | **One findings line. Always** — including when the learning arose *from* a bug, and including when you are certain the proposal is right. |
| **Both** (a real defect that also taught a lesson — the common case) | **Split it.** The fix is work; the lesson is a line. If they genuinely cannot be separated, the fix is still work and the lesson **still** goes to the log. |

Question 1 comes first deliberately. Asking "is this process-shaped?" first is what would strand a
broken CI workflow or a broken script in a log that nothing spawns from — the rule is about
**learnings and proposals**, never about things that are simply broken. "Being process-shaped" is not a
reason to leave something broken, and a defect does not become a findings line by being located in the
toolchain.

This is how the log has actually been kept, which is the check on the rule rather than a restatement of
it: measured at `03c577d`, `bug` is the **largest single type** in
[`docs/findings.md`](docs/findings.md) — **95 of 222 entries**, a plurality rather than a majority —
and those are overwhelmingly defects **fixed in the run that found them**, whose *lesson* was then
logged. A `bug` type on a findings line is not an instruction to file an Issue, and nothing here changes
that.

The **HC may promote** any finding at triage — that is the `do-now` disposition, and it is the only path
from this log to tracked work. [#35](https://github.com/wrburgess/nadal/issues/35) is itself an
instance: opened at explicit HC direction, and therefore **not precedent** for an agent doing the same.

### The limits of this statement, stated plainly

**Nothing in *Quality Checks* parses this section.** Stated exactly, since a limit stated loosely is the
failure this whole section is about: `scripts/parity_check.rb` asserts structure — the required `##`
sections, skill frontmatter, resolvable links, and the gate/reviewer **values**. It does read a little
prose, but only three fixed patterns: any heading advertising itself as unenforceable (this file's
headings included), and whether a skill body names the `Human Gates` and *Reviewer* host values. None of
that reads the rule stated here.

Nor could a check fully replace it, though **the honest answer is "partly", not "no"**: of the four
banned spawn targets, a new file under `rules/` or a new ADR would leave an in-repo trace a check
*could* catch — but an **Issue** and a **PR** live on GitHub, and the decision that produces them lives
in an agent's judgment, so the two targets that have actually been violated are the two nothing in the
tree can see. That asymmetry is why a mechanical check is logged in
[`docs/findings.md`](docs/findings.md) as a real idea worth triage rather than dismissed — and also why
it was not shipped as *this* rule's remedy, since it would have gone green against every violation on
record.

This section's force therefore comes from being read, not from being checked; do not mistake it for a
guardrail. What it removes is the **conflicting instruction** an agent was previously following, which
is the failure the record actually shows: #34 was created by an agent obeying the `autonomous-fold`
setting, not by one that had failed to find this rule.

The canonical fix is upstream — [wrburgess/ace#159](https://github.com/wrburgess/ace/issues/159), which
names the process-findings log in the Config Bundle and enforces its disposition discipline. When it
lands and is re-synced, **this section collapses into the canonical statement rather than drifting from
it**; the re-vendor obligation is recorded in [`docs/ace-sync-manifest.md`](docs/ace-sync-manifest.md)
under *Known local deltas*, which is where a re-sync reconciler looks.

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
