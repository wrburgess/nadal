---
name: verify
description: Stage 4 of the development lifecycle. Self-review an existing PR against its approved plan for drift, test quality, cleanliness, and description completeness before the Reviewer sees it. Use on the PR that invoke opened. It operates on the existing PR and never creates one.
---

<what-to-do>

Self-review the existing PR named in the invocation against its approved implementation plan, so that
when the Reviewer sees it they find nothing. This is **Stage 4 (Verify)** of the
[development lifecycle](../../docs/standards/development-lifecycle.md).

Read host-specific values — the review severities from [`PROJECT.md`](../../PROJECT.md) → *Review
Severity Framework*, the quality-check commands from *Quality Checks*, the lifecycle host from
*Lifecycle Host*, the attribution/model from *Attribution & Model Declaration*. Never hardcode them.

**This stage operates on the PR `invoke` already opened — it never opens one.** If there is no PR, a
prior stage's terminal artifact was skipped: stop and recheck, don't reinterpret the lifecycle.

</what-to-do>

<how-to-run>

**`verify` runs in the main agent loop and is never offloaded to a sub-agent**
([ADR 0033](../../docs/adr/0033-verification-stays-in-main-agent-loop.md), amending
[ADR 0005](../../docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)). Run
Steps 1–6 yourself, reading the whole PR diff and the plan: a *summary* of the diff cannot carry the
severity classification this stage exists to produce, and the second opinion that guards this PR is the
independent Reviewer summoned below — not a sub-agent of the same run.

This holds on **every** harness, so there is nothing to degrade here: in-loop is not the fallback path,
it is the only one. The cost — the reading is the largest in the lifecycle — is paid deliberately and
is why [`ship`](../../skills/ship/SKILL.md) resets its context before entering this stage.

### drift-report (verify → the posting orchestrator)
```
{ plan_alignment:   { all_implemented: bool, missing_items: [str], scope_creep_files: [str] },
  test_quality:     { meaningful: bool, false_greens: [str], gaps: [str] },
  test_coverage_summary: { by_type: str, edge_cases: str },
  quality_checks:   [ { purpose, status: "pass"|"fail"|"not_run" } ],
  quality_checks_source: "invoke_check_result" | "ran_here",
  cleanliness:      { debug_code: [str], commented_code: [str], todos: [str] },
  pr_description:   { complete: bool, missing_sections: [str] },
  findings:         [ { severity, file, line, summary } ],   # severity per PROJECT.md → Review Severity Framework
  self_review_comment_markdown: str,   # ready-to-post `## Self-Review Complete` body
  verdict:          "ready" | "needs_fixes" }
```
`quality_checks` carries one entry per [`PROJECT.md`](../../PROJECT.md) → *Quality Checks* row. When
`invoke` already ran them, copy its check-result (`quality_checks_source: invoke_check_result`) rather than
re-running; standalone, run them here (`ran_here`). `not_run` = ran-but-nothing-applicable, not
skipped. `findings[]` is where the **adversarial pass** (procedure Step 4) records the defects it
surfaces, each with a *Review Severity Framework* severity; the schema is unchanged, so the report
still composes with `ship`'s verify handoff.

</how-to-run>

<procedure>

1. **Read the PR** — its description and full diff.
2. **Read the approved plan** from the linked issue — find the linked issue via the PR's closing
   references, falling back to the bare issue number in the PR body (`Closes #N` leaf preferred, then
   `Part of #N`), and fetch the plan comment specifically. If the plan was revised through a
   **sanctioned re-plan** — a Reviewer plan review, or a mid-`invoke` loop-back that re-entered plan
   approval (e.g. a spike's re-plan checkpoint) — check against the *final, approved* plan.
3. **Check plan alignment** — every plan task has a corresponding change in the diff; no plan item
   missing. Divergence from the plan splits two ways: a **sanctioned re-plan** (it went back through
   plan approval — check against that final plan, it is not drift) versus **unsanctioned scope creep**
   (files or behavior that never went back through the gate — that is a finding, regardless of the
   "revisable plan" framing).
4. **Adversarial pass — try to break your own change.** Don't just confirm each plan item has a change:
   hunt the defect an independent second-model Reviewer would flag, and fix it now so their review
   *confirms* rather than *corrects*.
   - **Refute the change** — construct the input or state where it breaks: off-by-one, `nil`/empty,
     boundary value, duplicate, concurrent operation, unauthorized path. If you can build the failing
     case, that is a finding.
   - **Attack the tests, don't count them** — apply [`rules/testing.md`](../../rules/testing.md)'s
     definition of done and hunt the **false green**: a test that would still pass if the feature were
     reverted, a missing sad path, or an assertion that checks "it ran" instead of "it's correct." For
     each test ask, "if this passed but the feature were broken, would I know?"
   - **Assume the Reviewer's posture** — ask "what is the single most likely thing an independent
     Reviewer flags here?" (incomplete coverage — the most frequent; missing error/edge-case handling;
     a requirement from the issue not fully addressed; naming/structure/duplication) — and address it
     before they see it.
   - **An unproven concern is surfaced as a finding, not waved off** — a disposition rule: "I couldn't
     confirm it" resolves to *record it*, never to *drop it*.

   Record each finding in the `drift-report` `findings[]` with a severity from
   [`PROJECT.md`](../../PROJECT.md) → *Review Severity Framework* — the same contract as before, no new
   schema.
5. **Check cleanliness** — no debug code, no commented-out code, no "TODO"/"needs manual testing"
   comments, no unrelated changes.
6. **Review the PR description** — Summary, Changes, Technical Approach, Testing, and Checklist present
   and accurate.

**Fix drift now, don't document it for later.** `verdict: needs_fixes` → fix the drift (inline, or by
re-running the implement loop), then re-verify. `verdict: ready` → post the self-review comment.

</procedure>

<output>

On `verdict: ready`, post this comment on the PR via the lifecycle host, filling the bracketed parts
from the drift-report:

```markdown
## Self-Review Complete

### Plan Alignment
- [x] All plan items implemented
- [x] No scope creep — only files in the final approved plan changed
- [Any deviations and why]

### Adversarial Pass
- [x] Tried to refute the change (off-by-one, nil/empty, boundary, duplicate, concurrent, unauthorized) — [what was attempted]
- [x] Attacked the tests for false greens and missing sad paths — [what was found / confirmed]
- [Findings surfaced and their resolution, or "none"]

### Test Coverage Verified
- [x] By test type: [summary]
- [x] Edge cases: [summary]

### Reviewer Readiness
- [x] No debug code, no TODOs, no commented-out code
- [x] PR description complete
- [x] All quality checks pass (from PROJECT.md → Quality Checks)

PR is ready for the Reviewer.
```

Sign with the attribution footer from [`PROJECT.md`](../../PROJECT.md) → *Attribution & Model
Declaration*, naming your **runtime-actual** model. This step depends on that being honest: the
independence rule below compares the chain against the harness you are actually running as.

## Summon the Reviewer

**`verify` is the sole owner of the PR-gate Reviewer summons** ([ADR 0026](../../docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)).
The **AC** summons here — not the HC — so a run still gets its faithfulness backstop with no human in
the loop. No other Skill issues this summons: a second one produces two review requests, two windows,
and an unanswerable "did the primary respond?". (The *plan*-gate summons is a separate thing: it stays
with the HC where plan approval is `required`, but under the shipped baseline `auto` nobody is at the
plan gate, so it has no owner yet — a residual risk tracked in
[#129](https://github.com/wrburgess/ace/issues/129); see the ADR.)

Read the chain from [`PROJECT.md`](../../PROJECT.md) → *Reviewer*: the **primary**, the **fallback
order**, the **bounded window**, and the **degradation floor**. **Baseline — primary `Codex`,
fallback order `Copilot`, bounded window `30m`, degradation floor `stop-and-ask`.** A Host App
overrides the first three there; **the floor is not configurable** — a run that cannot obtain an
independent review may not certify itself.

Those four values are written out here, not left behind the pointer, because this procedure has to be
executable by a reader who cannot open `PROJECT.md` — the resident-default rule in
[`rules/skills.md`](../../rules/skills.md). They are the Generic Baseline's **placeholders**: whatever
*Reviewer* declares wins, and the values above are what applies when it declares nothing.

After posting the self-review, take each chain entry in order:

1. **No *Invocation paths* row → the entry is UNREACHABLE, not slow.** That table is the membership
   list: an entry with no row has no summons mechanism, so there is nothing to issue and nothing to
   wait for. Fall back **immediately** — do not start the window.

   **No *Reviewer* section at all → every entry is unreachable, so go straight to step 7 and apply
   the floor: stop and ask the HC.** Do not summon anything and do not start a window. A vendored
   `PROJECT.md` that predates the section supplies no *Invocation paths* table, and the baseline
   values above name *who* the chain would try without naming *how* to reach any of them — the
   baseline ships placeholder harnesses, never a summons command it could not honor
   ([ADR 0027](../../docs/adr/0027-reviewer-chain-validated-against-invocation-paths.md)).
2. **The entry names the harness you are running as → also unreachable; fall back.** An AC cannot be
   its own independent backstop, and a same-model review that *appears* to run is worse than none.
   This is **self-reported by construction** — you compare the entry against your own runtime-actual
   identity, and nothing verifies that claim. It is also a **harness**-level check, while the
   standard's requirement is *model*-level: it catches a same-harness entry, and does **not** catch
   two different harnesses that happen to serve the same model. Derive the chain to summon by passing
   your runtime-actual harness identity through `scripts/reviewer.rb` →
   `independent_chain(fields, acting:)`, so the acting harness is dropped **deterministically** rather
   than by eye; an empty result is an exhausted chain (step 7).
3. **Precondition — the *Check* cell is optional and host-supplied.** Declared → run it before
   summoning; unmet means do not summon, fall back immediately. **Absent** → the **summons is the
   probe**: issue it, and treat **`precondition unverified`** as a **qualifier** on whatever terminal
   outcome follows (steps 5–6), not an outcome in itself — a summons that created **no request** is
   `unreachable (precondition unverified)`; a request created but silent through the window is
   `timed-out (precondition unverified)`; a reply is `responded`. The baseline's Codex row declares
   an executable ready probe ([ADR 0035](../../docs/adr/0035-codex-summons-is-the-local-cli-runtime.md)),
   so **Declared** applies there — run the probe before summoning; the absent-Check path remains the
   default for rows without one — and neither path ever collapses a *pending* request into a clean
   `unreachable`.
4. **Snapshot, then summon.** Before issuing the summons capture the **current PR head SHA** and a
   **baseline of the review threads/comments that already exist** on the PR; then summon via the declared
   mechanism, recording the **request identity** the mechanism returns for the created review request
   when it returns one, and wait up to the **bounded window**. **How the reviewed SHA binds depends
   on the mechanism:**
   - **Synchronous** reviewer that reviews the **checked-out PR head** (the baseline Codex row: the
     local Codex CLI runtime) → the summon-captured SHA **is** the reviewed SHA, bound by
     construction — but the construction only binds if the reviewer actually ran on that commit:
     **before invoking, confirm the local `HEAD` equals the summon-captured PR head** (check out that
     SHA if the remote advanced or the checkout is stale), or the relay would certify a commit the
     reviewer never saw. A first invocation that returns **empty output while the ready probe
     passes** is a known runtime flake: **retry once** before recording any outcome.
   - **Asynchronous** reviewer that fetches the PR later (a platform review) → the head may advance
     before it fetches, so the summon-captured SHA is only a *lower bound*. Accept the response only
     when the review artifact **explicitly attests the reviewed commit** it covers; that
     artifact-attested commit **is** the reviewed SHA. An artifact that attests no commit — including
     a platform that cannot attest one — is **unverified → apply the floor (step 7)**, never assumed
     to cover the summon-time head. And an attested SHA that differs from the current PR head at
     acceptance means the response covered a **stale** commit: re-summon on the current head (the
     same re-enter-the-chain move [`final`](../../skills/final/SKILL.md)'s gate forces at delivery),
     never carry a known-stale reviewed SHA forward as if it covered the head.

   Record the reviewed SHA now, carry it forward unchanged, and **never re-derive it at delivery**; the
   baseline lets step 5 tell *this* summons's response from an earlier round's. Together these let
   [`final`](../../skills/final/SKILL.md) prove the head the HC merges is the head that was **actually
   reviewed** — not a vacuous re-stamp of the current head, nor a stale reply accepted as fresh.
5. **A response is a reply on _any_ of the three surfaces** — an issue-level PR comment, an **inline
   diff thread**, or a **review body** — and only one that is **new since the summon snapshot (step 4)**:
   a pre-existing reply from an earlier round is **not** *this* summons's response and must never be
   counted as one. Attribute a new reply to *this* summons by the recorded **request identity** when
   the mechanism returned one (step 4); new-since-snapshot is the remaining basis when it did not.
   Poll all three surfaces (reading only issue-level comments makes an automated inline
   review invisible — the trap [`listen`](../../skills/listen/SKILL.md) Step 1 warns about). A
   **synchronous CLI reviewer's response arrives as returned output**, not on the PR — so the summoner
   **posts it onto a PR surface**: an issue-level PR comment carrying the reviewer's harness/model, the
   reviewed SHA, and the findings. That relay is what keeps the three-surface definition,
   [`listen`](../../skills/listen/SKILL.md)'s fetch, and the durable evidence record below holding
   unchanged. For a synchronous reviewer running on the checked-out PR head that relayed reply
   inherently reviewed the summon-captured SHA; for an asynchronous platform reviewer, attribute the new
   reply to this summons **and take its reviewed SHA from the artifact-attested commit, never the
   summon-time head** (step 4). **A summons that merely returned success is not itself a
   response.** Keep the timeout/unreachable distinction intact by separating two failure modes: a summons
   that created **no review request at all** (the API "succeeded" but produced nothing to wait for, or a
   precondition was unmet) is a **no-op → `unreachable`**, fall back immediately; a request **created but
   not yet replied** is **not** unreachable — poll to the bounded-window expiry and record **`timed-out`**
   (step 6), carrying the `precondition unverified` qualifier from step 3 when no Check ran. *Request
   accepted ≠ review produced — but request accepted ≠ unreachable either.*
6. **Window expires with no response → fall back** to the next entry and repeat from step 1. Never
   wait indefinitely.
7. **Chain exhausted — including a chain that was unreachable end to end → apply the degradation
   floor: stop and ask the HC.** Do not proceed to `listen` or `final` on an unreviewed PR.

**Carry the outcome forward**, and keep **timeout distinct from unreachable** — "no second model
exists" and "the second model is slow" call for different HC responses, and the SOW cannot
reconstruct the difference later. `precondition unverified` is a **qualifier** riding on whichever of
those two applies when no Check ran — it says nothing confirmed the summons could land, and attaches to
`unreachable` (no request created) or `timed-out` (created but silent) accordingly. Record the **durable
review evidence** — the reviewer's **harness/model**, the **reviewed SHA** (bound in step 4 — the
summon-captured head for a synchronous reviewer, the artifact-attested commit for an asynchronous
one), the **request identity** (when one existed), the **disposition** (responded · timed-out ·
unreachable · floor-hit, and why), and the review **artifact URL** — so
[`final`](../../skills/final/SKILL.md) reports it in the SOW from a durable record, never inferring a
review happened because findings exist.

**Terminal artifact:** the self-review comment on the PR.

**Next step:** the review-response skill (`listen`) on the Reviewer's findings, then the deliver
skill (`final`).

</output>
