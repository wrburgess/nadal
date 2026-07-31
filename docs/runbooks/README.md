# Runbooks

One runbook per operational flow; each SOW's manual-test segment cites the runbook it
exercises, and runbooks double as HC post-merge checklists.

- [login-assisted-scrape.md](login-assisted-scrape.md) — USTA/WTN pull with HC standing by to log in
- [build-and-print-dossiers.md](build-and-print-dossiers.md) — `tn report build` → browser → courtside binder

Planned (spec § Testing):

- pre-tournament-full-pull.md — refresh all scouted teams end to end
- in-event-screenshot-ingest.md — scorecard photo → tn match add → verified rows
- backup-restore.md — tn db backup / restore drill
