---
name: brief
description: Not a lifecycle stage — a standing procedure, summoned at any point. The HC asks where something stands — the project, an epic, an issue, or a PR; read the target from the tracker as it is and deliver the Brief in conversation, fresh-eyes — a description assuming no context, a health verdict, next steps, and what the work needs from the HC.
---

# brief — where anything stands, on demand

The packaged procedure for the standing job of restoring the HC's context. Not one of the five
stages: its governor is
[Chapter 1 → Skills](https://github.com/wrburgess/deuce/blob/main/sds/01-lifecycle-and-skills.md#skills), and what a Brief contains
was settled on #96 — the format decision and the Direction gate there are this Skill's charter.
The formats themselves, with skeletons and worked examples, are the bundled reference:
[`formats.md`](formats.md).

## When it is invoked

The HC asks where something stands — "brief 96", "brief PR #95", "brief epic #7", "brief the
project" — or any phrasing that asks for status, orientation, or a catch-up on one of the four
target kinds. The reader to write for is the HC returning after time away, holding nothing.

## Procedure

1. **Resolve the target kind** — project, epic, issue, or pull request. A target that is ambiguous
   or unresolvable is a stop (trigger 4), never a guess.
2. **Read the target from the tracker and the repository as they are — never from conversation
   memory.** Conversation context is exactly what the HC has lost; a Brief built from it inherits
   the staleness it exists to cure. What "read" means per kind:
   - **A pull request:** its state, files, checks, the issue it carries, and what its landing
     completed or unblocked.
   - **An issue:** title, body, labels, every comment, its epic, its pull request if one is open,
     and its blockers as the record names them.
   - **An epic:** its body, and every child's state — labels, open pull requests, the blockers
     among them.
   - **The project:** every epic and its state, the open issues by `status:` label, and what
     merged recently.
3. **Read [`rules/authoring.md`](../../rules/authoring.md)** at the moment of writing — the Brief
   is written for exactly the reader the register rule protects.
4. **Compose per [`formats.md`](formats.md)** — the four parts in order: the fresh-eyes
   description (what it is, why it exists, how it is being pursued), the health verdict from the
   table below, the best next steps, and what the work needs from the HC. Every claim cites its
   source per the
   [reference grammar](https://github.com/wrburgess/deuce/blob/main/sds/00-identity-and-governance.md#work-tracking-system),
   dates ride on activity so staleness is visible, and uncertainty is carried per the Scan's
   discipline in [`formats.md`](formats.md), which the skeletons' `Unverified:` line enforces.
5. **Deliver the Brief in conversation, and touch nothing on the tracker** — no label moves, no
   comments. The Skill is read-only by charter: reporting sits outside the lifecycle, and a
   durable copy of live state is a stale copy (the Direction gate on #96, Option 1).

## The verdict table

Exactly one verdict per Brief, and the three that name a cause always name it.

| Verdict | Means |
|---|---|
| **on track** | Moving as expected. |
| **delayed** | Moving, slower than expected — and the Brief says why. |
| **bottlenecked** | Moving, but one named thing constrains the pace — and the Brief names it. |
| **blocked** | Not moving; waiting on something named — the `status:blocked` discipline, applied to prose. |
| **complete** | Done, nothing outstanding. |

## Terminal artifact

The Brief, delivered in conversation and deliberately unposted. Why unposted is the charter's
reasoning: a Brief restates live state, so its value dies as the state moves, and the tracker
already holds the durable truth every Brief derives from.

## When it stops and asks

On any of the four standing triggers —
[Chapter 1 → Stops](https://github.com/wrburgess/deuce/blob/main/sds/01-lifecycle-and-skills.md#stops). The named example here is
trigger 4: an unresolvable target, or an unreachable tracker. The read-only charter binds the
Brief's delivery, never a stop's own record.

## Prior art

Born on [#96](https://github.com/wrburgess/deuce/issues/96). The four hand-run briefs of
2026-08-10 posted there are the job done before the Skill existed — the entry-bar receipts — and
the HC's decisions there fixed the formats (2026-08-11), the delivery (conversation, unposted),
and the name: `brief` rather than `status`, because the AC's harness intercepts a literally typed
`/status` as its own built-in — the same collision class that named `devise` over `plan`
([Chapter 1 → The audit](https://github.com/wrburgess/deuce/blob/main/sds/01-lifecycle-and-skills.md#the-audit)).
