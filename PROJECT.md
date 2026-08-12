# PROJECT.md — Project Config

The **Project Config**: the one place a Host App declares its host-specific values so the Skills and
[Canonical Source](AGENTS.md) stay generic. A vendoring Host App edits the values in this file; it
does not edit `AGENTS.md` to change them. This file ships with **business-neutral placeholders** —
replace them during Customization.

> The ace-era parity check that asserted this file's section headings left with the deuce cutover
> (deuce [#86](https://github.com/wrburgess/deuce/issues/86)); the headings are kept for their
> readers, not for a checker. This host's declarations migrate to its own `config/` as adoption
> work — until then, this file remains where they are read.

## Quality Checks

**Moved. The gate's contents are [`config/checks.md`](config/checks.md), and the gate is
`npm run gate`** (#146).

This section used to carry a four-row table that `.github/workflows/ci.yml` restated in its own
steps and again in a comment block mapping one to the other — three hand-maintained lists agreeing
by convention. Two are now pointers, and `tools/gate/run.ts` executes exactly what the declaration
holds, in the order it holds it, so the list a reader sees and the list that runs are the same list.
Add or remove a check there; there is no second place to edit.

What the declaration's body carries, so it is not looked for here: the five rows and what each
covers, why every command is an `npm run` form, the coverage floor and the honest limit of what it
now asserts, why `requires` reports rather than repairs, and the three exit codes.
[`docs/runbooks/quality-gate.md`](docs/runbooks/quality-gate.md) is the operator's copy.

A check whose command runs but has nothing applicable to inspect (e.g. no application code to lint) is
reported `pass`/`not_run` with a stated reason — checks are **not applicable, not skipped**, so rigor
is unchanged.

## Attribution & Model Declaration

Single source of truth for agent attribution ([ADR 0007](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0007-attribution-includes-model-version-for-audits.md)).
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
  [ADR 0024](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0024-harness-model-naming-convention.md). Copilot's backing model is
  variable/unknown, so its declared model reads `model varies (GPT / Claude / Gemini)`.

## Branch & PR Policy

- **Protected branches:** `main` — this backticked list (everything up to the
  em dash) is the **authored source** the guardrails derive from. Never commit or push directly to a
  protected branch; agents work on feature branches. A host may trim or extend the backticked list,
  then run `bin/install-git-hooks` to regenerate the derived sidecar `.githooks/protected-branches`.
  Enforcement (git hooks + per-tool fast-fail) is delivered by the guardrails baseline
  ([ADR 0009](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0009-defense-in-depth-branch-protection-all-agents.md)) and sources this list.
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

  Why this is safe here, checked rather than assumed (2026-07-31; protection fact updated
  2026-08-11): nothing requires signed commits — `main`'s branch protection (enabled at the deuce
  cutover: pull requests only, zero required approvals, admins included) carries **no signed-commits
  requirement**; feature-branch signatures **do not verify on GitHub
  anyway** (the key is not registered as a *signing* key on the account, so the API reports
  `verified: false, reason: unknown_key`); and squash-merge discards those commits, replacing them with
  a merge commit GitHub signs itself (`verified: true`, `reason: valid`). So an unsigned feature commit
  costs no verifiable provenance that a signed one was providing.

  **This rule expires the moment any of those three facts changes** — if `main` gains a signed-commits
  requirement, if the signing key is registered on the account, or if the merge strategy stops squashing,
  re-derive it rather than carrying it forward.

## Review Severity Framework

Generic starter severities for the lifecycle's Verify and Deliver stages and human review. A Host
App tunes the definitions.

| Severity | Meaning | Disposition |
|----------|---------|-------------|
| **Critical** | Data loss, security hole, breaks protected-branch or auth invariants, or ships broken. | Block merge; fix before proceeding. |
| **High** | Correctness bug, missing required test, or a violated project rule. | Fix in this PR before merge. |
| **Medium** | Maintainability, clarity, or a smaller coverage gap. | Fix now or file a tracked follow-up. |
| **Low** | Style, naming, or optional polish. | Author's discretion. |

**"File a tracked follow-up" applies to a *defect*, never to a process learning.** The Medium row is
written for code, and for code it is correct. A Medium finding that is a *learning or a proposal about
how agents work* takes the [*Findings-Log Discipline*](#findings-log-discipline) path instead — one
findings line — because filing it is the exact move that section prohibits. Apply that section's
two-question test before reading this column: **is something broken?** first, *then* is it a learning.

**Severity is orthogonal to [*Review Lenses*](#review-lenses).** A lens decides *what a pass looks
for*; severity decides *what happens to what it finds*. A finding surfaced outside the declared lens
set is not thereby downgraded — the permanent *what class is not on this list?* lens exists precisely
to surface it, and it is severity-rated like any other.

## Lifecycle Host

- **Host platform:** `GitHub` (default). The issue/PR verbs the Skills use are isolated so a Host App
  on another platform (e.g. GitLab) can remap the artifact targets without rewriting skill bodies
  ([ADR 0006](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)).
- **Artifact map:** assessments/plans → issue comments; implementation → a PR; SOW → a PR comment.

## Reviewer

The **independent second-model Reviewer** the lifecycle summons at the plan and PR gates — declared
here so a generic Skill body names the *role* while the host names the *identity*
([ADR 0026](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md), the same
argument shape as the lifecycle host in [ADR 0006](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)
and the gate policy in [ADR 0025](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0025-human-gate-policy-is-a-project-config-value.md)).
The chain settings ship as **business-neutral placeholders** a Host App replaces with its real
reviewer during Customization; the *Invocation paths* Codex row below is the one exception — it
carries **this repo's real mechanism** ([ADR 0035](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0035-codex-summons-is-the-local-cli-runtime.md)),
which hosts likewise replace.

> **Nothing in this section is mechanically enforced, and five of its sentences used to say
> otherwise** (#146) — this note replaces one of them; the other four are corrected where they
> stand. Every claim that "the parity check" reports, reddens, or hard-fails something
> here described `scripts/parity_check.rb`, which retired at the deuce cutover
> (deuce [#86](https://github.com/wrburgess/deuce/issues/86)); the two Ruby readers it called —
> `scripts/reviewer.rb` and `scripts/human_gates.rb` — had no other caller and were deleted on
> #146. **The live values are now [`config/review.md`](config/review.md)**, which
> [`tools/review/roster.ts`](tools/review/roster.ts) and
> [`tools/review/lenses.ts`](tools/review/lenses.ts) actually parse. What survives below is the
> *reasoning* — kept because it is good, and because a host reading it should know which parts a
> machine checks. The answer is: the roster's shape, and nothing else.

| Field | Setting | Allowed values |
|-------|---------|----------------|
| **Primary** — the reviewer summoned first | `Codex` | any harness with a row in *Invocation paths* |
| **Fallback order** — tried in turn when the primary is unreachable or silent | `none` | comma-separated harnesses each with an *Invocation paths* row, or `none` alone; no blank elements and no repeat of *Primary*. Author the whole list inside **ONE pair of backticks** (`Copilot, Gemini`) — never one span per element, since the checker reads only the first span |
| **Bounded window** — how long to wait for a response before falling back | `30m` | `<integer><unit>`, unit one of `s` · `m` · `h` |
| **Degradation floor** — what happens when the whole chain is exhausted | `stop-and-ask` | `stop-and-ask` (not configurable) |

- **The degradation floor is not configurable.** `stop-and-ask` is its only allowed value, on the
  same footing as merge: a run that cannot obtain an
  independent review must not be able to certify itself. The AC stops and asks the HC — it never
  delivers unreviewed with a footnote ([ADR 0026](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
  decision 3, affirming [ADR 0005](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)).
- **The acting harness is excluded from the chain before any summons.** An AC is never its own
  independent backstop — a same-model review that *appears* to run is worse than none — so the harness a
  run is executing *as* is filtered out of *Primary* + *Fallback order* before the window opens.
  **This is discipline, not a control, and this line used to claim the opposite**: it cited
  `scripts/reviewer.rb` → `independent_chain` as "the runtime sibling" enforcing it, and nothing has
  called that script since the cutover — it is deleted as of #146. What actually holds the property
  today is arithmetic: [`config/review.md`](config/review.md)'s roster has exactly one entry, Codex,
  and nadal's ACs are Claude harnesses, so the chain cannot contain the acting harness. Add a second
  roster row and this becomes an unchecked assertion again. It is in any case a **harness-level**
  guard: it catches a same-harness
  reviewer and does **not** catch two harnesses serving the same model
  ([ADR 0027](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0027-reviewer-chain-validated-against-invocation-paths.md) decision 7 records why
  the rest is unverifiable from a static declaration). If the exclusion empties the chain, the run is at
  the exhausted-chain floor — `stop-and-ask`.
- **With `Fallback order: none`, that exclusion is unconditional whenever Codex is the acting
  harness** — `chain` is just `[Codex]`, so `independent_chain` always empties it, and every
  Codex-run `implement`/`verify` would hit `stop-and-ask` with no other entry to try (a Codex reviewer
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
  ([ADR 0029](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0029-baseline-ships-ungated-to-merge.md)), and under `auto` nobody is at the plan
  gate, so the plan-gate summons has no owner or mechanism yet; that residual risk is tracked in
  [#129](https://github.com/wrburgess/ace/issues/129), and
  [ADR 0026](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
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
**unreachable**, and `verify` falls straight past it rather than
starting a window ([ADR 0027](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0027-reviewer-chain-validated-against-invocation-paths.md)).
Nothing reports the mismatch — the reader of this table is the check.
The Codex row names **this repo's real mechanism**, not a neutral placeholder
([ADR 0035](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0035-codex-summons-is-the-local-cli-runtime.md)); a Host App replaces these rows
with its real commands during Customization.

The **Check** cell is **optional** — host-supplied wherever the baseline declares none — narrowly
superseding [ADR 0026](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
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
([ADR 0035](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0035-codex-summons-is-the-local-cli-runtime.md), narrowly superseding
ADR 0027 decision 4 for that row only). The Copilot check *is* the summons — it cannot precede one
without a side effect — so that row's Check stays host-supplied.

**The first column is the harness name, by contract.** A host may rename, add, drop or reorder every
column *after* it — the mechanism column is found by its `Summons` header, falling back to the second
column when no header names it — but the harness label must stay leftmost, because it is read
positionally. Moving it fails closed rather than silently: the real harness name is never seen, so
every chain entry reads as unreachable — which stops a run rather than mis-routing one. Note that
this is *this table's* contract and no longer the one a tool reads; the roster
[`tools/review/roster.ts`](tools/review/roster.ts) parses is
[`config/review.md`](config/review.md)'s, and its first-column-is-the-name reading is pinned there by
`roster.test.ts`'s live-declaration assertion.

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

## Review Lenses

**How deep a solicited review goes, and when it stops.** The canonical mechanism is proposed upstream
at [wrburgess/ace#161](https://github.com/wrburgess/ace/issues/161); until it lands this section is the
host-local statement, and it **overrides** the unbounded adversarial pass the vendored
[`verify`](skills/verify/SKILL.md) body describes (see the precedence table under
[*Findings-Log Discipline*](#precedence--this-overrides-five-instructions-that-say-otherwise)).

> **The values moved; the reasoning stayed** (#146). The lens menu, the lens-set size and the
> fix-verification bound are now **[`config/review.md`](config/review.md)**, where
> [`tools/review/lenses.ts`](tools/review/lenses.ts) parses them — a lens off the menu is refused at
> dispatch rather than by a reader noticing. Two things to know before reading on: the menu is
> stated there as **questions**, which a test enforces; and the range below collapses to the
> parser's single number, **3**. Where this section and the declaration differ, the declaration is
> the source.

**Two kinds of discovery, one of them bounded.** *Solicited* discovery is commissioned — Stage 4's
adversarial pass, the Reviewer's response, every re-summons after a fix — and if it is not bounded it
does not terminate. *Unsolicited* discovery is something noticed while doing other work; it is routed,
**never capped**, and it is empirically the higher-yield of the two.

### The bound is a lens set, not a round count

A **lens** is one named question a pass asks. A **lens set** is the selection declared **at the
summons**, chosen for what the change touches. Each lens runs once; repeating a lens that returned
clean requires the HC.

Round counts are the wrong bound: across seven nadal PRs, value in a late pass came from asking a
*different* question and cost came from *repeating* one. The one pass given an explicit threat model
converged at one finding, then zero.

**Lens-set size: 3 per summons, plus the permanent lens** — declared in
[`config/review.md`](config/review.md), which `parseLensSetSize` reads as one number. This paragraph
said "3–4" while nothing parsed it; the declaration takes the lower bound. This is a menu, not a
checklist —
running every lens on every change rebuilds the unbounded pass in a new costume.

| Lens | Asks |
|---|---|
| **Guard completeness** | Does this guard *enumerate* cases, or *derive* from structure? |
| **Key identity** | Can two different facts collide on one key, or one fact split into two? |
| **Fail-open** | Does the error path do something weaker than the happy path? |
| **Reachability** | Has this code ever executed? Is a produced field ever read? |
| **Claim vs code** | Does any comment, test title, doc or PR sentence assert more than the code enforces? |
| **Concurrency** | Two processes, not two threads — check-then-act across a WAL database. |
| **What class is not on this list?** | **Permanent — always included.** |

The first six are **derived from nadal's own recorded defect classes**, not from a generic catalogue,
and they are a starting set to be revised as the record changes. The seventh is not optional: a menu
necessarily enumerates the defects already known, and a pass that keeps returning one class is not
evidence that other classes are absent.

### Fix-verification is bounded separately

Code written in response to review findings is the least-reviewed code in the change — authored *after*
the pass that would have caught it. It gets **two verification passes**, not the lens set — declared
in [`config/review.md`](config/review.md) → *Fix-verification*, and load-bearing at the Ship gate:
[`config/gates.md`](config/gates.md) makes a second must-fix wave the point at which the run stops
and hands to the HC.

**Escalate on recurrence rather than iterate.** If a fix-verification pass finds a defect *in the
fixes themselves* beyond that limit, the design is wrong and the AC stops and says so. Nine recorded
instances in this repo show patching past that point moving the same defect one step sideways rather
than closing it.

### What a PR is for

Projected here from spec § *Factory model and SDLC*, which states it and which **the instruction chain
never reaches**:

> **PRs must advance Springfield or fix defects. Everything else is a findings line.**

Correctness work that does not move the destination closer is triaged, not folded — however correct it
is. This is the same rule as *bugs we fix, optimizations we triage*, one level up.

## Human Gates

Which lifecycle pauses require a human, declared here so a generic Skill body names the *gate* instead
of hardcoding a policy a host would otherwise have to fork the file to change
([ADR 0025](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0025-human-gate-policy-is-a-project-config-value.md), the same argument shape as
the host-platform value in [ADR 0006](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)).
The Generic Baseline now ships **ungated to merge**: plan approval is `auto`, so a hands-off run drives
itself to the one standing human gate, and every Skill body states that default inline
([ADR 0029](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0029-baseline-ships-ungated-to-merge.md)). **The baseline ships merge `required`**;
**nadal sets it to `attested`** — the AC merges the delivered PR, but only against an independent
external-model adversarial review bound to the SHA being merged
([ADR 0037](https://github.com/wrburgess/ace/blob/8faa6a5e39e6ace4d436513cf16a9238a08c351b/docs/adr/0037-merge-gate-accepts-attested.md)). (A vendored `PROJECT.md` that predates this
section still parses to the strict fail-safe — plan approval `required`, merge `required` — through the
parser default; the flip lives in the shipped file, not in that default.)

**Moved. The two settings are [`config/gates.md`](config/gates.md)** (#146) — Direction gate
`delegated` (this section's plan approval `auto`, in deuce's vocabulary) and Ship gate `attested`.
The table below is kept for its reasoning, not as the source; where the two differ,
`config/gates.md` is authoritative and carries the date and the decision it came from.

| Gate | Setting | Allowed values |
|------|---------|----------------|
| **Plan approval** — covers both the Stage-1 option pick and the Stage-2 plan approval | `auto` → `config/gates.md` | `required` · `auto` |
| **Merge** — who merges the delivered PR | `attested` → `config/gates.md` | `required` · `attested` |

- **`auto`** (shipped default) — the AC proceeds on **its own stated recommendation** rather than
  waiting. It still **posts** the assessment and the plan to the lifecycle host — under `auto` those
  comments are the *only* durable audit trail of what was decided, so posting them becomes more
  load-bearing, not less — and it **names in the posted comment** that it self-selected under `auto`.
  Under `auto` the AC may likewise elect the exploratory (spike-then-plan) path itself, stating its
  rationale in the plan.
- **`required`** — a host may set the **plan-approval** row (and only that row) back to `required`. The
  AC then stops and waits for the HC: it does not proceed past the assessment without a chosen option,
  and it does not write code without an approved plan.
- **Merge — nadal runs `attested`, and it now reaches.** [`deliver`](skills/deliver/SKILL.md)
  (Stage 5; `final` was its ace-era name and left with the cutover) posts the Delivery Record and
  then **may merge, but only on evidence**: every gate check green **at the delivered head**, no open
  must-fix findings, an independent external-model adversarial review on record (see *Reviewer*), and
  that review **bound to a literal SHA equal to the PR head**. Any one of those failing means no
  merge — post the Delivery Record, name the condition that failed, and stop.

  **The fourth condition used to be unsatisfiable, and the reason is worth keeping** (#150 / PR #151).
  [`verify`](skills/verify/SKILL.md) step 10 disposes of review findings in one fix wave and states
  that **the reviewer is never re-summoned**. A fix wave moves the head. So on any pull request whose
  review finds anything, the review is bound to a SHA that is no longer the head, and this section
  concluded that every merge here must be HC-performed.

  **The HC's ruling on [#146](https://github.com/wrburgess/nadal/issues/146) removes the HC merge
  gate, so the machinery exists instead — it is
  [`config/gates.md`](config/gates.md) → *How the binding is re-established*.** In one line: *never
  re-summoned* bounds one **pass** of Verify, and when the wave moves the head that pass is over; a
  must-fix wave therefore costs a second summons on the new head, and a second must-fix wave stops
  and hands to the HC. Read the gate declaration for the full table — it is the source, and this is
  a pointer to it. **`auto` remains forbidden**: unconditional self-merge is the claim
  [ADR 0025](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0025-human-gate-policy-is-a-project-config-value.md)
  refused, and `attested` is not that claim
  ([ADR 0037](https://github.com/wrburgess/ace/blob/8faa6a5e39e6ace4d436513cf16a9238a08c351b/docs/adr/0037-merge-gate-accepts-attested.md)).
- **`attested` does not reach the intake and authoring PRs.** `scout` / `clip` / `follow` / `restock` /
  `create-skill` still end with **a human disposing on the PR** ([ADR 0025](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0025-human-gate-policy-is-a-project-config-value.md)
  decision 6, unchanged). Those gates exist for *content judgment*, not code correctness.
- **The harness must also permit it.** Repo policy and agent-runtime permission are independent layers:
  `attested` authorizes the merge, it does not make the runtime allow the command. If the runtime denies
  it, [`deliver`](skills/deliver/SKILL.md) stops and says so rather than treating the denial as a gate
  failure.

**Unconditional, whatever this section says:**

- **Merge is never unconditional** (above). Under `attested` the AC merges only against a SHA-bound
  external review; there is no setting under which a PR merges on the AC's own say-so.
- **The plan gate is also a context boundary, and the reset survives the pause being waived.**
  "Plan posted" forces a context reset under either setting — a session boundary under `required` (the
  human crosses), and under `auto` the reset the retired `ship` orchestrator performed
  ([ADR 0028](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md)).
  What carries the firebreak now is the stage itself: [`implement`](skills/implement/SKILL.md)
  (Stage 3; `invoke` was its ace-era name) **begins by re-reading the posted Plan from the issue** and
  never continues on conversational memory, and [`deliver`](skills/deliver/SKILL.md) likewise begins by
  re-reading the pull request. `auto` removes the *wait*; it never removes the context firebreak.
- **The four standing stops** — an unresolvable check failure; a discovery that the change touches core
  logic the Plan did not anticipate; an architectural or ambiguous review comment; a verdict the run
  cannot resolve — always stop and ask the HC. These were `ship`'s emergency stops while an
  orchestrator existed; under deuce every skill carries them directly, as
  [Chapter 1 → Stops](https://github.com/wrburgess/deuce/blob/main/sds/01-lifecycle-and-skills.md#stops).
- **The lifecycle's "the HC decides when to compress"** remains mandatory for every row of its
  *When to skip or compress stages* table **but one**: `auto` waives exactly three pauses — the Stage-1
  option pick, the Stage-2 plan approval, and the **exploratory (spike-then-plan) election** named
  above, which chooses *how to plan* rather than skipping a stage. The trivial-fix, bug-fix,
  documentation-only and large-change rows each compress away a *stage* and stay the HC's call.
- **The intake and authoring "a human disposes" gates** — [`scout`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/scout/SKILL.md),
  [`clip`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/clip/SKILL.md), [`follow`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/follow/SKILL.md),
  [`restock`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/restock/SKILL.md), [`create-skill`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/create-skill/SKILL.md)
  ([ADR 0014](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0014-manual-drop-inbox-for-unfetchable-sources.md),
  [ADR 0016](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0016-interactive-sequential-disposition-scout.md)) — are out of scope too.
  `auto` is **not** licence to auto-merge any of their review PRs.

### Rule-suggestion disposition

> **The mechanism this section governs no longer exists, and the section is left standing rather than
> guessed at** (#150 / PR #151). Every rule below is addressed to ace `final`'s **Step 1**, its
> rule-suggestion step. [`deliver`](skills/deliver/SKILL.md) — deuce's Stage 5, which replaced `final`
> — **has no such step**: its nine-step procedure reads the PR and issue, re-confirms the checks,
> writes the Delivery Record, and acts on the Ship gate. Nothing in it learns or disposes of
> Rules-Layer suggestions.
>
> So this is not stale naming that a rename would fix. Deciding what `log-and-continue` *means* with
> no Step 1 to attach it to — whether the value retires with the mechanism, or moves onto a stage that
> never had it — is a governance choice belonging to
> [#154](https://github.com/wrburgess/nadal/issues/154), not to a feature PR. **Read the passages
> below as addressed to a step that is not currently run.** The exception is the numbered
> findings-log discipline inside *What `final` does at Step 1*, which
> [*Findings-Log Discipline*](#findings-log-discipline) still depends on and which remains live — the
> two are interleaved here, which is what #154 has to separate.
>
> **This banner used to name [#146](https://github.com/wrburgess/nadal/issues/146).** That issue
> declined the work on its own thread and re-pointed here rather than closing over a live reference —
> a 165-line deletion in this file's most argued section did not belong in a config-migration pull
> request, and the interleaving above is exactly why it needs its own assessment.

How ace `final` handled the Rules-Layer / config improvements it learned during
implementation, now that a hands-off run reaches the merge gate on its own
([ADR 0029](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0029-baseline-ships-ungated-to-merge.md)). The shipped default is
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
`59a34c3`. The setting produced the violation, so the setting changes. (`/ship` was the ace-era
orchestrator, retired at the deuce cutover — named here as the history it is, not as a command to run.)

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
2. **Append as you learn** — in the stage that learned it, committed with that stage's own work, rather
   than batched at delivery. This mirrors the durable-as-it-arrives rule the retired `ship`
   orchestrator applied to its asks-ledger. **A learning from [`assess`](skills/assess/SKILL.md) or
   [`devise`](skills/devise/SKILL.md) has no branch yet**: record it in that stage's durable artifact —
   the Assessment or Plan comment on the issue, which is also where a stop and its answer are recorded
   — and transcribe it into `docs/findings.md` in the first stage that has a branch,
   [`implement`](skills/implement/SKILL.md).

   **A learning is only safe once it is on `main`, and two endings prevent that.** Committing the line
   with its phase is not sufficient on its own:

   - **The run never reaches `invoke`** — an emergency stop, an abandoned option, an issue closed
     without implementation. No branch ever exists.
   - **The run reaches `invoke`, but its PR is closed unmerged** — the branch is discarded, and with it
     every findings line committed onto it. (This PR would demonstrate it: closing it unmerged would
     throw away all of its own entries.)

   In both, *"it is in an issue comment"* or *"it was committed on the branch"* is **not** an
   acceptable terminal disposition: neither is the triage artifact, and a learning left in either fails
   **open**, silently — precisely what *"one findings line, always"* must not permit.

   **So whoever ends the run — stopping it, or closing the PR unmerged — must post a block headed with
   the literal string `Untranscribed findings:`, quoting each line that would have been written, as a
   comment on the issue.** On the **issue**, always, even when a closed PR is what triggered it: a
   closed PR is not where the next run will look.

   That single canonical location makes discovery **deterministic rather than lucky**, which is the
   other half of the requirement: **the next run that reaches `invoke` on that issue reads the issue's
   comments for `Untranscribed findings:` blocks and transcribes every one not already in
   [`docs/findings.md`](docs/findings.md)**, as part of the standing plan task above. That is the whole
   search scope — no other is implied, and none is needed. **This is the one path on which a line lands
   late or by the HC's hand, and it is labelled rather than hidden**: the label is what turns a silent
   loss into a visible debt.
3. **At `final` Step 1: append nothing, commit nothing.** Confirm the run's learnings are already in
   the log, and that is the whole step. Fold nothing (edit no Rules Layer, no skill body, no
   `docs/standards/` file — all vendored). File nothing: no Issue, no PR, no ADR. Wait for nothing —
   there is no HC pause here.
4. **Record it in the SOW** where Step 5's *Folded Rule/Config Changes* section expects a fold and a
   deferral: write `Folded: None — nadal runs log-and-continue` and
   `Deferred (follow-up): None — N suggestion(s) appended to docs/findings.md during the run`, so the
   section is answered rather than left blank or filled with a follow-up link.

**What this does *not* claim, because two drafts claimed it and were wrong.** A learning that arrives
**after the Reviewer has responded** — during [`listen`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/listen/SKILL.md), or at `final` — moves
the head when it is committed, and [*Human Gates*](#human-gates) → `attested` then requires a fresh
review bound to the new head. **That cost is real and is not avoided by anything on this page.** It is
also not special: it is the standing lifecycle behavior for **any** post-review change, and a `listen`
round that fixes a finding already pays it. A findings line gets **no** distinct mechanism, no exemption
from it, and no promise of a free ride. Appending early is a *preference* that usually avoids the extra
round — not a guarantee that it will.

**And the residual is named rather than papered over.** The lifecycle has no cheap, terminating path for
a durable append that arrives after the PR-gate summons; `verify` owns the summons
([ADR 0026](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)) and
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

**If you looked for `log-and-continue` in [`final`](https://github.com/wrburgess/nadal/blob/0e9ff24b424ef2ba6ac813ff3acc88b850a907d0/skills/final/SKILL.md) Step 1 and found no matching
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
in [`docs/ace-sync-manifest.md`](https://github.com/wrburgess/nadal/blob/0e9ff24b424ef2ba6ac813ff3acc88b850a907d0/docs/ace-sync-manifest.md). Until an upstream value exists, the
divergence is stated here in the open rather than hidden inside a redefined word. Everything else the
shipped values require — **edit no Rules Layer or config without approval** — holds unchanged, and that
is the part doing the work.

This value governs only `final`'s rule-suggestion step. It does **not** touch the intake/authoring
"a human disposes" gates — [`scout`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/scout/SKILL.md), [`clip`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/clip/SKILL.md),
[`follow`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/follow/SKILL.md), [`restock`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/restock/SKILL.md),
[`create-skill`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/create-skill/SKILL.md) — whose review PRs a human still disposes.

## Findings-Log Discipline

Where an **operational or process learning** goes in nadal, and — more importantly — where it does
**not**. This is a Project Config value in the same sense as *Human Gates* above: the spec
(§ *Factory model and SDLC*) is its origin, and this is the copy an agent actually reaches, since the
instruction chain is `CLAUDE.md` → this file and reaches no spec directory (since the deuce cutover,
[`AGENTS.md`](AGENTS.md) is the contractor-reviewer contract, not the AC's instruction source).

**The artifact** is [`docs/findings.md`](docs/findings.md) — append-only, one line per finding. Its
header states the line format and the type + state vocabularies; read them there rather than from a
second copy here, so the two cannot drift.

**The disposition set is `do-now` / `upstream-to-ace` / `drop`, and only the HC applies one.** Findings
become work **only** at an explicit HC-triggered triage session — one of the HC's own enumerated steps
is *"triage the findings log at will."*

> **No Issues, PRs, rules, or ADRs spawn directly from findings.**

That sentence is the rule. An agent that has just learned something process-shaped writes **one line**
and continues.

### Two axes, and where each state lives

Every finding carries **two independent facts**, and recording only the first is the failure mode.
**Type** answers *what kind of thing is it*; **state** answers *what happens to it next*. Read by type
alone, a log whose entries are overwhelmingly defects already fixed in the run that found them is
indistinguishable from a backlog of that many open defects — and the format conforms perfectly the
whole time. State is what separates the archive from the work.

| State | Meaning | Lives in |
|---|---|---|
| `closed` | Resolved in the run that found it, or a lesson needing no action | `docs/findings.md` — nothing moves |
| `open` | Live work, not yet done | a GitHub Issue, label `docket` + its type label; milestone `Springfield v1` only if it must be true before the date |
| `accepted` | A real limitation, decided against on the record | a **closed** GitHub Issue, label `residual` |

**The flow is one-way.** `accepted` is terminal: its whole purpose is that the same residual is not
re-litigated on a later pass. Check it before raising anything that sounds familiar —
`gh issue list --state closed --label residual`.

Storing `open` findings as Issues is **not** a violation of the rule above: promotion at a triage pass
*is* the `do-now` disposition, and the HC applies it. What the rule forbids is an agent spawning one
mid-run. [#30](https://github.com/wrburgess/nadal/issues/30),
[#34](https://github.com/wrburgess/nadal/issues/34) and
[#43](https://github.com/wrburgess/nadal/issues/43) failed because they were **residuals and leftovers
filed as work** — which the state axis now prevents directly, since a residual is `accepted` and never
`open`.

### The triage pass

**It sits outside the lifecycle and has no trigger.** Every lifecycle stage is scoped to one issue or
one PR; there is no cross-issue stage, and attaching triage to an invented boundary between units of
work is the stage split [`docs/standards/development-lifecycle.md`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/standards/development-lifecycle.md)
warns against. It runs when the HC calls it, is interruptible, and blocks nothing — which is safe
precisely because nothing urgent is in the pile: a broken thing is a defect and never waits for triage.

**The AC's pass is subtractive, not additive.** Its product is *eliminations with evidence* — already
fixed, superseded, duplicate, unreachable — not a ranked list of everything. A pass that returns every
item ranked has delegated nothing.

**The AC may eliminate only what it can attach a re-runnable check to** — one command the HC can paste
to confirm the row. Everything else it *proposes*. This is
[ADR 0033](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/docs/adr/0033-verification-stays-in-main-agent-loop.md)'s boundary applied to disposition:
mechanical facts are delegable, judgment is not. **Its deliverable is a file, not a message.**

**Sort only as far as the next decision requires.** First pass is binary — before Springfield or not.
Only the deferred side is sub-sorted, and only when something is about to be done with it.

### Precedence — this overrides five instructions that say otherwise

The instruction chain does not merely omit the rules above; in five places it **directs the opposite** —
and each sits where an agent is standing at the moment it decides. All five are **vendored** — nadal
never edits `rules/`, `skills/`, or `docs/standards/` — so they are overridden here, from the host's own
config layer, which is what that layer exists for. For a **process/operational** finding in nadal, none
of the following applies:

| Vendored instruction | What it says | Here |
|---|---|---|
| [`rules/self-review.md`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/rules/self-review.md) → *Anti-Patterns* (Tier-1 Lean Core, resident on every run) | *"promote it now … or open a tracked enforcement issue"* | **Does not apply.** Write the findings line. |
| [`rules/self-review.md`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/rules/self-review.md) → the **asks-ledger**, stated three times (Patterns, Checklist, Anti-Patterns), and formerly executable as the retired `ship` orchestrator's `asks_ledger` contract (`status: "handed-off"` with a `ref`) — the mechanism left at the deuce cutover, the rule it encoded did not | *"each one is either delivered or **handed to a tracked follow-up**"* | **The findings line IS delivery.** For a process/operational learning the log is the correct terminal destination, so such an ask closes as `delivered` with the findings line as its `ref` — never as `handed-off` to an Issue. The asks-ledger rule is not weakened: nothing may be silently dropped. |
| ace `final`'s Step 1 — **no longer executed at all**, since [`deliver`](skills/deliver/SKILL.md) carries no rule-suggestion step | *"defer the large or contentious ones to a tracked follow-up issue"* | **Does not apply, and now has no mechanism to apply through.** See *Rule-suggestion disposition* above — nadal runs `log-and-continue`, and that whole section awaits [#154](https://github.com/wrburgess/nadal/issues/154). |
| [`scout`](https://github.com/wrburgess/ace/blob/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608/skills/scout/SKILL.md) / the Learnings Log — the only logging pattern the Config Bundle ships | a logged entry carries a `stance` + `touches` and `scout` **opens a PR** proposing Rules/Skills/ADR changes | **A different artifact.** The Learnings Log folds *external* field voices and is meant to open PRs; [`docs/findings.md`](docs/findings.md) records the AC's *own* operational experience and is meant to open nothing. Do not carry the reflex across. |
| [`verify`](skills/verify/SKILL.md) Stage 4 (executed on every PR) | an adversarial pass that *"actively tries to **refute** the change"* — stated with **no stopping condition**, so "is anything wrong?" runs until a human stops it | **Bounded here.** See [*Review Lenses*](#review-lenses): a solicited pass declares a lens set of 3 plus the permanent lens ([`config/review.md`](config/review.md), which the dispatcher parses), each lens runs once, and fix-verification gets two passes before escalation. The adversarial *posture* is unchanged — only its terminus is supplied, because the vendored body supplies none. |

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
failure this whole section is about — and stated more absolutely than it once was: the ace-era parity
check that asserted this file's structure (and even it read none of the rule stated here) retired at
the deuce cutover. Nothing mechanical reads this section at all.

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
it**; the re-vendor obligation is recorded in [`docs/ace-sync-manifest.md`](https://github.com/wrburgess/nadal/blob/0e9ff24b424ef2ba6ac813ff3acc88b850a907d0/docs/ace-sync-manifest.md)
under *Known local deltas*, which is where a re-sync reconciler looks.

> **Trimmed surfaces (host Customization):** the ace-era intake pipeline (`scout`, `clip`,
> `follow`, `restock` and the Watchlist / Learnings Log / Manual-drop inbox / Tool Roster artifacts
> under `docs/reference/`) left with the deuce cutover
> (deuce [#86](https://github.com/wrburgess/deuce/issues/86)): every entry predated nadal's
> vendoring — ace's own record shipped wholesale, read now at its source,
> [ace `46fdbb8`](https://github.com/wrburgess/ace/tree/46fdbb89d4e6dd30a63f01d58c0c75d9feb32608).
> The *Intake Pipeline* and *Tool Roster* sections that declared their locations are gone with the
> artifacts — a location table pointing at deleted files would be a live claim about nothing.

## Execution Profile

Per-step model/effort routing (spec § Model routing; proving ground for ace#143).
Ceiling: **Opus / high** — Fable only on explicit HC invocation.
Executable at delegation boundaries (subagent spawns) and via the
project model pin; step-level routing inside one session is advisory.

| Step | Model / effort |
|------|----------------|
| Driver sessions (grilling, planning, judgment) | Opus / high |
| SOW execution (TDD implement) | Sonnet / high; escalate to Opus when stuck, noted on the issue |
| Mechanical (scaffolds, fixture capture, writeups, findings appends) | Haiku or Sonnet / low |
| Adversarial PR review | GPT family via Codex / high |
| AFK research | Sonnet / medium |
