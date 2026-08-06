# Runbook: build and print the scouting dossiers

## When to use this

Any time you want the courtside binder: before Sectionals, after a fresh pull, or after Friday's
results land in the system. `tn report build` renders **from whatever is in the database right
now** — it never fetches. If the data is stale, the dossier is stale; pull first
([pre-tournament-full-pull.md](pre-tournament-full-pull.md) for the full team-by-team refresh, or
a single-team pull for one team).

Spec § Deliverables #5 is the destination: *printable reports → courtside binder; no laptop
required at the venue.*

## Before you start

- The database has been migrated: `tn db migrate`
- At least one team has been pulled. **Read the name at a prompt rather than typing it into the
  command** — a team name is scraped data, and pasting one between quotes lets a `"` or `'` in it
  close the argument and run whatever follows (see
  [pre-tournament-full-pull.md](pre-tournament-full-pull.md) step 2 for the full reasoning):
  ```sh
  printf 'team name (or its TennisRecord URL): '; IFS= read -r team
  tn team pull "$team" --players
  ```

## Steps

### 1. Check what the dossier will actually be able to say

```
tn team show "IA/Versteeg/40&Over3.5M"
```

Read the roster block: every scouted player should be listed (someone missing here is a pull
problem, not a report problem), with an age range wherever the team page carried one and a real
singles/doubles record once matches are on file. **`tn team show` does not print ratings at all** —
its `RosterMemberProfile` (`src/query/team-profile.ts`) carries no rating field by design; ratings
live on the player, not this team-level read. To spot-check ratings before building, read a player
directly:

```
tn player show "Avery Ashby"
```

The `ratings: …` line (e.g. `ratings: NTRP 4.0C, TR-Dyn 3.67`, or `ratings: none on file`) is what
the dossier will actually print for that player. **NTRP and WTN come only from the login-assisted
path** — if a player's line carries only TennisRecord's dynamic rating (or nothing at all), run
[login-assisted-scrape.md](login-assisted-scrape.md) before printing, or the binder ships with a
third of each rating row blank.

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

**If you have recorded Springfield's own court format** (a one-time setup step —
`tn event add "Springfield Sectionals 2026" tournament 2026-08-28 2026-08-30
"S1:singles,D1:doubles,D2:doubles,D3:doubles"`, per
[predict-an-opponent-lineup.md](predict-an-opponent-lineup.md) step 0), name it as a trailing
argument and EVERY dossier this run writes uses that format's courts instead of each team's own
observed history:

```
tn report build sectionals "Springfield Sectionals 2026"
```

An unknown event name, or one on file with no format, refuses the WHOLE build (nothing written) —
the same two refusals `tn lineup plan` gives, since a partial batch built under two different
understandings of "the event" would be worse than no batch at all.

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

There is **no `tn report build --pdf`**, and that is now a **decision, not a deferral**
([#36](https://github.com/wrburgess/nadal/issues/36)). The spec anticipated one riding "the Playwright
dependency the scrapers already carry", but no such dependency exists — the scrapers use plain `fetch`.

**Why it was declined — scope and cost, stated plainly, and stated smaller than an earlier draft did.**
Be accurate about what `--pdf` would actually save, because the first version of this paragraph
undercounted it: `tn report build sectionals` **is** a batch — it writes every team's dossier in one
command — so printing that binder is one ⌘P-and-save **per team**, not one keystroke total. A `--pdf`
mode would collapse those N print operations into the batch that already exists. That saving is real and
grows with the field.

It is still not worth it here, and the honest reason is proportion: the saving is a handful of manual
saves, a handful of times, for **one event** — against a permanent ~300 MB browser dependency that CI
would download on every run of every PR (`actions/setup-node`'s `cache: npm` does not cover
`~/.cache/ms-playwright`), this module's first non-deterministic artifact, and a fidelity question
nobody has answered yet (below). What does **not** support the decline is any claim that there is
nothing to automate. There is; it is just small, bounded, and one-off.

**What is *not* claimed, because an earlier draft of this paragraph claimed it and was wrong.** It would
be convenient to say a `--pdf` flag renders "the same page you get from ⌘P". That does not follow, and
the difference cuts *toward* this decision rather than against it: this runbook never pins which browser
you print from, and a headless Chromium PDF pipeline is separately configured from a print dialog
(backgrounds, scale, headers/footers, and printer settings are all dialog-side choices). Concretely:
Playwright's `page.pdf()` defaults `preferCSSPageSize` to `false`, so out of the box it **scales the
page instead of honouring the `@page` rule** — the very rule this binder's letter/0.5in layout depends
on. So a `--pdf` path would need its **own** fidelity verification against real dossiers — work this decision avoids
rather than work it saves. What the repo does guarantee is narrower and is what actually matters here:
the print CSS is **inlined into every generated file** (`@page` letter/0.5in, `page-break-inside: avoid`
on each player block), so the page you preview needs no network and no external stylesheet.

If a real need for unattended or run-to-run-identical PDFs ever appears, that is the argument that would
reopen this — not print quality. The decision is cheap to reverse, and
`test/cli-report-build-command.test.ts` holds the test that has to be changed to do it.

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
  Designate one first (#37 / nadal ADR 0001) — `printf 'our team: '; IFS= read -r team` then
  `tn team home "$team"`, per the prompt rule in *Before you start* — once a home team is set, `report
  build` automatically populates this section for every OTHER team's dossier. It stays unavailable
  on the home team's own dossier (comparing a team against itself is not a meaningful section) and
  on any dossier built before a home team is designated at all. **The two cases now say which one
  you are looking at**: the home team's own dossier reads *"Not available on our own team's dossier
  — this section compares an opponent's roster against ours"*, and only a genuinely unset home team
  reads *"no home team configured"*. Until #19 both printed the second sentence, so the home team's
  own dossier announced that no home team was configured immediately after `tn team home` had
  succeeded — if you are holding a binder printed before that fix, read that line as "this is our
  team", not as a failed designation.
- **The predicted lineup is a guess, and the dossier says so.** Every dossier now carries a
  *"Predicted lineup (a guess)"* section (#17 PR B). Read the confidence and the "Based on" column
  before planning against it: a row reading `placed by rating — no shared history` is not a
  prediction about pairings at all. **By default** the courts listed are the ones this team has been
  *seen* to field, not the event's format — name the event on the build (step 2's setup note, #63)
  to use its own courts for every dossier instead — and only matches belonging to **this team** count
  as evidence — the section says how many were excluded as belonging elsewhere. The rule itself, and
  how to read it critically, is in [predict-an-opponent-lineup.md](predict-an-opponent-lineup.md).
- **A team with no court matches of its own renders the lineup section as an explicit absence**
  rather than an empty table. Pull it (the prompt form in *Before you start*) and rebuild.
- **A registered roster scopes the dossier to who is actually traveling** (#113). `tn team pull`
  still writes every player's roster row with a null `event_id` — that is the season roster, not a
  registration — but `tn roster set` (below) records the SEPARATE, event-scoped fact of who
  registered for a specific event. When at least one player has, the dossier splits into the full
  detail you already know for the TRAVELING roster and a compact name-and-rating-only NOT REGISTERED
  block for everyone else on the season roster who didn't register — so a late substitution is still
  recognized, never invisible. An event with no registered players renders exactly as it always has,
  full season roster, no split. Either way the dossier's own `Roster:` line states which one you are
  looking at, and `tn report build`'s summary line carries `roster="registered"` or `roster="season"`
  for a single-team build.

  Author the payload by hand or from an agent that just read a registration page — either way it is
  the same JSON `tn roster set` and the `roster_set` MCP tool both read:
  ```json
  { "team": "IA/Versteeg/40&Over3.5M", "event": "Springfield Sectionals 2026",
    "players": ["Ada Ashby", "Bo Bramwell"] }
  ```
  ```sh
  tn roster set roster.json
  ```
  It **replaces** the event's roster on every run rather than accumulating: a name missing from a
  re-run is retired from that event (never from the season roster), and a re-added name is restored
  rather than duplicated — the registration page is a snapshot, so re-running the SAME payload is a
  safe no-op and re-running an UPDATED one is exactly how you keep the dossier current as a late
  roster change comes in. Both `team` and `event` must already be on file (`tn team pull` / `tn event
  add`); every name resolves against that team's own season roster only, flagged rather than guessed
  if it does not.

  Availability and captain notes have their own writers too (`tn player avail`, `tn player note` —
  see [agent-chat-over-mcp.md](agent-chat-over-mcp.md)), scoped to the designated home team only.
