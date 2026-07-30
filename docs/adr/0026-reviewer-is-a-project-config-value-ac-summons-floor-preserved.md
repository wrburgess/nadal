# The Reviewer is a Project Config value, the AC summons it, and the degradation floor is preserved

**Status:** accepted

## Context

The [development lifecycle](../standards/development-lifecycle.md) requires an **independent
second-model Reviewer** at the plan and PR gates, and [ADR 0005](0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)
makes that review the **faithfulness backstop** — the control that stops a delegated summary the
orchestrator never saw from silently steering the outcome.

The role was specified; its invocation never was. The field test recorded in
[#99](https://github.com/wrburgess/ai-config/issues/99) found the gap the hard way: a `@codex review`
mention did **nothing**, because the Codex GitHub app was not installed — and *"an unanswered mention
is indistinguishable from a pending review."* The backstop failed silently, which is the one way a
backstop must never fail.

Three further facts make this more than a documentation gap:

1. **`skills/ship/SKILL.md` already points at a Reviewer declaration that does not exist.** Its
   faithfulness-backstop paragraph routes the reader to `PROJECT.md` → *Lifecycle Host* → the
   Reviewer role. `PROJECT.md` contains zero occurrences of "Reviewer". The pointer is dangling
   today, independent of this decision.
2. **The degradation floor is asserted in three places, not one:** the lifecycle standard's *Roles*
   section, ADR 0005's faithfulness-backstop bullet, and `ship`'s own body. They currently agree;
   nothing keeps them agreeing.
3. **[PR #109](https://github.com/wrburgess/ai-config/pull/109) attempted this and was closed** with
   four blocking findings: it summoned the Reviewer from *two* owners, specified a bounded wait that
   could not be executed, recorded the silent-failure precondition as a table caveat instead of
   checking it, and **silently weakened the degradation floor** from *"stop and ask the HC"* to
   *"flag it in the SOW"* — a change in kind, made in prose, leaving ADR 0005 as the stale document.

This ADR settles the policy so the hands-off orchestrator work
([#115](https://github.com/wrburgess/ai-config/issues/115)) implements a **decided** position rather
than deciding as it goes. That sequencing is deliberate: #110 absorbed #99 precisely because *what
happens when a hands-off run cannot reach a Reviewer* is not answerable without the hands-off context.

### An empirical constraint discovered while assessing this work

The originally-proposed hands-off mechanism was for `ship` to cross the plan boundary by **spawning a
fresh build orchestrator** that would itself re-delegate `invoke`'s code loop and `verify`'s diff
review. That was tested from inside a sub-agent and **does not work**:

```
Task(...)  -> "No such tool available: Task. Task exists but is not enabled in this context."
Agent(...) -> "No such tool available: Agent. Agent exists but is not enabled in this context."
```

Nested delegation is a deliberate one-level harness gate — the capability is registered and withheld
from sub-agents, not missing. A spawned build orchestrator therefore could **not** exercise ADR 0005's
delegation policy at exactly the two phases that policy exists for.

It is recorded here because it constrains the boundary-crossing design in #115 (the crossing must be a
**same-agent context reset**, not a spawned agent) and because it is the reason this ADR can preserve
ADR 0005 rather than supersede its delegation rule. It is **harness-version-specific** and should be
re-tested rather than assumed permanent.

## Decision

1. **The Reviewer is a Project Config value.** Add a `## Reviewer` section to
   [`PROJECT.md`](../../PROJECT.md) declaring the **primary** reviewer (harness + model per
   [ADR 0024](0024-harness-model-naming-convention.md)), the **fallback order**, the **bounded
   window**, and the **degradation floor** — plus a per-tool invocation table giving each harness's
   summons mechanism *and its precondition-check command*. The argument shape is ADR 0006's and
   ADR 0025's: the skill bodies name the **role**, the host declares the **identity**.

   The heading is deliberately **absent from `REQUIRED_PROJECT_SECTIONS`**, matching the *Human
   Gates* / *Intake Pipeline* / *Tool Roster* precedent — the extractor returns shipped defaults when
   the section is missing, so an already-vendored Host App stays green.

2. **At the PR gate, the AC summons the Reviewer, and [`verify`](../../skills/verify/SKILL.md) is its
   sole owner.** This narrowly supersedes the lifecycle standard's *"HC sends the PR to the
   Reviewer."* `ship` **adds no summons of its own** — it "adds no phase procedure of its own," and a
   duplicated summons is the defect that closed PR #109: two review requests, two windows, and an
   unanswerable "did the primary respond?"

   **The plan gate's summons stays HC-driven, deliberately and for now.** Plan approval ships
   `required`, so a human is already standing at that gate — `assess` and `devise` keep telling the HC
   to send the assessment/plan onward, and nothing there contradicts this decision.

   It stops being true the moment plan approval is `auto`: an unattended run has nobody at the plan
   gate to forward anything, so the plan-gate summons would need an owner too. That is deliberately
   **not** settled here, because it is only answerable alongside the hands-off mechanism
   ([#115](https://github.com/wrburgess/ai-config/issues/115)) and the `auto` flip
   ([#116](https://github.com/wrburgess/ai-config/issues/116)). Scoping the claim to the PR gate is
   what keeps this ADR from asserting a policy no shipped body implements — the failure mode that
   closed PR #109.

3. **The degradation floor is PRESERVED as "stop and ask the HC."** ADR 0005's floor stands
   unmodified. This is an **affirmation**, recorded because PR #109 attempted to weaken it and because
   a floor asserted in three places with no test needs a decision to point at.

   The reasoning is specific to the hands-off design and is the reason the tradeoff PR #109 faced no
   longer binds: #115 redefines an emergency stop as a **pause that re-seeds**, not a termination.
   Under the old semantics, "stop and ask" killed the run, which is what made "deliver with a
   footnote" tempting. Under pause-not-terminate, stopping costs one question and a durable record.
   **A backstop that can be waived by its own failure is not a backstop** — a run that cannot obtain
   an independent review must not be able to certify itself.

4. **The precondition is CHECKED, not documented — as a procedure. The shipped example checks do not
   yet satisfy it.** Before summoning, the AC verifies the primary's declared precondition; a
   knowable condition that is merely written down leaves #99's defect intact, because the AC posts
   into the void and burns the full window. An unreachable primary must fail **immediately** into
   fallback, and a timeout wrapped around a knowable failure is not a fix.

   **This decision records the requirement and explicitly does not claim the baseline meets it.** The
   two rows shipped in `PROJECT.md` → *Reviewer* → *Invocation paths* are illustrative placeholders
   and both fall short: the Codex check needs GitHub App authentication an AC's normal token does not
   have (it returns 401/403), and the Copilot check *is* the summons, so it cannot run before one
   without a side effect. Closing that gap needs credentials and mechanisms the Generic Baseline
   cannot assume, so it is tracked separately rather than asserted here.

   Stating the requirement while naming the shortfall is deliberate. Asserting a policy no shipped
   artifact implements is what closed PR #109, and this ADR must not repeat it in the act of citing
   it.

5. **"Response" is defined across all three surfaces** — issue-level comment, inline diff thread, and
   review body — because reading only the first makes an inline review invisible (a trap
   [`listen`](../../skills/listen/SKILL.md) already warns about). **Timeout and unreachable are
   distinct states**, carried forward separately: collapsing them loses the difference between "no
   second model exists" and "the second model is slow," and the HC cannot recover it from the artifact.

6. **Machine-check the reference.** A new `scripts/reviewer.rb` (mirroring
   `scripts/human_gates.rb`) parses the section; `scripts/parity_check.rb` validates the values and
   asserts each reviewer-aware body names the host value. ADR 0025 rejected "declared but unchecked"
   as *"a false green"*; the same argument applies here.

   The asserted reference is the **emphasized pointer form** (`*Reviewer*`), not the bare word.
   "Reviewer" appears throughout this repo's prose, so a bare-word check would pass on any body that
   merely *mentions* the role — green on arrival, and blind. This is the [#103](https://github.com/wrburgess/ai-config/issues/103)
   class of defect, and the check is written to redden under test rather than asserted to work.

7. **Narrow supersession of [ADR 0025](0025-human-gate-policy-is-a-project-config-value.md)
   decision 6**, and only of its `listen` clause. ADR 0025 enumerated `listen`'s "wait for the HC to
   choose" as out of the gate setting's scope. Under an AC-driven review loop that blanket wait is
   replaced by **severity-disciplined autonomous disposition plus `ship`'s emergency stop #3** (an
   architectural, ambiguous, or multiply-interpretable comment always stops). ADRs are immutable here
   ([ADR 0024](0024-harness-model-naming-convention.md), applied by ADR 0025), so ADR 0025 is **not
   edited**; the supersession is recorded here, where a reader arriving via its text will find it.

   Everything else in ADR 0025 stands unmodified — the gate table, merge's non-configurability, the
   resident-default rule, the boundary/approval split, and the intake-gate carve-outs.

### Why this is not the coupling ADR 0025 rejected

ADR 0025 rejected option E — a single `autonomy:` knob — *"as over-reach and as actively dangerous:
it would couple the plan pause to the emergency stops and the intake gates, which must **not** move
together."*

**Precisely what this decision moves:** `listen`'s blanket wait (decision 7) and the PR-gate summons
owner (decision 2). **It does not move the plan pause.** `PROJECT.md` → *Human Gates* is untouched and
still ships plan approval `required`; waiving that pause is [#116](https://github.com/wrburgess/ai-config/issues/116)'s
decision to make, not this one's. The question is therefore narrower than option E's, but it is still
worth answering, because #116 will move the plan pause against the policy this ADR sets — so the two
must be shown not to compose into the coupling ADR 0025 rejected.

It is a different coupling, on three grounds:

- **What moves is one category, not a spectrum.** Both pauses are *the AC waiting on a human to
  adjudicate the AC's own output* under one orchestrator. The emergency stops are a different kind:
  they fire on *unresolvable ambiguity*, and they remain unconditional and un-waivable.
- **The intake gates do not move at all.** `scout` / `clip` / `follow` / `restock` / `create-skill`
  keep "a human disposes" in full. They also use different wording, so no sweep can reach them by
  accident.
- **Nothing here is expressible as a config value.** Option E's danger was a *knob* a host could turn
  to move all three together. This is a fixed policy decision with the emergency stops and the merge
  gate hard-wired beneath it, not a new dial.

The residual risk is real and is recorded rather than argued away — as a **future** state, not the
shipped one. After this ADR the plan pause still stands, so the pre-merge human checkpoints are: the
plan gate, the four emergency stops, the Reviewer floor, and merge. **Once #116 waives the plan
pause**, the plan gate leaves that list and the remaining checkpoints are the emergency stops, the
Reviewer floor and merge — and the stops are prose-only conditions no check can verify. That is the
price of hands-off, and it is exactly why decision 3 keeps the Reviewer floor at "stop and ask": it is
the one pre-merge check that is both machine-enforced and non-configurable, and it has to still be
standing when the others go.

## Considered options

- **A — leave the Reviewer unspecified (status quo).** Rejected: it is the live #99 defect, and it
  leaves `ship` pointing at a declaration that does not exist.
- **B — document the invocation paths as prose caveats** (PR #109's shape). Rejected: recording "the
  app must be installed" in a table cell leaves the silent failure intact. That PR was closed for it.
- **C — a Project Config value, machine-checked, floor preserved (chosen).** Adds the section, the
  parser, and the reference assertion; keeps the backstop at full strength.
- **D — a Project Config value with the floor weakened to a flagged SOW.** Rejected: under hands-off
  it lets the faithfulness backstop disappear exactly when nobody is watching, and it is what closed
  PR #109. Decision 3's pause-not-terminate reframing removes the cost that motivated it.
- **E — put the Reviewer under `## Lifecycle Host`** (self-healing `ship`'s dangling pointer).
  Rejected: that section is a bullet list, and the repo's shape is one H2 per host value with one
  script per H2. A dangling pointer is a bug to fix, not a reason to shape the config around it.

## Consequences

- A Host App declares its reviewer chain in **one place** and never forks a vendored body to change
  it. The Generic Baseline's behavior is unchanged.
- **The silent-failure mode is closed in the procedure, not yet in the shipped example checks.**
  `verify` runs a precondition check before summoning and falls back immediately when it fails, so a
  host that declares an *executable* check gets a legible failure instead of a burned window. The two
  placeholder rows this baseline ships do not provide one (decision 4), so on the shipped config an AC
  still cannot distinguish "app not installed" from "still thinking." #99's original symptom therefore
  survives at the **declaration** layer even though the mechanism around it is in place.
- **A run that cannot reach any reviewer stops.** That is the intended cost. It is affordable only
  because #115 makes a stop a pause; if that reframing is ever reverted, this floor must be revisited
  in the same breath.
- **Known limit — the check verifies *reference*, not semantic agreement.** Exactly as ADR 0025
  recorded for the gate value: a body can name `*Reviewer*` and still describe the wrong policy.
  The three degradation-floor copies and the per-gate summons sentences are upheld by the skill
  bodies and human review, not by a test. This is the
  [ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md) boundary, and the reason the
  implementing PR carries an explicit contradiction sweep as a named step rather than a side effect.
- **The parser is fail-safe, not fail-closed** — a missing section reads as the shipped defaults, and
  a **typo'd heading reads as absent**, silently yielding those defaults rather than erroring. That is
  right for a policy value and is what keeps vendored hosts green, but it is a real hazard, inherited
  knowingly from the same tradeoff ADR 0025 documented.
- **`ship`'s dangling Reviewer pointer is fixed** as a side effect — a pre-existing bug this work
  happens to sit on top of.
