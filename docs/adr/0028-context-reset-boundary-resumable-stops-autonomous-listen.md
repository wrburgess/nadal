# The plan boundary is a context reset, stops are pauses that re-seed, and `listen` disposes autonomously under `ship`

**Status:** accepted

Narrowly supersedes the **session-boundary wording** of [ADR 0025](0025-human-gate-policy-is-a-project-config-value.md)
decision 5 and of [ADR 0005](0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)'s
*Gates are session boundaries* rule — their **firebreak decision stands unmodified**, only the framing
generalizes (decision 1). **Enacts** [ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
decision 7 (the `listen` carve-out removal it recorded) and builds on ADR 0026's nested-delegation
constraint. Every other decision in ADR 0005 / 0025 / 0026 / 0027 stands unmodified.

## Context

`ship` is documented as "the hands-off orchestrator," but under the shipped configuration a run cannot
complete without the HC driving it by hand. This is the Phase 2 half of umbrella
[#110](https://github.com/wrburgess/ai-config/issues/110): Phase 1
([ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md),
[ADR 0027](0027-reviewer-chain-validated-against-invocation-paths.md)) **decided** the Reviewer policy;
this ADR settles the boundary-crossing, driving-loop, and review-disposition decisions
[#115](https://github.com/wrburgess/ai-config/issues/115) implements, so the skill bodies land a
**decided** position rather than deciding as they go.

Three things stood in the way, and each handed the human a manual command rather than a question:

1. **The plan gate is framed as a *session boundary*.** ADR 0025 decision 5 split gate-as-approval from
   gate-as-session-boundary and made the boundary unconditional — "plan posted" ends the session under
   either setting, and `invoke` re-reads the posted plan rather than trusting memory. That framing is
   correct only while **a human is the one who crosses.** The moment `ship` itself crosses the boundary
   (under `auto`, [#116](https://github.com/wrburgess/ai-config/issues/116)) there is no session to end
   — the same agent continues, having reset its context. "Session boundary" is then the wrong general
   name for the invariant it protects.

2. **A stop *terminates* the run.** After a human answers an emergency stop, the remaining stages become
   manual `/invoke` → `/verify` → `/listen` → `/final` invocations. One question converts the rest of
   the lifecycle into hand-driven work — the opposite of the skill's stated purpose.

3. **`listen` waits for the HC on every finding**, and ADR 0025 decision 6 placed that wait outside the
   gate setting's scope. [ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
   decision 7 already **decided** to replace the blanket wait with severity-disciplined autonomous
   disposition plus `ship`'s emergency stop #3; it left the enactment to this phase.

An empirical constraint recorded in ADR 0026 shapes the fix: **nested delegation is hard-blocked** —
`Task`/`Agent` return *"exists but is not enabled in this context"* one level down. The umbrella's
original design (spawn a fresh build orchestrator to cross the boundary under `auto`) therefore cannot
work: a spawned orchestrator could not re-delegate `invoke`'s code loop or `verify`'s diff review, the
two phases ADR 0005's delegation policy exists for. The boundary must be crossed by the **same agent
resetting its own context**, which is what #110's "context boundary, not session boundary" framing
already described and what needs no new capability.

## Decision

1. **The plan boundary is a *context reset*; "session boundary" is its `required` form.** This narrowly
   supersedes the **session-boundary wording** of ADR 0025 decision 5 and ADR 0005's *Gates are session
   boundaries* rule. **Their firebreak decision is unmodified.** The invariant is unchanged: at "plan
   posted" the working context is discarded and the next phase reconstructs its inputs from the durable
   artifacts (the issue / PR / git), never from carried-over context. What generalizes is *who resets,
   and how*, which the plan-approval gate setting decides:

   | Plan approval | Who crosses | The reset is… | Firebreak |
   |---|---|---|---|
   | `required` (shipped) | the human | a **session boundary** — the session ends, `/invoke` resumes it | preserved |
   | `auto` (#116, dormant here) | `ship` itself | the **same agent** discarding its context in place — never a spawned orchestrator (nested delegation is hard-blocked) | preserved |

   "Session boundary" was accurate while only a human ever crossed; it stops being the general term the
   moment `ship` can cross under `auto`. ADR 0005 and ADR 0025 are **not edited** — ADRs are immutable
   here ([ADR 0024](0024-harness-model-naming-convention.md)); their wording stands as the point-in-time
   record and the supersession is recorded here, where a reader arriving via their text will find it.
   This is the same supersession shape ADR 0026 decision 7 left between ADR 0025 and the living prose.

2. **A stop is a pause that re-seeds, not a termination.** `ship`'s emergency stops and the plan gate no
   longer *end* the hands-off run; they pause it. The AC records the stop and its answer durably, folds
   the answer into its build brief, resets its context, and resumes — the loop exits **only** at
   `delivered`, where the human merges (the one standing stop). There is no path where `ship` hands the
   HC a list of commands to run. This is the reframing ADR 0026 decision 3 already relied on — *"#115
   makes a stop a pause… under pause-not-terminate, stopping costs one question and a durable record"* —
   to keep the degradation floor affordable; this ADR is where it is enacted. If that reframing is ever
   reverted, ADR 0026 decision 3's floor must be revisited in the same breath.

3. **Resume is a pure function over durable artifacts — no new skill.** `/ship {issue}` derives its
   resume point from which terminal artifacts exist, per the lifecycle's *"a stage is not done until its
   terminal artifact exists"* — making the command **idempotent and safe to re-run at any point.** A
   separate `resume` skill is rejected: it would need its own copy of the phase order, delegation policy,
   and gate handling, and the two would drift — the failure `rules/scripting.md` names ("never mirror a
   sibling's shape without mirroring its control flow"). If `ship`'s body grows unwieldy, the fix is
   bundled files under `skills/ship/`, not a second sequencer.

4. **Q3 — a durable stop and its answer are a *paired* artifact.** The resume derivation keys off
   terminal artifacts, and a **posted-but-unanswered stop produces the same artifact set as no stop at
   all.** So the stop (phase, question, what is blocked) and the HC's answer are posted as a *pair* on
   the issue/PR, and the derivation reads the pair: an unanswered stop → still paused at that phase; an
   answered stop → fold the answer into the brief and advance. Without the pairing, resume cannot
   distinguish "waiting on a human" from "nothing has happened yet."

5. **Q4 — resume needs a Reviewer-findings signal finer than `listen`'s terminal artifact.** "self-review
   posted, Reviewer findings open" (resume at `listen`) and "findings addressed" (resume at `final`) both
   satisfy the coarse test "a self-review comment exists." The derivation therefore reads the
   **addressed/open state** of the Reviewer's findings, not merely the presence of `verify`'s self-review
   comment, or it resumes into the wrong phase.

6. **Q1 — `listen` disposes autonomously only within a `ship` run; a standalone `/listen` keeps its
   pause.** ADR 0026 decision 7 replaced `listen`'s blanket "wait for the HC to choose" with
   severity-disciplined autonomous disposition **plus `ship`'s emergency stop #3** — and that backstop
   lives only in `ship`. So the autonomous path is the `ship`-driven one, where stop #3 catches the
   architectural / ambiguous / multiply-interpretable finding that must not be auto-applied; a standalone
   `/listen`, with no such backstop, **retains stop-and-ask**. `listen` is therefore **context-aware**
   (invoked under `ship` vs. standalone), which is a property of *how it is invoked*, not of the
   plan-approval gate.

7. **Q2 — `listen` is not added to `GATE_AWARE_SKILLS`.** Its disposition is decoupled from the
   plan-approval setting (decision 6; ADR 0026 decision 7 is a *flat* supersession, not an
   `auto`-conditioned one). Adding it would force a spurious `Human Gates` reference into a body whose
   behavior that gate does not govern — misrepresenting the policy and reddening parity for a reason that
   is not true. The `listen` carve-out is therefore **removed** from the *Human Gates* → *Unconditional*
   lists in `PROJECT.md` and the lifecycle standard (enacting ADR 0026 decision 7), not relocated. The
   surviving escalation guarantee — an architectural/ambiguous finding always stops — is already carried
   by the emergency-stop bullet those lists keep.

8. **Scope fence — this phase builds the mechanism; #116 flips the switch.** Plan approval still ships
   `required` and the *Human Gates* **gate table itself is unchanged** — the plan-approval and merge
   settings are exactly as shipped (this PR edits only that section's boundary prose and removes its
   `listen` carve-out, per decision 7; the settings a host reads are untouched). So the `auto`
   context-reset branch (decision 1, `auto` row) ships **dormant**: documented and reachable in prose,
   never exercised until
   [#116](https://github.com/wrburgess/ai-config/issues/116) flips the gate and adds the `ai-config-sync`
   reseed. What is **live now, under `required`**: the pause-not-terminate loop (decision 2), the resume
   derivation and `/ship` idempotency (decisions 3–5), and `listen`'s autonomous disposition inside a
   `ship` run (decision 6). The four emergency stops (with ADR 0026 decision 3's floor beneath them) and
   the merge gate stay **unconditional** under all of it. Recording the dormancy is deliberate: asserting
   a validated hands-off `auto` run this phase cannot exercise is the documented-vs-shipped overclaim
   [ADR 0027](0027-reviewer-chain-validated-against-invocation-paths.md) exists to prevent.

## Considered options

- **A — delete the boundary and keep only "context reset."** Rejected: it erases the truth that under
  `required` the crossing genuinely *is* a session boundary, and ~10 living files assert that form.
  Deleting outright contradicts all of them and multiplies the restatement debt
  [#104](https://github.com/wrburgess/ai-config/issues/104) tracks; generalizing the wording lets each
  file keep its core claim and amend only *who crosses*.
- **B — spawn a fresh build orchestrator to cross under `auto`** (the umbrella's original §2). Rejected:
  nested delegation is hard-blocked (ADR 0026's empirical constraint), so a spawned orchestrator could
  not re-delegate `invoke`'s code loop or `verify`'s review — the two phases ADR 0005 exists for.
- **C — a same-agent context reset, pause-not-terminate stops, resume-as-read, autonomous `listen` under
  `ship`, mechanism-now / flip-later (chosen).** Keeps the firebreak at full strength, makes `/ship`
  idempotent, and does not move the plan pause.
- **D — a 14th `resume` skill.** Rejected (decision 3): it duplicates the phase order, delegation policy,
  and gate handling, and the two drift.
- **E — `listen` auto-disposes unconditionally, standalone included.** Rejected (decision 6): a standalone
  `/listen` has no emergency-stop-#3 backstop, so unconditional autonomy would ship a review loop that
  can silently accept an architectural finding with no human and no stop — the exact posture the stops
  exist to prevent.

## Consequences

- **`/ship {issue}` is idempotent and crash/compaction-recoverable.** A stop costs one durable Q+A and a
  re-seed, not a lost run; re-running the command resumes from the derived point rather than restarting.
- **The living docs now say "context reset" while ADR 0005 / 0025 still say "session boundary."** This is
  a supersession chain, not a contradiction — the same shape ADR 0026 already left with ADR 0025's
  `listen` clause. A reader arriving at the ADR's text follows it forward to here.
- **Nothing this repo runs changes yet.** Plan approval stays `required` and the `auto` cross is dormant.
  The behavior deltas that *are* live — pause-not-terminate, resume, autonomous `listen`-under-`ship` —
  do not depend on the flip, so #116 stays a small, safe activation rather than a mechanism PR.
- **Known limit — reference, not semantics.** Parity verifies that the reviewer/gate references survive
  the rewrites; it cannot verify that the reframed prose *agrees*. The ~30-sentence boundary reframe and
  the `listen` rewrite are upheld by the skill bodies, the implementing PR's **named contradiction
  sweep**, and human review — the [ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)
  boundary, restated because this phase's whole risk is a single session-worded sentence surviving green.
- **The `auto` plan-gate summons is still unowned and unmechanized.** ADR 0026 decision 2 and ADR 0027
  decision 6 left the plan-gate Reviewer summons without an owner *or* a mechanism; this phase does not
  settle it (it does not flip `auto`), and #116 must, before an unattended plan gate is real.
