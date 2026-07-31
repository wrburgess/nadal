# Runbooks

One runbook per operational flow; each SOW's manual-test segment cites the runbook it
exercises, and runbooks double as HC post-merge checklists.

- [login-assisted-scrape.md](login-assisted-scrape.md) — USTA/WTN pull with HC standing by to log in
- [build-and-print-dossiers.md](build-and-print-dossiers.md) — `tn report build` → browser → courtside binder
- [agent-chat-over-mcp.md](agent-chat-over-mcp.md) — point an agent chat at `tn mcp serve`; capture
  availability and captain notes conversationally
- [predict-an-opponent-lineup.md](predict-an-opponent-lineup.md) — `tn lineup plan` → read the guess
  critically; record availability behind `tn event add`
- [db-migration-recovery.md](db-migration-recovery.md) — `tn db migrate` fails on an existing
  database; the one-line recovery and why losing the database costs nothing by design

Planned (spec § Testing):

- pre-tournament-full-pull.md — refresh all scouted teams end to end
- in-event-screenshot-ingest.md — scorecard photo → tn match add → verified rows
- backup-restore.md — tn db backup / restore drill
