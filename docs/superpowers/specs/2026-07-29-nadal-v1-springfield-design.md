# nadal v1 — Springfield Design

**Date:** 2026-07-29
**Status:** Approved by Randy (HC) in brainstorming session
**Epic:** [wrburgess/nadal#1](https://github.com/wrburgess/nadal/issues/1)

## Destination

Randy walks into the USTA Missouri Valley 40+ 3.5 Men's Sectionals in Springfield, MO (**Aug 28–30, 2026**) with complete scouting dossiers on every opposing team and a lineup-building tool. Everything in the epic beyond that — UTR, Tencap, broader league coverage, any web UI — is sequenced after Aug 28 or forked into a later, generalized application. "nadal" is a holding name for the project; the CLI binary is `tn`.

## Problem context

Randy captains **HOA/Burgess-Zingg/40&over3.5M** (Heart of America district). The Sectionals field is currently five teams — Burgess-Zingg (HOA), Versteeg (IA), Penland (NE), Dickason (OK), Petruska (STL) — **and may still grow**. Format: single round robin; each team match fields four courts (S1, D1, D2, D3), seven players. Last year's event (Tulsa, Aug 23–24 2025) used two pools of four plus a playoff and five courts (S1, D1–D4) — so tournament format is per-event data, never a constant.

Scouting a team today means, per player: TennisLink match history, USTA Player Search (NTRP + rating type, uaid), WTN profile (singles/doubles WTN, age range), TennisRecord (dynamic rating) — hand-copied into a spreadsheet that stores facts but can't answer questions (partners live in prose notes, no match-level data under the aggregates, everything stale on arrival). nadal replaces the collection and synthesis; the judgment stays with Randy.

2026 travel roster (11): Bierman, Burgess, Chettiar, Halksworth *(Sat–Sun only)*, Jacobs, Johnson, JT (Jerry) Martin, Merritt, Morris, Plungkhen, Zingg.

## Deliverables

1. **Per-opponent scouting dossiers** — roster with age range, NTRP (+ rating type C/S/A/D/M), WTN singles/doubles, TennisRecord dynamic rating; last-six-months singles/doubles records; results within this tournament; court-assignment tendencies; partner frequency; prior meetings vs. our players; and a **predicted lineup honestly labeled a guess**.
2. **Own-team book** — same cold data plus Randy's subjective layer (captain notes, availability).
3. **Pre-tournament lineup planning** — agent-chat sessions working singles/doubles disposition, pairings, heat/conditioning, double-duty days; per-match court assignments decided at the event.
4. **In-event updates** — Friday's results in the system before Saturday's planning, via screenshot ingestion.
5. **Printable reports** — markdown dossiers → courtside binder; no laptop required at the venue.

## Domain model

Nine stored entities; everything else is derived at query time so it can never go stale.

| Entity | Purpose |
|---|---|
| **Player** | One real person: canonical name, name aliases ("JT Martin" ↔ "Jerry Martin"), per-source IDs (USTA uaid, WTN tennis-id, TennisRecord name-key), age range. |
| **Team** | e.g. `IA/Versteeg/40&Over3.5M`, with section/district. |
| **TeamMembership** | Player ↔ team ↔ event; rosters differ per event (district roster ≠ travel roster). |
| **Event** | Competition context (district season, Tulsa 2025, Springfield 2026). Carries format as data: court slots, pools vs. RR, dates. |
| **TeamMatch** | Team vs. team within an event: date, result. |
| **CourtMatch** | One court of a TeamMatch: slot, players per side, winner, set scores incl. match-tiebreak notation. Player match histories ingest from TennisLink player pages **including their other leagues** (18+ etc.), keeping league/match-type context. |
| **RatingObservation** | Dated, source-attributed rating snapshot (NTRP + type, WTN S, WTN D, TR dynamic). Time series — drift is signal. |
| **Availability** | Structured per-player per-event-day (machine-readable; lineup planning depends on it). |
| **CaptainNote** | Randy's subjective layer on a player or pairing. Populated for our team only, by design. |

Derived (not stored): windowed W/L records, court-slot tendencies, partner frequency, prior-matchups, predicted lineups.

Scope boundary: full histories are ingested for players **on scouted teams**, not the whole USTA universe.

## Ingestion

Four paths, one discipline:

1. **TennisLink (public)** — team pages, player match histories, championship scorecards. Playwright, politely paced (courtgrab2 lineage).
2. **USTA Player Search + WTN (login-assisted)** — headed Chrome; Randy logs in; script detects completion and walks the list (courtgrab2's proven pattern).
3. **TennisRecord (public)** — dynamic rating; ad dismissal handled.
4. **Screenshots (in-event only)** — scorecard photos → agent vision → structured results via MCP write tools. Every extracted name must resolve against known rosters or is flagged, never guessed.

Discipline, all paths: **idempotent upserts** (re-run anytime, nothing duplicates) and **every fetch saves its raw HTML/PNG** timestamped under `raw/` — the TDD substrate and the re-parse archive. Identity resolution at ingest: source IDs first, alias table second, fuzzy match **with HC confirmation** third; never a silent merge.

## Interfaces

One service layer, three thin presenters (bryce's architecture; not its vocabulary).

### CLI — `tn`

Grammar: `tn <noun> <verb> <target> [payload] [flags]`. **Prefix-ID targets**: bare text = name lookup; `usta:`, `wtn:`, `tr:` select an ID namespace. Ambiguous names error with candidates listed. One spelling per operation; help fits one screen; deterministic summary line; non-zero exit on failure.

```
tn team   pull  <name|url>  [--players]     # scrape/refresh team; --players cascades roster
tn team   show  <name>      [--json]
tn team   list
tn player pull  <name|usta:|wtn:|tr:>
tn player show  <name|usta:…> [--json]      # full profile: ratings trajectory, history, records
tn player note  <name|usta:…> "<text>"
tn player list  [--team <name>]
tn match  add   <file>                      # scorecard screenshot/HTML → structured result
tn event  show  [<name>]
tn lineup plan  <opponent>
tn report build [sectionals|<team>]
tn db     migrate | backup | restore
```

Global flags only: `--quiet/-q`, `--json`, `--help`. Flag style is GNU (`--long`/`-s`), max one short alias per flag. The grammar lives in `docs/cli/GRAMMAR.md`; a **grammar-parity test fails CI** when the command table and the doc diverge.

### MCP

Same services; tool names mirror the grammar (`team_pull`, `player_show`, `lineup_plan`, …). Agent chat is the analysis/planning surface and where captain notes are captured conversationally.

### Reports

Deterministic markdown from DB state: per-opponent dossier, own-team book, matchup sheets.

### Request telemetry

Every CLI command and MCP tool call writes a **RequestLog** row via service-layer middleware: surface (cli|mcp), command/tool name, sanitized args, start/end time, outcome. Operational table, not a domain entity. **Capture ships in v1** — it cannot be retrofitted onto requests that were never logged. Analysis is deferred to triage sessions, where the log answers two questions: what does usage actually look like, and which repeated ad-hoc agent patterns (hand-rolled analysis, rendering, etc.) deserve promotion to named `tn` commands or MCP tools. Token/cost attribution is harness-side knowledge (Claude Code OTEL/cost export), not app-visible; wiring it to the request log is a logged finding for post-Springfield.

## Stack

TypeScript / Node 22, SQLite (better-sqlite3 + drizzle), vitest, Playwright for scraping, Hono for the MCP server. Zero-ops on a hotel laptop. courtview/courtgrab2 are mined for domain knowledge and scraping know-how, not code.

## Factory model and SDLC

- **ace is the factory; nadal is a product.** Vendor a snapshot of the ace baseline via `ace-sync` with a manifest recording the ace SHA. Upgrades are deliberate re-syncs. **nadal never edits vendored files**; parity check fails CI on drift. Project-local layer: reviewer config, human gates, protected branches (values ace already externalizes).
- **Anti-bloat, mechanical:**
  - `docs/findings.md` — append-only, one line per finding (`date · type · gist`). Findings become work only at an explicit HC-triggered triage (dispositions: do-now / upstream-to-ace / drop). No Issues, PRs, rules, or ADRs spawn directly from findings.
  - Process improvements are ace's jurisdiction, upstreamed in batches. nadal writes zero local rules files.
  - nadal ADRs: application decisions only, passing distill's three-part test (hard to reverse, surprising later, real trade-off). Target O(10), not O(60).
  - **PRs must advance Springfield or fix defects.** Everything else is a findings line.
- **Merge gate:** green CI (typecheck, lint, vitest, coverage floor) **plus adversarial review by a different model** (default: GPT via Codex runtime for Claude-authored PRs), review bound to the PR SHA. Then **AC merges — no human gate.**
- **Planning process:** wayfinder map issue on the nadal repo (decision tickets as sub-issues, one resolved per session) with ace's distill as the grilling method inside HITL tickets, capturing terminology to CONTEXT.md and sparing ADRs.

### Model routing (execution profile)

**Ceiling rule: Opus at high effort is the maximum for nadal work.** Fable runs only when the HC explicitly invokes it (as in the kickoff session); routine work never does.

Enforcement, stated honestly (per ace [#143](https://github.com/wrburgess/ace/issues/143)'s framing):
- **Executable** — project settings pin the repo's default session model (Opus); role agents in `.claude/agents/*.md` carry model + reasoning effort, honored at every delegation boundary; the Codex reviewer's effort is runtime config.
- **Advisory** — step-level routing inside one session. A session cannot hot-swap its own model; finer granularity than delegation boundaries is prose, and is labeled as such.

Profile v0 (step → model/effort):

| Step | Model / effort |
|---|---|
| Driver sessions: grilling, planning, judgment, lineup analysis | Opus / high |
| SOW execution (TDD implement) | Sonnet / high; escalate to Opus when stuck, escalation noted on the issue |
| Mechanical steps: scaffolding, fixture capture, report/SOW writeups, findings appends | Haiku or Sonnet / low |
| Adversarial PR review | GPT family via Codex (model diversity is the requirement), high |
| AFK research tickets | Sonnet / medium |

nadal is the **proving ground for ace #143**: observations about this table (what under-thought, what over-spent) go to the findings log and upstream into the #143 assessment. The table's durable home is ace's `PROJECT.md § Execution Profile` once #143 lands; until then it lives in nadal's project-config layer — config values, not vendored-file edits, so no drift.

## Operating loop

**Prime rule: GitHub is the only memory between sessions.** Sessions open by reading the map/queue and end by writing state back. Nothing load-bearing lives only in chat context.

Work units: **decision tickets** (wayfinder) and **build SOWs** — implementation issues sized at cut-time to fit one session.

Build-session lifecycle: **claim** (top open, unblocked, unassigned; self-assignment is the claim) → **isolate** (fresh worktree + branch) → **build** (TDD, red before green) → **PR** (SOW template: what/why, failing-test-first evidence, runbook segment, findings appended) → **adversarial review** (cross-model, SHA-bound) + green CI → **merge + handoff comment** (what changed, what's unblocked) → **stop**. Long sessions checkpoint: push branch, write resumable state to the issue, end.

**HC steps — exhaustive; everything else is AC:**
1. Answer grilling questions (always sequential, one at a time).
2. Stand by for USTA/WTN logins during scheduled scrape runs.
3. Provide in-event screenshots.
4. Run post-merge runbook segments flagged by a SOW.
5. Triage the findings log at will.
6. Steer or interrupt anytime — nothing waits on HC except the above.

Parallelism: independent SOWs may run as worktree-isolated parallel sessions. Sandcastle/warren-style dispatched workers are a later upgrade that preserves this loop's shape (ephemeral run → branch out); logged as an ace-side finding, not built now.

## Testing and verification

- **TDD** (red → green, vertical slices) at pre-agreed seams: service functions, parsers, CLI router surface, MCP tools.
- **Parsers test against raw captured pages** (including last year's Tulsa scorecards) with expected values hand-verified once — regression anchors, not snapshot tautologies.
- **Live smoke tests** (real sites) stay out of CI, run on demand.
- **Coverage floor** enforced in CI.
- **Runbooks** in `docs/runbooks/` — one per operational flow (pre-tournament full pull, login-assisted scrape, in-event screenshot ingest, backup/restore). Each SOW's manual-test segment cites the runbook it exercises; runbooks double as HC post-merge checklists.

## Build phases (sketch — detailed in the implementation plan)

0. Vendor ace baseline + project config (reviewer = cross-model, merge policy, findings log, `GRAMMAR.md` seed) — mirrors bryce #1.
1. Scaffold TS project, schema, `tn db migrate`.
2. Parsers from fixtures (TennisLink team/player/scorecard; USTA profile; WTN; TennisRecord), TDD against captured pages.
3. Pull pipelines (`tn team pull`, `tn player pull`, login-assisted flow).
4. Profiles and dossiers (`tn player show`, `tn team show`, `tn report build`).
5. Lineup planning surface + MCP server.
6. Screenshot ingestion (`tn match add`), fixtures from Tulsa 2025.
7. Runbooks, courtside binder, dry run.

Deadline shape: data complete and dossiers printed by ~Aug 24; screenshot path proven on 2025 fixtures before travel; planning sessions the final week.

## Out of scope (v1)

UTR and Tencap sources; web UI; whole-USTA ingestion; multi-user; sandcastle/warren-style worker infrastructure; `ace new` project stamper (ace-side finding); any self-improvement PRs.

## Open questions → wayfinder tickets

- Springfield match schedule (TennisLink shows "Not Scheduled") — plan under uncertainty until published.
- Predicted-lineup heuristic — how court-assignment history + ratings become a labeled guess.
- Dossier layout — what Randy wants on one page per opponent.
- Lineup-planning data shape — how pairings/scenarios are stored and compared.
- Scrape cadence pre-tournament; field-growth watch (new teams joining).
