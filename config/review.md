---
date: 2026-08-11
source: the Direction gate on #146; the lens menu and the fix-verification bound were nadal's own, previously stranded in PROJECT.md → Review Lenses; the roster's readiness proof was run on 2026-08-11
---

# Review configuration

Who nadal can summon for an independent review, how reachability is checked, which lenses are on the
menu, and how many one summons carries. The rules these values instantiate are deuce's, at
[Chapter 2](https://github.com/wrburgess/deuce/blob/main/sds/02-review-and-findings.md); this is adaptive configuration under
[Chapter 1](https://github.com/wrburgess/deuce/blob/main/sds/01-lifecycle-and-skills.md) → *The adaptive layer's home*.

**Section shape, not frontmatter, and that is deliberate.** deuce moved these values into frontmatter
at `0ceeebb` (#103). nadal vendored `90ee01a`, which is earlier, so the readers in this repository —
[`tools/review/roster.ts`](../tools/review/roster.ts) and
[`tools/review/lenses.ts`](../tools/review/lenses.ts) — parse the **markdown sections below**.
Copying deuce's current `config/review.md` here would not parse. When a later sync brings the
frontmatter readers, this file moves with them and not before.

## Reviewer roster

| Reviewer | Mechanism | Response | Readiness check |
|---|---|---|---|
| **Codex CLI** | `codex exec` | the output it returns; the summons and the returned review both land on the pull request | `codex login status` |

- **Proof at declaration, run rather than assumed:** `codex-cli 0.147.0` installed;
  `codex login status` exited 0 ("Logged in using ChatGPT") on 2026-08-11.
- **One row, deliberately.** `parseRoster` throws on a second — reviewer selection is not built, and
  silently dispatching the first row would make a declared second reviewer unreachable without a
  trace. A candidate enters as a row when its readiness check has actually run.
- **Undeclared until proven:** GitHub Copilot review (present on the account, review path unproven
  here), a second Claude model via the Claude CLI (present, no side-effect-free auth check found).
- **The readiness check is side-effect-free and runs *before* the summons**, so an unauthenticated
  runtime falls back immediately rather than burning the window on a summons nobody receives.
- **The acting harness is never its own reviewer.** nadal's ACs are Claude harnesses and its reviewer
  is Codex, so the chain is independent by construction. That is discipline, not a checked control —
  see [`PROJECT.md`](../PROJECT.md) → *Reviewer*, which used to claim a runtime enforced it.

## Lens menu

Six lenses, each derived from a defect class this repository has actually recorded — not from a
generic catalogue. Every entry is stated as a question, which
[`lenses.test.ts`](../tools/review/lenses.test.ts) enforces.

- `does this guard enumerate cases, or derive from structure?`
- `can two different facts collide on one key, or one fact split into two?`
- `does the error path do something weaker than the happy path?`
- `has this code ever executed, and is every field it produces ever read?`
- `does any comment, test title, doc or PR sentence assert more than the code enforces?`
- `does any check-then-act window here survive two processes — not two threads — against a WAL database?`

**The permanent lens is not on this list, and its absence is not an omission.** *What class is not on
this list?* is appended to every summons by `composeSummons` itself
([`compose.ts`](../tools/review/compose.ts) → `PERMANENT_LENS`); listing it here would send it twice.
It is also the highest-yield lens on record here — a menu necessarily enumerates the defects already
known, and a pass that keeps returning one class is not evidence that the others are absent.

**A one-off lens enters as a dated entry above, never as a bypass.** `checkLensSelection` refuses a
lens that is neither on this menu nor one of canon's four prose lenses, and refuses a prose lens on a
code subject.

**What this menu has no backstop for.** Upstream, each entry links to its class in
`findings/classes.md` and a test holds the two sets one to one. nadal has no class index — its
findings are a flat log in [`docs/findings.md`](../docs/findings.md) — so nothing checks that this
menu still matches the classes the log records. Revising it is a reading exercise, and it is owed
whenever the recorded classes shift.

## Lens-set size

**3 lenses** per summons, plus the permanent lens that rides along.

[`PROJECT.md`](../PROJECT.md) → *Review Lenses* stated the bound as "3–4 per summons" while nothing
parsed it. The parser reads a single number, so the range collapses to its lower bound: **3**, and
`PROJECT.md` now says 3 and points here. Taking the lower end is the deliberate choice — this is a
menu, not a checklist, and running every lens on every change rebuilds the unbounded pass in a new
costume.

## Fix-verification

**Two passes, then escalate.** Code written in response to review findings is the least-reviewed code
in a change — authored after the pass that would have caught it — so it gets two verification passes
rather than the lens set.

**Escalate on recurrence rather than iterate.** If a fix-verification pass finds a defect *in the
fixes themselves* beyond that limit, the design is wrong and the AC stops and says so. Nine recorded
instances in this repository show patching past that point moving the same defect one step sideways
rather than closing it.

Nothing parses this section; the number lives here because this is where the review bounds are read,
and splitting it from the lens bound would put two halves of one policy in two files.

## What is declared here and not yet executable

[`tools/review/summon.ts`](../tools/review/summon.ts) would run this declaration as one orchestrated
command — readiness, compose, dispatch, validate, record — but it reads
`sds/02-review-and-findings.md` and `findings/accepted.md` at **runtime**, both hardcoded, and nadal
holds neither. Re-pointing them means first deciding what nadal's accepted register and severity
source are, which is a findings-system question — declined on #146's record and tracked as
[#155](https://github.com/wrburgess/nadal/issues/155).

Until then the summons is **hand-run** — `codex exec - < summons.md` — and
[`tools/review/validate.ts`](../tools/review/validate.ts) is run against the returned review, which
is the part that matters for the Ship gate: it refuses a review whose named commit is not the commit
being merged. See [`config/gates.md`](gates.md).
