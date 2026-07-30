# ace-sync manifest

nadal vendors the ace baseline (factory model — spec § Factory model and SDLC).
Re-sync: `ruby <ace>/bin/ace-sync --from <ace> <nadal>`, then reconcile via `git diff`
(PROJECT.md and bin/setup are preserved automatically).

| Date | ace SHA | Notes |
|------|---------|-------|
| 2026-07-29 | 46fdbb89d4e6dd30a63f01d58c0c75d9feb32608 | Initial vendoring |

Known local deltas reapplied after any re-sync:
- `.claude/settings.json` — model pin (Task 3)
