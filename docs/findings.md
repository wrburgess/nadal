# Findings

Process-shaped observations captured during task execution, one line per entry.
Format: `- YYYY-MM-DD - <kind> - <one line>`.

- 2026-07-29 - process - `codex:rescue`-invoked adversarial reviews write job records as `task-*.json` (kindLabel `rescue`) in the plugin state dir, not `review-*.json` as the "find the job record" runbook step assumes — grep by branch across `*.json`, not `review-*.json`, to find them.
