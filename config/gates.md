---
date: 2026-08-11
source: the HC's ruling on #146 — "with the adopting of the deuce repo for software factory/SDLC, we are moving away from HC merge gate" — and, for the re-summons rule, the HC's choice on the same thread; supersedes the merge-gate passage in PROJECT.md → Human Gates
---

# Gate settings

Which setting each of the two gates runs at — the values only. What each setting means, the
graduated shape, and the floors no setting reaches are deuce's canon, at
[Chapter 0](https://github.com/wrburgess/deuce/blob/main/sds/00-identity-and-governance.md) → *Merge authority* and
[Chapter 1](https://github.com/wrburgess/deuce/blob/main/sds/01-lifecycle-and-skills.md) → *The two gates*, and are not restated here;
this is adaptive configuration under
[Chapter 1](https://github.com/wrburgess/deuce/blob/main/sds/01-lifecycle-and-skills.md) → *The adaptive layer's home*.

## Direction gate

- **`delegated`** — the AC proceeds on its own recommendation; nobody waits.

This is the setting `PROJECT.md` has carried as plan approval `auto` since the ace era, renamed to
deuce's vocabulary and moved here. Nothing about the practice changes.

**The floor is unchanged by the setting, and all four clauses bind:** the Assessment is always
posted before work proceeds on it; it always carries the rejected options and why; it always states
that the AC self-selected and on what reasoning; and `delegated` is never licence to compress a
stage — skipping one stays the HC's call.

## Ship gate

- **`attested`** — the AC merges the delivered pull request, against an independent review from a
  model other than the AC, **bound to the exact commit being merged**.

### Why, dated to the decision

nadal declared `attested` on 2026-07-31 (#41) and then could not reach it. The reason was
structural, not a bad run: [`verify`](../skills/verify/SKILL.md) step 10 batches review findings into
one fix wave and states that **the reviewer is never re-summoned**. A fix wave moves the head. So on
any pull request whose review found anything, the review was bound to a SHA that was no longer the
head, and the fourth condition could only be met by a review that found nothing. `PROJECT.md`
recorded that as *every merge here is HC-performed*.

The HC's ruling on #146 removes the HC merge gate, which means the machinery has to exist rather
than the gate being lowered. It does, and it is below.

### How the binding is re-established

Read *never re-summoned* for what it says: it bounds one **pass** of Verify. It does not license
merging against a review that never saw the code being merged — canon forbids that at any setting.
When the wave moves the head, the pass is over and a fresh one begins.

| At the Ship gate | Action | Summonses spent |
|---|---|---|
| Head **equals** the review's attested SHA | merge | 1 |
| Review returned Medium/Low only — findings line or a `docket` issue, head does not move | merge | 1 |
| Review returned **must-fix** (Critical/High) — fix, then re-summon on the new head | merge once that review is clean | 2 |
| The second review also returns must-fix | **stop and hand to the HC** | 2 |

- **The comparison is derived, not enumerated.** `deliver` compares the pull request head to the SHA
  the recorded review attests. Anything that moved the head is caught — a fix wave, a late findings
  append, a rebase, a merge of `main` — rather than only the case that prompted the rule.
- **It is checkable rather than asserted.**
  [`tools/review/validate.ts`](../tools/review/validate.ts) refuses a review whose named commit is
  not the bound commit, and names what is missing. That module has no external file dependency and
  runs today, which is why it survived this issue's disposition of the seeded review tools.
- **The last row is the fix-verification bound, not a new rule.**
  [`config/review.md`](review.md) → *Fix-verification* gives fixes two passes and then escalates,
  on nine recorded instances of patching past that point moving a defect sideways. A second
  must-fix wave means the design is wrong, and that is the HC's call, not another round.
- **Step 7 of `verify` is what keeps row 1 the norm** — fix what the reviewer would flag *before*
  summoning, so the review confirms rather than corrects. Measured upstream at roughly 80% fewer
  contractor findings.

### What no setting reaches

- **Merging on the AC's own say-so is never available.** `attested` is not `auto`; there is no
  setting under which a pull request merges without an independent review bound to its head.
- **A run that cannot obtain an independent review stops and asks.** It never delivers unreviewed
  with a footnote. See [`config/review.md`](review.md) → *Reviewer roster*.
- **The acting harness is excluded from its own review.** nadal's ACs are Claude harnesses and its
  declared reviewer is Codex, so the chain is independent by construction. Stated plainly because
  `PROJECT.md` once claimed a script enforced this: **nothing does.** It holds by the roster having
  exactly one entry, which is not the acting harness.
- **The harness must also permit the merge.** Repository policy and agent-runtime permission are
  independent layers. If the runtime denies the command, `deliver` stops and says so rather than
  treating the denial as a gate failure.

### Where this does not reach

`attested` governs the delivered pull request of a lifecycle run. It is not licence to merge any
pull request: an intake or authoring pull request whose subject is *content judgment* rather than
code correctness still ends with a human disposing on it.
