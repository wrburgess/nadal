# Findings

Process-shaped observations captured during task execution, one line per entry.
Format: `- YYYY-MM-DD - <kind> - <one line>`.

- 2026-07-29 - process - `codex:rescue`-invoked adversarial reviews write job records as `task-*.json` (kindLabel `rescue`) in the plugin state dir, not `review-*.json` as the "find the job record" runbook step assumes — grep by branch across `*.json`, not `review-*.json`, to find them.
- 2026-07-30 - process - `enforce-clean-tree.sh` blocks the *whole* multi-line Bash tool call when any single segment is a destructive git op on a dirty tree, not just that segment — an earlier harmless command (e.g. `rm -f`) chained before the blocked `git checkout --` in the same call silently never runs either; split destructive git ops into their own Bash call to avoid losing sibling commands.
