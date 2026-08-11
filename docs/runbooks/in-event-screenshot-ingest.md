# Runbook: in-event screenshot ingest

> **Walked end to end on 2026-08-11** against a real TennisLink scorecard, on a copy of the live
> database (#133). Every command, message and timing below was executed, not drafted. Where this
> runbook previously said something the run contradicted, the correction is marked **[dry run]** so
> you can tell a measured claim from an inherited one.

## When to use this

At a Sectionals site (or any tournament), when a scorecard photo needs to be in the system before
the next round is planned — spec § Ingestion path 4: "Friday's results in the system before
Saturday's planning" comes from photos, not a parser. `tn` cannot read the photo itself: there is no
OCR or image-decoding dependency in this repo (see the assessment for #18), and the seam the spec
already puts here is **agent vision → a structured payload → a deterministic writer**. The model
sees the photo; `tn` validates and writes.

**It works, and it is fast.** The deterministic half of the loop measured **~2 seconds** end to end
(see *Measured timings*). Everything that can go wrong goes wrong in the preflight, not the write.

## Preflight — before you leave for the venue

This is the half that cannot be fixed on site, and the dry run's hardest finding is here.

- **Both teams must already be on file, with their rosters pulled** — the prompt form in
  [pre-tournament-full-pull.md](pre-tournament-full-pull.md) step 2, or the equivalent
  `team_pull`/`player_pull` MCP calls. `tn match add` / `match_add` **never creates a team**, and
  every player name resolves ONLY against the named team's own roster (never a global lookup).
- **Never paste a scraped team or player name into a shell command.** A team name is *scraped data*
  and lands in the database unaltered, so a `"` in one closes your argument and whatever follows runs;
  apostrophes in team names are ordinary, not exotic.
  [pre-tournament-full-pull.md](pre-tournament-full-pull.md) step 2 carries the full reasoning (this
  repo's #56/#57 lesson) and the URL-driven form that avoids it. **This runbook puts those names in a
  JSON payload, not a command line, which is the safe direction** — but the lookup below prints names
  to your terminal, and the moment one goes from that output into a command the hazard is back.
- **[dry run] There is no offline recovery for a missing team or a missing player.** There is no
  `tn team add`; `tn roster set` requires the team to exist already; `tn player alias` and
  `tn player distinct` cannot put someone on a roster. The only path is `tn team pull`, which needs
  the network. A card naming anyone your rosters do not carry is **unfixable in a building with no
  wifi.** Pull complete rosters before you travel; that is the mitigation, and there is no other.
- **[dry run] Check your prefix-ID coverage before you rely on it.** The *Failure modes and recovery*
  table below offers `usta:`/`tr:`/`wtn:` prefix-IDs, which only exist if the player row carries
  that id. Measured on the live database: **all 49 Sectionals-registered players carry both a
  `usta_uaid` and a `tennisrecord_url`** — so at Springfield this path is available for every name on
  every card. Across the whole database it is not: **1668 of 1745 players (95.6%) carry no source id
  at all**, so away from the registered rosters the prefix-ID recovery simply does not exist. Confirm
  with:

  ```sh
  # Refuse on an unset/typo'd path BEFORE opening: sqlite3 creates an empty database for a path that
  # does not exist, and this query would then report a roster of 0 — indistinguishable from "nobody
  # has an id", which is the opposite of the answer you came for.
  DB="${TN_DB_PATH:?set TN_DB_PATH to the absolute database path first}"
  [ -f "$DB" ] || { echo "STOP: no database at $DB — check TN_DB_PATH" >&2; exit 1; }
  # The read-only guard every sqlite3 read in this runbook carries; the venue preflight below
  # explains why a bare `?mode=ro` is not enough, and names the one residual it cannot close.
  RO="mode=ro"
  [ -e "$DB-wal" ] || sqlite3 "file:$DB?$RO" "select 1" >/dev/null 2>&1 || RO="mode=ro&immutable=1"
  sqlite3 "file:$DB?$RO" "select count(*) as roster,
    sum(p.usta_uaid is not null) as has_usta
    from team_memberships tm join players p on p.id = tm.player_id
    where tm.event_id = (select id from events where name = 'Springfield Sectionals')
      and tm.retired_at is null"
  ```

- If the match belongs to a tracked event, the event is already on file (`tn event add`). Naming an
  unknown event in the payload is a refusal, not a create.
- The database is migrated (`tn db migrate`).

## Preflight — at the venue, before the first card

**[dry run] Set all four paths, absolutely, on every single invocation.** Not once per session — `tn`
reads them **per process**, and the run below lost a photo archive to exactly this by dropping one
variable on one command.

**"Per process" includes `tn mcp serve`, and that is the version of this mistake that hurts.** The
server captured its environment when it started; the agent's `match_add` runs in *that* process.
Exporting these in a new terminal moves your readbacks and leaves the ingest where it was. Step 1
below has the check — do it before the first card, not after a confusing verification.

```sh
export TN_DB_PATH=/absolute/path/to/data/nadal.db
export TN_RAW_PATH=/absolute/path/to/raw
export TN_REPORTS_PATH=/absolute/path/to/reports
export TN_SCORECARD_PHOTOS_PATH=/absolute/path/to/scorecard-photos
```

`TN_DB_PATH` is resolved against the caller's cwd and **SQLite creates on open** (issue #111): run
from the wrong directory and you silently get a fresh, empty database that still reports
`status=ok`. Confirm you are pointed at the real one before the first write:

```sh
DB="${TN_DB_PATH:?set TN_DB_PATH to the absolute database path first}"
[ -f "$DB" ] || { echo "STOP: no database at $DB — check TN_DB_PATH" >&2; exit 1; }
RO="mode=ro"
[ -e "$DB-wal" ] || sqlite3 "file:$DB?$RO" "select 1" >/dev/null 2>&1 || RO="mode=ro&immutable=1"
sqlite3 "file:$DB?$RO" "select count(*) as teams from teams;
select count(*) as court_matches from court_matches;"
```

Non-zero counts are the check. Zero means you just created a decoy — stop and fix the path. The
`[ -f "$DB" ]` line is what stops this check from *being* the thing that creates the decoy.

### [dry run] The read-only guard, and why every read below carries it

**A bare `sqlite3 "file:$DB?mode=ro"` fails against any database `tn` has touched.** Measured on
three independent databases: `tn` closes cleanly and removes **both** WAL sidecars on exit — after a
read (`tn team show`) and after a write (`tn match add`) alike — and a read-only connection to a
WAL-mode database can create the `-shm` but **never** the `-wal`. So the very next verification
command exits 14:

```
Error: in prepare, unable to open database file (14)
```

The database is fine. The `[ -f "$DB" ]` guard every runbook uses passes happily, because the file
is right there. This is the ordinary path, not an edge case — it is what you will hit at the venue
one command after a successful ingest.

The guard reaches `immutable=1` only when **both** conditions hold:

```sh
RO="mode=ro"
[ -e "$DB-wal" ] || sqlite3 "file:$DB?$RO" "select 1" >/dev/null 2>&1 || RO="mode=ro&immutable=1"
```

Read it as a short-circuit chain, because each link is load-bearing and **neither alone is safe**:

| State | Where the chain stops | Chosen | Why |
|---|---|---|---|
| `-wal` present | at `[ -e … ]` | `mode=ro` | A WAL exists, so `immutable=1` would skip real committed rows. **Never** reached, whatever else fails. |
| No `-wal`, opens fine | at the probe | `mode=ro` | It works; nothing to fix. |
| No `-wal`, open refuses | at the fallback | `mode=ro&immutable=1` | The expected sidecar-less case, and there is genuinely no WAL to skip. |

**The `[ -e … ]` link is what keeps an unrelated failure from choosing the dangerous branch.** An
earlier draft of this section used the probe *alone*: a busy writer, a locked database, a permissions
error or a broken `sqlite3` all make the plain open fail, and the probe-only form read every one of
them as "no WAL, safe to go immutable" — selecting stale reads in precisely the situation the guard
exists for. **Never hardcode `immutable=1`** for the same reason, one step further along.

> **Residual, named rather than papered over.** The chain still tests in one process and reads in the
> next, so a writer starting in between can create a WAL the `immutable=1` read then ignores,
> reporting your match as absent when it is there. A shell snippet cannot close a cross-process
> check-then-act, and two earlier drafts of this section each claimed a version of it could.
>
> **The operator rule is what actually closes it, and at a venue it matters**: `immutable=1` is only
> safe while **nothing is writing**. The agent chat in step 1 talks to a running `tn mcp serve`, which
> is exactly such a writer — so **do not run these shell readbacks while an ingest may be in flight**.
> Finish the `match_add` call, then verify. If you must have both at once, ask the agent to read back
> through MCP instead of using these fences.

Take a backup before the first write of the day (`tn db backup`) — note that it is itself a write
(it appends a `request_log` row) and it leaves the source database sidecar-less like everything else.

## Steps

### 1. Hand the photo to an agent chat connected to `tn mcp serve`

> **Start `tn mcp serve` with the exports from the preflight above, in a shell that has them — and if
> it was already running, restart it.** `match_add` executes **inside the server process**, so it uses
> **that process's** environment, not the environment of the terminal you are typing in. Exporting
> `TN_DB_PATH` in a fresh shell changes your readbacks and your `report build`, and changes nothing
> about where the agent's ingest lands. The failure is quiet and maximally confusing at 11pm: the
> ingest reports `status=ok`, and your verification says the match is not there — because it is in a
> different database. Check the server is on the right one before the first card:
>
> ```sh
> # In the SAME shell that will launch the server:
> echo "$TN_DB_PATH"        # must be the absolute path you expect
> tn mcp serve
> ```

Then see [agent-chat-over-mcp.md](agent-chat-over-mcp.md) for connecting a client. Share the scorecard
photo in the conversation and ask the agent to extract it.

**Name BOTH teams in the prompt, with their on-file spellings** — never "the one printed on the card"
for either side. The card's own names are usually not the names on file (below), so a prompt that
defers to the card for one side has simply moved the failure to that side:

> "Read this scorecard photo and record the results with `match_add`. Home team is
> `HOA/Burgess-Zingg/40&over3.5M`, visiting team is `IA/Versteeg/40&Over3.5M`. Use exactly those two
> team names — do not use the names printed on the card. Take the players, slots, winners and scores
> from the card."

Look both spellings up before you start (the query below), and paste them into the prompt. You know
who you are playing before the photo is taken; this is the one part of the loop you can do in advance.

The agent's job is to produce ONE JSON object matching `src/ingest/scorecard.ts`'s
`scorecardPayloadSchema`: the played-on date, both team names, and one entry per court (`slot`,
`discipline`, `homePlayers`/`visitingPlayers` by name, and — when the card shows them — `winnerSide`
and `score`). The slot set is whatever the card actually shows (`S1`/`D1`-`D3` at a four-court
event, `S1`/`D1`-`D4` at a five-court one like Tulsa 2025) — it is never assumed to be exactly four.

**[dry run] The team names on the card are usually not the names on file.** The card that walked
this runbook printed `HOA/Burgess/40&over3.5M`; the database holds `HOA/Burgess-Zingg/40&over3.5M`,
and the ingest refused with a bare `unknown team "HOA/Burgess/40&over3.5M"` — **no candidates, no
"did you mean"**.

That is worth understanding rather than memorising, because the refusal is not always this unhelpful.
Team lookup has two tiers (`findTeamByName`): an exact match on the normalised name key, then a
**fuzzy tier with a radius of two edits** (`FUZZY_MAX_DISTANCE = 2`) which never auto-matches but does
report `ambiguous` **and names every candidate**. A one- or two-character difference therefore tells
you the right spelling; `-Zingg` is six characters, so it fell past the band into `not-found` with
nothing to suggest. **The more wrong the name, the less help you get** — which inverts the intuition
that a big difference is the easy case.

So **give the agent the on-file spelling in the prompt (as the example above does) rather than letting
it copy the card.** There is no `tn` command that will find a team by partial name
(`tn team show "HOA/Burgess"` → `unknown target`), so look the spelling up directly if you need it:

```sh
DB="${TN_DB_PATH:?set TN_DB_PATH to the absolute database path first}"
[ -f "$DB" ] || { echo "STOP: no database at $DB — check TN_DB_PATH" >&2; exit 1; }
RO="mode=ro"
[ -e "$DB-wal" ] || sqlite3 "file:$DB?$RO" "select 1" >/dev/null 2>&1 || RO="mode=ro&immutable=1"
sqlite3 "file:$DB?$RO" "select id, name from teams order by name"
```

**[dry run] Read the winner off the card's own tick column, not off the score.** Scores print
winner-first regardless of side. On the card used here every set read like a home win (`6-3 6-4`)
while the visiting team won 4-0; the arithmetic check is the card's own game-winning percentage —
summing the games gave 44-28 = 61.11% / 38.89%, matching what the card printed.

### 2. The agent calls `match_add`

Over MCP, the agent calls the `match_add` tool with that payload inline — it has no file to hand,
which is the whole reason this tool exists alongside the CLI command below. If a `sourceImage` path
is available (the photo saved to disk), including it archives the original bytes to `raw/`
(gitignored), exactly like every other raw capture this repo makes — with two conditions specific
to this path, both hardened after a Codex adversarial review found `sourceImage` was otherwise an
arbitrary local-file-read primitive (rated Critical):

- **The photo must already sit inside the configured scorecard-photos root** —
  `TN_SCORECARD_PHOTOS_PATH` if set (resolved against the caller's cwd when relative), or
  `scorecard-photos/` (gitignored) anchored to the `tn` checkout itself otherwise (issue #111 — the
  same directory no matter which directory `tn` was invoked from), mirroring
  `TN_DB_PATH`/`TN_RAW_PATH`/`TN_REPORTS_PATH` exactly. A path outside that root, or a symlink
  anywhere in the chain to it, is refused rather than read. Save (or move) the photo there before
  calling `match_add`.
- **Archiving happens AFTER the match is recorded, not before.** A refused ingest (an unknown team,
  an unresolved player, anything) persists nothing — the photo is read only once the database write
  has already succeeded. A photo that then fails to archive (a bad path, an oversized file, content
  that does not sniff as a real image) does NOT undo the match: the CLI reports `status=partial`
  (`match_add` returns `archiveError` alongside a normal successful result) rather than pretending
  nothing happened, since the match rows genuinely exist either way.

> **[dry run] `status=partial` exits 1. The match still landed.** This is the single most dangerous
> signal in the loop, because exit 1 reads as "it failed" and invites a re-run. Observed verbatim
> when `TN_SCORECARD_PHOTOS_PATH` was dropped from one invocation:
>
> ```
> match add status=partial home="HOA/Burgess-Zingg/40&over3.5M" visiting="IA/Versteeg/40&Over3.5M"
>   playedOn="2026-08-28" teamMatchId="121" courts=4
>   archiveError="refusing: the configured source root does not exist: .../scorecard-photos"
> ```
>
> `teamMatchId` and `courts` are populated: the four courts are in the database. **Read `status=`,
> never `$?`.** Only the photo archive failed, and a photo can be archived later.

### Alternative: a payload file, from the CLI

If the payload already exists as a JSON file (an agent wrote it out, or you are replaying a captured
extraction), the identical service is reachable from a terminal:

```sh
tn match add /path/to/payload.json
```

**`tn match add` cannot read the photo itself.** Handing it an image, or a file that is not valid
JSON matching the schema, refuses (exit 1) with a message pointing at the `match_add` MCP tool —
this is a stated capability split, not a bug: only the agent's vision call can turn a photo into a
payload.

A successful run prints, verbatim:

```
match add status=ok home="HOA/Burgess-Zingg/40&over3.5M" visiting="IA/Versteeg/40&Over3.5M"
  playedOn="2026-08-28" teamMatchId="121" courts=4 archivedPath="…/raw/scorecard/….png"
```

### 3. Verify what actually landed

`match_add`'s (and `tn match add`'s) own result is the readback — `teamMatchId` and a `courts` count
on success. Beyond that:

```sh
# Read the SAME database the ingest wrote to. A hardcoded `data/nadal.db` silently reads a stale
# file whenever TN_DB_PATH is set, and — since SQLite creates on open — conjures an empty decoy when
# that path holds nothing, so the readback would "verify" a match that is not in the database you
# just wrote. The `${TN_DB_PATH:-data/nadal.db}` fallback below has the same requirement as every
# other runbook's: it re-derives the unset default against THIS shell's cwd, so it only agrees with
# `tn`'s own anchored default (issue #111) when this shell IS the checkout root.
DB="${TN_DB_PATH:-data/nadal.db}"
[ -f "$DB" ] || { echo "STOP: no database at $DB — check TN_DB_PATH" >&2; exit 1; }
case "$DB" in
  *'?'*|*'#'*|*'%'*) echo "STOP: database path must not contain ? , # or % ; got '$DB'" >&2; exit 1 ;;
esac

# The id the command printed. Checked numeric before it reaches SQL: it is pasted from output, and a
# readback should not be the one place a value goes into a query unvalidated.
printf 'teamMatchId from the summary line: '; IFS= read -r TMID
case "$TMID" in
  ''|*[!0-9]*) echo "STOP: teamMatchId must be digits; got '$TMID'" >&2; exit 1 ;;
esac

# Read-only: verifying a write must never itself write.
# [dry run] THE READ-ONLY GUARD — not optional here, and this is the exact spot that proves it.
# `tn match add` has just run and closed, so the `-wal` is gone and a bare `?mode=ro` exits 14
# ("unable to open database file") on the ordinary success path. Measured on three databases.
RO="mode=ro"
[ -e "$DB-wal" ] || sqlite3 "file:$DB?$RO" "select 1" >/dev/null 2>&1 || RO="mode=ro&immutable=1"
sqlite3 "file:$DB?$RO" "select cm.slot, cm.discipline, cm.winner_side, cm.score
  from court_matches cm
  where cm.team_match_id = $TMID
  order by cm.slot"
```

Confirm the slot, discipline, winner, and score against the photo itself, not just against "the
call returned ok" — the same discipline this repo's own findings log names for the identical shape
(`docs/findings.md`: reading back what a write actually recorded, not merely that it succeeded).

The dry run's readback, for shape:

```
D1|doubles|home|6-3 1-6 1-0
D2|doubles|home|6-3 6-2
D3|doubles|visiting|6-3 6-4
S1|singles|visiting|6-3 6-4
```

### 4. Rebuild the binder

```sh
tn report build sectionals "Springfield Sectionals"
```

Check the summary line's own disclosure before reading the pages:

```
report build status=ok target="sectionals" teams=5 files=12 root="…"
  since="2025-08-28" anchoredTo="event" field="registered"
```

`anchoredTo="event"` means the 12-month window came from the event's `starts_on`, not from today's
clock. `since=` is the boundary that decides the next section.

## [dry run] What the ingest changes on the page — and what it does not

Measured by building the full dossier set twice — once from a pristine copy, once after the ingest —
and diffing them.

| Section | Moves on a Friday-night ingest? |
|---|---|
| **Prior meetings vs our players** | **Yes** — and for a card of *any* age; this section is explicitly unwindowed ("all meetings on file"). |
| **Per-player records** | Yes, **only if `playedOn` is on or after `since=`**. |
| **Per-player court-slot tendencies** | Same rule as records — same window, by construction. |
| **Partner frequency** | Same rule as records. |
| **Predicted lineup** | **Yes — regardless of the card's date.** The lineup is restricted to this team's own schedule, not to the window. |
| **Evidence-scope disclosure** | Yes; the ingested courts appear under **`no league recorded`**, because the payload carries no league field. They are *retained*, not scoped out. |
| **Team record (`6-0`)** | **Depends on who created the parent fixture.** If this ingest created it, `6-0 (1 undecided)` — the payload carries no team score. If `tn team pull` had already recorded the fixture with **unequal** court counts, the ingest reuses that row and leaves them alone, so the record reads as a win or a loss. A pulled **tie** (2-2 on four courts) is still `undecided`. See *Known limitations*. |

**The two rows worth internalising before Saturday morning:**

1. **A card older than `since=` still moves prior meetings and the predicted lineup, but changes no
   record or tendency on the same page.** At Springfield this is a non-issue — every card you ingest
   is same-week — but it is why a *backfilled* old card can look like it "did nothing".
2. **The team-record line will usually say `(1 undecided)` for a tie you ingest.** That is expected,
   and it is **not** a sign the courts failed to land — check the court-level readback in step 3
   instead. It reads as a real win or loss only when a `tn team pull` had already recorded that same
   fixture with **unequal** court counts; at a venue, ingesting the evening's play, it will not have.

## [dry run] Failure modes and recovery

Every message below was produced by the dry run, verbatim. All of them exit 1 and, except for
`partial`, **write nothing at all**.

**Why a flagged name refuses the whole ingest rather than skipping that court:** spec § Ingestion
requires that "every extracted name must resolve against known rosters or is flagged, never guessed",
and a partial write would leave one court's participants half-recorded with no signal that anything
was wrong. So the ingest collects **every** flagged name across every court, reports them together,
and writes nothing — one round trip tells you the whole list.

| What you see | What it means | What to do |
|---|---|---|
| `unknown team "Craig, John"` | The team is not on file. `match add` never creates one. | Correct the name to the on-file spelling (step 1). If the team genuinely is not on file, you need `tn team pull` and therefore the network — there is no offline fix. |
| A second `unknown team "…"` after fixing the first | **Team refusals are reported one at a time**, unlike name flags. | Fix and re-run. Budget two round trips when both names came off the card. |
| `unresolved player name(s): "A" unresolved; "B" unresolved; …` | Every flagged name, collected in **one** round trip. `unresolved` means "not on this team's roster" — which covers both a misread name *and* a real player who is simply not on the roster you pulled. | Compare against the roster (`tn team show "<team>"`). Nothing is written, so fix them all and re-run once. |
| `"Randy Burges" ambiguous (Randy Burgess)` | A near miss. It **never** auto-corrects — the candidate is named for you. | Use the candidate's exact spelling, or `tn player alias "Randy Burgess" "Randy Burges"` if this variant will recur. |
| `"usta:2019367719" resolved to Jamie Johnson, who is not on this team's roster` | A prefix-ID that names a real person on the *wrong* side. A prefix-ID does not bypass roster scoping. | Put the name on the correct side, or check you used the right id. |
| `status=partial … archiveError=…` | **The match landed.** Only the photo archive failed. Exits 1 anyway. | Do not re-run in a panic. Fix the photo path and re-run only if you want the archive — the re-run is safe (see below). |
| `match_add` reports `status=ok`, but your readback finds nothing | Almost certainly **two databases**: `tn mcp serve` is using the environment it started with, your shell is using the exports you just set. | Compare them: `echo "$TN_DB_PATH"` in your shell against the path the server was launched with. Restart the server from a shell carrying the right exports (step 1), then re-ingest. Nothing was lost — the match is in the other database. |
| `unable to open database file (14)` from a `sqlite3 …?mode=ro` read | The `-wal` sidecar is absent, which is the state **every** `tn` command leaves behind. Not a database problem. | Use the read-only guard — probe with plain `mode=ro`, fall back to `mode=ro&immutable=1` only on refusal. Every read in this runbook already carries it. **First make sure nothing is writing** (see the guard's residual). |

### [dry run] Re-running a card is safe — and a correction really does correct

Both measured, on the same tie:

- **Re-submitting the identical payload is idempotent.** Second run: same `teamMatchId`, `courts=4`,
  and the database unchanged — one parent row, four court rows, fourteen participants, before and
  after. (It does write a second archived copy of the photo.)
- **Re-submitting a corrected payload replaces that court's participants**, it does not accumulate
  them. Swapping one name on D3 left D3 with exactly the corrected pair and the total participant
  count unchanged. A scorecard payload is a complete replacement for every court it names.

  **This corrects a warning you may have been given.** Residual
  [#73](https://github.com/wrburgess/nadal/issues/73) — "`upsertCourtMatchPlayers` adds but never
  retracts" — is real, but it describes the **`tn player pull` re-pull path**, not this one:
  `addMatchFromScorecard` clears each named court's participants immediately before writing the
  fresh set. Correcting a misread name here is safe.

## Known limitations

- **No in-process image reading.** This repo has no OCR/vision/image dependency; a photo must go
  through an agent's own vision, never `tn` directly.
- **A team must already exist and carry the roster the card names.** Neither `tn match add` nor
  `match_add` creates a team or a roster entry — that stays `team pull`'s job. **[dry run]** And
  there is no offline substitute; see the travel preflight.
- **[dry run] The team-level score on the card is discarded.** `scorecardPayloadSchema` has no field
  for it, so this ingest never *supplies* `team_matches.home_courts_won` / `visiting_courts_won`.
  What that means for the team-record line depends on who created the parent fixture, and the
  distinction is worth holding:
  - **This ingest created it** (the venue case): both counts stay NULL and the tie counts as
    `undecided` forever, even though all four court winners were recorded.
  - **`tn team pull` already recorded that fixture**, counts and all: the ingest resolves that same
    parent and **leaves those columns untouched** — `addMatchFromScorecard` "never computes them …
    so it has nothing honest to write over whatever another writer already recorded"
    (`src/ingest/match-add.ts`). The pulled counts survive, and the record then reads as a win or a
    loss **when they are unequal**. Equal counts — a 2-2 tie on four courts — are classified
    `undecided` too (`src/query/derive.ts`: `homeCourtsWon === visitingCourtsWon`), so "has counts"
    is not the same as "has a result".

  Either way the court-level data — which is what the dossier's records, tendencies and prior
  meetings are built from — is unaffected. *(Corrected after the Codex review: this section
  previously claimed a screenshot ingest could* never *produce a win or a loss, which is false in the
  second case.)*
- **[dry run] A card whose courts a pull has already captured will double them.** Court matches
  arriving from `player pull` are unlinked (`team_match_id IS NULL`) and carry the pull's own
  side labels, which are *not* real home/away (accepted residual
  [#72](https://github.com/wrburgess/nadal/issues/72)). A screenshot ingest of the same real courts
  creates a second, linked set with the card's true sides. Nothing reconciles the two. In practice
  this only bites when back-filling an old card that a roster pull already covered — not at a venue,
  where you are ingesting today's play.
- **The general event↔team association is out of scope here** (`docs/findings.md`): a payload
  naming a known event links the match to it; naming none writes a match with no event at all,
  same as every other id-less team match on file today.
- **`sourceImage` only accepts JPEG and PNG**, sniffed from content rather than trusted from the
  extension, up to 25 MiB. HEIC (the default format on many phones) and WEBP are not yet supported —
  convert or re-save the photo first, or supply the payload without `sourceImage` and archive it
  separately.

## [dry run] Measured timings

macOS, warm cache, the live database's own scale (32 teams, 1745 players, 1419 court matches):

| Command | Wall clock |
|---|---|
| `tn match add` — 4 courts, with photo archive | **0.87 s** |
| `tn report build sectionals "Springfield Sectionals"` — 5 teams, 12 files | **1.01 s** |
| `tn db backup` | **0.95 s** |

The deterministic half of the loop is **under two seconds**. The variable cost is the agent's vision
extraction and any round trips a refusal forces — which is why the preflight above is where the time
is actually spent, and why getting the team spelling into the prompt is worth doing once.
