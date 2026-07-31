# Runbooks

One runbook per operational flow; each SOW's manual-test segment cites the runbook it
exercises, and runbooks double as HC post-merge checklists.

- [login-assisted-scrape.md](login-assisted-scrape.md) — USTA/WTN pull with HC standing by to log in
- [build-and-print-dossiers.md](build-and-print-dossiers.md) — `tn report build` → browser → courtside binder
- [agent-chat-over-mcp.md](agent-chat-over-mcp.md) — point an agent chat at `tn mcp serve`; capture
  availability and captain notes conversationally
- [predict-an-opponent-lineup.md](predict-an-opponent-lineup.md) — `tn lineup plan` → read the guess
  critically; record availability behind `tn event add`
- [in-event-screenshot-ingest.md](in-event-screenshot-ingest.md) — scorecard photo → agent →
  `match_add` → verified rows → what to do when a name is flagged

Planned (spec § Testing):

- pre-tournament-full-pull.md — refresh all scouted teams end to end
- backup-restore.md — tn db backup / restore drill
