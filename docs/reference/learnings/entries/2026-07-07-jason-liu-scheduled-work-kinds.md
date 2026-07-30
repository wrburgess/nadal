---
date: 2026-07-07
source:
  person: Jason Liu
  link: https://jxnl.co/writing/2026/06/28/two-kinds-of-scheduled-work-in-codex/
  medium: blog
claim: >
  Distinguish Scheduled Tasks (a fresh-context thread every run) from Scheduled Messages (a persistent
  thread where each run builds on the last).
stance: extends
touches: skills/scout
status: noted
---

## Compare / contrast

Published 2026-06-28. Liu distinguishes two kinds of scheduled agent work: **Scheduled Tasks**, which
start a fresh-context thread each run, versus **Scheduled Messages**, a persistent thread where each
run builds on the previous one.

This **extends** the scheduled intake-sweep design (`ADR-0013`, `docs/guides/intake-sweep-scheduling.md`)
by naming the choice the design already makes implicitly: `scout` is a fresh-context **Scheduled
Task** — it runs identically whether invoked by hand or by a schedule, and an empty sweep is log-only
with no state carried forward. The fresh-vs-persistent framing is a clean decision lens for the
scheduling guide.

## Disposition

`noted` — candidate vocabulary to cite in `ADR-0013` / the scheduling guide to make explicit *why*
`scout` is stateless-per-run (a Scheduled Task, not a Scheduled Message). No behavior change.
