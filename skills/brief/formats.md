# The Brief's formats

The bundled reference for [`SKILL.md`](SKILL.md): which form each target kind gets, the two
skeletons, and one frozen worked example per form. Fixed by the HC's format decision and the
Direction gate on [#96](https://github.com/wrburgess/deuce/issues/96), both of 2026-08-11.

## Which form, per target

| Target | Form |
|---|---|
| **Project** | Story leading, trimmed Scan after |
| **Epic** | Story leading, trimmed Scan after |
| **Issue** | Standalone Scan |
| **PR** | Standalone Scan |

Why the split: gaps between looks at a project or an epic are long and their state is a *shape* —
prose restores shape. Gaps on an issue or a pull request are short and their state is *discrete* —
a scan answers faster than a story.

**Story** — the prose half: two or three plain-language paragraphs that rebuild the target's
context from zero — what it is, why it exists, how it is being pursued, where it sits today.

**Scan** — the table half. Its shape is the Readout's discipline, linked and never restated —
[Chapter 1 → The Readout](https://github.com/wrburgess/deuce/blob/main/sds/01-lifecycle-and-skills.md#the-readout) — with the health
verdict standing as the ask; the skeletons below are that discipline applied. When a Story leads,
the Scan drops its What/Why/How rows — the Story just said them.

## Skeleton — combined form (Project, Epic)

```markdown
<Story: 2–3 short paragraphs — what this is, why it exists, how it is being
pursued, where it sits today. Plain words; cite as you go (#N, PR #N).>

**Health: <verdict>.** <The one-line reason; delayed/bottlenecked/blocked name their cause.>

<State table — children, fronts, or whatever the target's state actually is,
one row per thing, dates on activity.>

**Next steps**
1. <Best next step, cited — the one line "None — complete." when the verdict is complete.>
2. <…in order.>

**Needs from you**
- <Every point where the work waits on the HC's judgment or input — or "Nothing.">

**Unverified:** <what is unknown or assumed — omit the line only when nothing is.>
```

## Skeleton — standalone Scan (Issue, PR)

```markdown
**Health: <verdict>** — <the one-line reason>.

| | |
|---|---|
| **What** | <The target, fresh-eyes: what it is.> |
| **Why** | <Why it exists or matters.> |
| **How** | <How it is being pursued.> |

<State or block table when the target's situation needs one.>

**Next steps**
1. <… — "None — complete." when the verdict is complete.>

**Needs from you**
- <…or "Nothing.">

**Unverified:** <omit only when nothing is.>
```

## Worked example — combined form, on epic #7

Frozen at 2026-08-10; a dated example, not live state.

> This epic (#7) is deuce leaving home. Until now its standard has governed only this repository;
> the epic's job is the chapter that says how other repositories adopt it — what ships to them,
> what they own, how updates arrive — and then actually cutting the three host repositories over,
> retiring the predecessor system, ace, when the last one is done.
>
> The work ran in the order the risk demanded. The chapter itself was written and ratified first
> (PR #78, PR #79). Then the machinery it describes: a manifest of what ships (#81), a sync that
> delivers updates as reviewable pull requests (#82), and the credential that runs it, with its
> blast radius declared (#83). Then the hosts, one at a time — bryce went first as the canary,
> deliberately, so it would absorb the discovery, and its cutover merged today (PR #95). nadal
> (#86) and mpi-ace (#87) are meant to be repetition, not discovery. Alongside, #84 is reading
> ace's frozen record so nothing critical is lost in the succession, and #88 archives ace at the
> end.
>
> **Health: on track.** Six of ten children are merged, the riskiest one is behind us, and the
> next cutover came unblocked today.
>
> | Child | State |
> |---|---|
> | #80 chapter admitted · #81 manifest · #82 sync · #83 credentials · #90 canon URLs | Merged |
> | #85 bryce, the canary | Merged — PR #95, 2026-08-10 |
> | #84 port ace's frozen record | In progress |
> | #86 nadal | Ready — was waiting on #85, unblocked today |
> | #87 mpi-ace | Ready — follows #86 |
> | #88 archive ace | Ready — last, after every host is over |
>
> **Next steps**
> 1. #86 — nadal follows the canary; expected routine, and any surprise is a finding.
> 2. #84 — continues in parallel; it does not gate the cutovers.
> 3. #87, then #88.
>
> **Needs from you**
> - The pointer at #86 to start it. Nothing else — no question is waiting at a gate.

## Worked example — standalone Scan, on #57

Frozen at 2026-08-10; a dated example, not live state. Chosen for the blocked case, where the
Brief earns its keep — note the verdict naming its cause, and the labeled uncertainty line.

> **Health: blocked** — waiting on the findings-record conformance check, which the lint work has
> not yet delivered.
>
> | | |
> |---|---|
> | **What** | #57 — compute two of the four health measures (Quality, Throughput) instead of hand-copying them into every Delivery Record. |
> | **Why** | Hand-copying a number has a hand-copying error rate, and both measures are facts the review record and the tracker already hold. |
> | **How** | Quality parses the Verification's findings record; Throughput reads tracker timestamps. The other two measures stay honest — declared, or "un-instrumented" — never guessed. |
>
> | | |
> |---|---|
> | **Blocker** | Computing Quality means parsing the findings record, and nothing yet enforces that record's shape — the parser would be built on sand. |
> | **Path** | The conformance check lands with the lint work — #55 (repository documents) and #56 (tracker items), both ready and unstarted. |
>
> **Next steps**
> 1. Run the lint work first — that is the only unblock.
> 2. Then this issue becomes small: one script, and the honest labels stay on the un-computed
>    measures.
>
> **Needs from you**
> - One priority call: pull #55/#56 forward to unblock this, or leave both parked. It does not
>   unblock on its own.
>
> **Unverified:** which lint task (#55 or #56) carries the conformance check — #57 names the
> check, not its home.

## The originals

All four hand-run briefs of 2026-08-10, as posted on #96 — the project and PR examples live only
there:

- [Project](https://github.com/wrburgess/deuce/issues/96#issuecomment-5248114939) ·
  [Epic](https://github.com/wrburgess/deuce/issues/96#issuecomment-5248115370) ·
  [Issue](https://github.com/wrburgess/deuce/issues/96#issuecomment-5248115837) ·
  [PR](https://github.com/wrburgess/deuce/issues/96#issuecomment-5248116182)
- [The HC's format decision](https://github.com/wrburgess/deuce/issues/96#issuecomment-5257975280),
  which chose Story-leading for Project and Epic and Scan alone for Issue and PR. The examples
  above predate it, so the epic original carries an untrimmed Scan; the example here is the
  decided, trimmed form.
