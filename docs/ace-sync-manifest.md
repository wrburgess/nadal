# ace-sync manifest

nadal vendors the ace baseline (factory model — spec § Factory model and SDLC).
Re-sync: `ruby <ace>/bin/ace-sync --from <ace> <nadal>`, then reconcile via `git diff`
(PROJECT.md and bin/setup are preserved automatically).

| Date | ace SHA | Notes |
|------|---------|-------|
| 2026-07-29 | 46fdbb89d4e6dd30a63f01d58c0c75d9feb32608 | Initial vendoring |

Known local deltas reapplied after any re-sync:
- `.claude/settings.json` — model pin (Task 3)

Local statements awaiting an upstream fix — **collapse into the canonical text when it arrives**,
rather than carrying both:
- `PROJECT.md` → *Findings-Log Discipline* + *Rule-suggestion disposition* → *How nadal reads it*
  (#35). These override four vendored instructions that direct the opposite disposition for a
  process finding — `rules/self-review.md` → *Anti-Patterns*, `rules/self-review.md`'s asks-ledger
  ("delivered or handed to a tracked follow-up", also executable in `ship`'s `asks_ledger` contract),
  `final` Step 1, and the `scout` / Learnings-Log reflex. They also declare a **nadal-local
  rule-suggestion value, `log-and-continue`**, which is deliberately not one of the two shipped
  values. The canonical fix is
  [wrburgess/ace#159](https://github.com/wrburgess/ace/issues/159); **on the re-sync that carries it,
  check whether the vendored text now states the discipline itself, and if so delete the local
  statement instead of reapplying it.** `PROJECT.md` is preserved automatically, so this delta
  survives a re-sync silently — which is exactly why it needs a written expiry rather than trusting
  a future reader to notice it went stale.
