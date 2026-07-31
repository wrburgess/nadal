# Runbook: build and print the scouting dossiers

## When to use this

Any time you want the courtside binder: before Sectionals, after a fresh pull, or after Friday's
results land in the system. `tn report build` renders **from whatever is in the database right
now** — it never fetches. If the data is stale, the dossier is stale; pull first
([pre-tournament-full-pull.md](README.md) once it exists, or `tn team pull --players` per team).

Spec § Deliverables #5 is the destination: *printable reports → courtside binder; no laptop
required at the venue.*

## Before you start

- The database has been migrated: `tn db migrate`
- At least one team has been pulled: `tn team pull "<team name or URL>" --players`

## Steps

### 1. Check what the dossier will actually be able to say

```
tn team show "IA/Versteeg/40&Over3.5M"
```

Read the roster block. Every player should carry an age range and at least a TennisRecord dynamic
rating. **NTRP and WTN come only from the login-assisted path** — if those are missing for
everyone, run [login-assisted-scrape.md](login-assisted-scrape.md) before printing, or the binder
ships with a third of each rating row blank.

### 2. Build

```
tn report build sectionals
```

Writes one dossier folder per team on file, plus a top-level index, under `reports/` (override with
`TN_REPORTS_PATH`). Both forms are written every time: `index.html` (the one you print) and
`index.md` (the one an agent reads or you diff between runs).

One team only:

```
tn report build "IA/Versteeg/40&Over3.5M"
```

Expected summary line: `report build status=ok target="…" teams=N files=2N+2 root="…"`, exit 0.

### 3. Read one before you print all of them

Open `reports/<team-slug>/index.html` in a browser. Check:

- The roster is the roster you expect — a player missing here is a pull problem, not a report
  problem.
- Ratings look like ratings (no blanks where you ran the login-assisted pull).
- The **"Not collected yet"** block at the bottom names what has no data source yet. That block is
  load-bearing: it is how you tell *"this opponent has no tournament results"* from *"nadal cannot
  record tournament results yet."* Do not read an absent section as a fact about the opponent.

### 4. Print

⌘P from the browser → **Save as PDF** or straight to paper. The HTML is self-contained and
print-styled (US Letter, 0.5in margins, player blocks kept off page breaks), so it needs no network
and no stylesheet.

There is **no `tn report build --pdf`** in v1. The spec anticipated one riding "the Playwright
dependency the scrapers already carry", but no such dependency exists — the scrapers use plain
`fetch`. Adding a ~300 MB browser to print a page engineered to be printed is tracked as a
follow-up rather than assumed. ⌘P is the v1 path.

### 5. Re-run freely

`report build` is deterministic: the same database produces byte-identical files. Re-running after
a pull rewrites the binder in place, and `git diff` on the `.md` files shows exactly what changed
about an opponent since last time (useful mid-event).

## What "done" looks like

- `reports/index.html` lists every scouted team.
- Each team folder is named for the team, not a number, so the binder is navigable by tab.
- Each dossier prints without a horizontal scrollbar or a player block split across pages.

## Known limitations in v1

- **"Prior meetings vs our players" renders as unavailable until a home team is designated.**
  Run `tn team home "<your team>"` first (#37 / nadal ADR 0001) — once a home team is set, `report
  build` automatically populates this section for every OTHER team's dossier. It stays unavailable
  on the home team's own dossier (comparing a team against itself is not a meaningful section) and
  on any dossier built before a home team is designated at all.
- **The predicted lineup is a guess, and the dossier says so.** Every dossier now carries a
  *"Predicted lineup (a guess)"* section (#17 PR B). Read the confidence and the "Based on" column
  before planning against it: a row reading `placed by rating — no shared history` is not a
  prediction about pairings at all. The courts listed are the ones this team has been *seen* to
  field, not the event's format, and only matches belonging to **this team** count as evidence — the
  section says how many were excluded as belonging elsewhere. The rule itself, and how to read it
  critically, is in [predict-an-opponent-lineup.md](predict-an-opponent-lineup.md).
- **A team with no court matches of its own renders the lineup section as an explicit absence**
  rather than an empty table. Pull it with `tn team pull "<team>" --players` and rebuild.
- **`events` has no player-scoped writer yet** — hence the "Not collected yet" block for that
  section. `tn event add` (#17 PR B) creates events, but nothing yet associates a *player* with one
  (`tn team pull` writes a null `event_id`), so a dossier cannot say which events a player is on.
  Availability and captain notes DO have writers (`tn player avail`, `tn player note` — see
  [agent-chat-over-mcp.md](agent-chat-over-mcp.md)), scoped to the designated home team only.
