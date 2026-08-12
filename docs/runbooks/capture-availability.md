# Runbook: capture availability and captain notes

## When to use this

Whenever a player reports their availability for Springfield Sectionals, tells you they only play
doubles, or you have an observation worth recording about a player or a pairing — spec § Domain
model: Availability is "structured per-player per-event-day … lineup planning depends on it," and
CaptainNote is "Randy's subjective layer on a player or pairing. Populated for our team only, by
design." A player's play-style constraint (`players.plays`, #149) is the third recorded fact this
runbook covers, and `tn lineup build` reads it the same day-of-capture way it reads availability. All
three write services refuse until a home team is designated (nadal ADR 0001) — there is no "our team"
to scope any of them to otherwise.

## Before you start

- The database is migrated: `tn db migrate`.
- A home team is designated: `tn team home "<your team>"` (the `team_home` MCP tool works the same
  way over a chat).
- **The event is already on file, spelled exactly `Springfield Sectionals`** — not
  `"Springfield Sectionals 2026"`. That year-suffixed spelling is what every test fixture in this
  repo uses, which makes it an easy name to type from memory or copy from a test file; it is not the
  name on record.

  **The two commands read that name differently.** `tn player avail` resolves the event **from the
  day**, so the name is an optional trailing argument you need only when the day falls inside more
  than one event. It is **not ignored when you do supply it**: a name given for an unambiguous day is
  still checked, and the command refuses if that name is unknown (`UnknownEventError`) or names an
  event that does not cover the day (`EventDoesNotCoverDayError`). `tn report build` takes the name
  as well, and **refuses** an unknown one rather than falling back to unscoped — so the wrong
  spelling there costs you the whole grid, loudly.

  So the real hazard of the wrong spelling is not a mis-filed write. It is `tn event add` creating a
  **second** event across the same three days, after which `tn player avail` refuses *every* capture
  as ambiguous (`AmbiguousEventForDayError`, listing both candidates) and **writes nothing** until
  one is removed or named explicitly. Availability is stored per (player, event, day), so two events
  over one weekend is a state the writer will not guess its way out of.

  **To confirm which spelling is on file, read the table — do not probe with `tn event add`.** That
  command is idempotent on the *name*, which means a right guess updates in place and a **wrong
  guess silently creates the duplicate described above**: it is the hazard, not a test for it. There
  is no `tn event list`, so read it directly:

  ```
  sqlite3 data/nadal.db "select name, starts_on, ends_on from events;"
  ```
- **Back up first.** Availability and captain notes exist nowhere outside this database — a re-pull
  cannot rebuild either one (`docs/runbooks/backup-restore.md`'s own accounting of what a backup
  here actually protects). Before any capture session:

  ```
  tn db backup
  ```

  No arguments. It resolves the source from `TN_DB_PATH` (or the checkout-anchored default),
  refuses rather than overwriting an existing snapshot, and verifies the written file's row counts
  against the source before reporting success. It backs up with SQLite's own `.backup` API, **never
  `cp`** — a live database under `journal_mode = WAL` is not one file's worth of truth (recently
  committed rows can sit in an uncheckpointed `-wal` sidecar), and `cp` has no coordination with
  SQLite's locking, so it can copy a torn, mid-write snapshot. See
  [backup-restore.md](backup-restore.md) for the full mechanism and the manual fallback.

## The event

Springfield Sectionals runs three days, inclusive both ends:

| Day | Date |
|---|---|
| Friday | 2026-08-28 |
| Saturday | 2026-08-29 |
| Sunday | 2026-08-30 |

## Steps

### 1. Availability first, notes second — the order is deliberate

Availability upserts on `(player_id, event_id, day)`: a follow-up call for the same player and day
overwrites the status in place, so getting one wrong and correcting it a minute later is free.
Captain notes are the opposite — `addCaptainNote` (`src/query/captain-notes.ts`) is **append-only**,
with no edit and no delete anywhere in this codebase, so a note is permanent from the moment it is
recorded. Capture availability while you are still confirming details with a player; only write a
note once you are sure it is worth keeping.

### 2. Record availability — conversationally, over MCP, is the natural door

Point an agent chat at `tn mcp serve` ([agent-chat-over-mcp.md](agent-chat-over-mcp.md)) and talk
normally — spec § Interfaces: "Agent chat is the analysis/planning surface … availability and
captain notes are captured conversationally." Something like:

> "Randy Rostered is out Saturday, uncertain Sunday."

should turn into two `player_avail` calls. The CLI form is the exact same write service, useful when
you already know precisely what to type or want a re-runnable, auditable record:

```
tn player avail "Randy Rostered" 2026-08-29 unavailable
```

The status is exactly one of three values, plus a fourth thing that is **not** a value:

- `available`
- `unavailable`
- `uncertain`
- **unrecorded** — never write this as a stand-in for "haven't heard back yet." Leaving a
  player/day untouched IS the state: the dossier's grid renders it `—`, and that is meaningfully
  different from a recorded `unavailable`. Filling the blank in with `unavailable` erases a
  distinction the captain needs — "confirmed out" reads very differently from "no answer yet" at a
  glance across a whole roster.

### 3. Watch for the not-registered warning (#129)

`tn player avail` accepts a write for anyone on the home team's roster at all — a season-roster
player who has not yet **registered** for Springfield Sectionals specifically included, by design
(a real `tn team pull` roster is season-scoped, and requiring event registration would refuse
availability for players who have not been through `tn roster set` yet). If the player you just
recorded is season-only, both the CLI and the `player_avail` MCP tool result say so rather than
staying silent about it:

```
player avail status=ok player="Nate Anderson" day="2026-08-29" availability="available" event="Springfield Sectionals" onEventRoster="false"
player avail: warning: "Nate Anderson" is not registered for "Springfield Sectionals" — this row
will not appear on that event's dossier until they register
```

This is a **warning, not a refusal**: the value is genuinely stored, `--quiet` does not hide the
warning, and there is nothing to redo once the player registers (`tn roster set`) — the row starts
rendering on the next dossier build with no further action from you. Treat it as a prompt to check
registration status, not as a failed write.

### 4. Play-style constraints — `tn player plays`, only when a player has actually said so (#149)

Most players are unconstrained and need nothing recorded at all — `players.plays` starts `NULL` for
everyone, and `NULL` already means "no constraint on file," not "unanswered." Only record a value
when a player has told you they play doubles only:

```
tn player plays "Randy Rostered" doubles-only
```

The value is exactly one of two words, plus what a blank means:

- `doubles-only` — this player is not to be seated at the singles court.
- `both` — explicitly unconstrained; only needed to overwrite a `doubles-only` you recorded earlier
  in error, or once a player who previously said doubles-only tells you that has changed. A player
  who has never said anything either way needs no call at all.

Like availability, a second call for the same player **overwrites** the first — there is exactly one
`plays` value per player, never a history of them. Unlike availability, this is **not per-day**: it is
a standing statement about the player, not an answer for one event day, so it is recorded once and
carries forward into every `tn lineup build` for as long as it stays true.

**`tn lineup build` never leaves the singles court empty over this.** If every available player who
could still take the day is recorded `doubles-only`, someone is seated there anyway rather than the
court going unfilled — and the page prints an `OVERRIDE:` line naming who was seated against their
recorded constraint, plus a day-level line stating that nobody available carried singles eligibility.
Each strategy picks that person by **its own** rule, so the scenarios may well name different people:
strength-first and balanced seat the strongest available, history-first the most-played singles
player. Neither line appears on an ordinary day, so seeing one is itself the signal that
the exception fired — see `docs/cli/GRAMMAR.md`'s `tn lineup build` section for the full rule.

### 5. Captain notes, once you are sure — through the `player_note` MCP tool

**Never a shell-quoted `tn player note "<text>"` for a note carrying anything beyond a trivial
value.** A captain note is arbitrary text you typed, and it can carry an apostrophe, a double quote,
a backslash, or `$(...)`/backticks — inside DOUBLE quotes a POSIX shell evaluates the last of those,
so a literal command substitution in a note's text would run. `docs/findings.md:288` records exactly
this landing in a runbook once already (a captain-notes recovery drill told the reader to paste
exported values into a double-quoted `tn player note` call) and being caught only by an independent
review — the fix there is the rule stated here up front rather than re-discovered: route anything
non-trivial through the `player_note` MCP tool, which takes the note as a structured JSON argument,
so no shell ever parses it.

> "He serves big on break points."
> "Randy and Kai Kestrel are strong together at the net."

**Pairing notes are MCP-only.** `tn player note` has no way to name a second player at all — a
deliberate #17 decision (`src/cli/commands/player-note.ts:29`, `docs/findings.md:590`), not an
oversight, because a rigid third CLI positional was judged more awkward than a conversational second
name. A note about how two players play together — rather than about either one alone — is only
reachable by asking the agent to call `player_note` with a `pairTarget`.

### 6. Verify — there is no readback command

**`tn player show` is not a readback for any of these.** It reports availability and captain
notes only as a `dataGaps` status (`not-collected` / `empty` / `has-data`) — a count, never the
actual values — so it can tell you *that* something is recorded and never *what*. `players.plays`
is not part of `dataGaps` at all today, so `tn player show` says nothing about it either way. The
tool call's own result is the nearest thing to an immediate readback: `player_avail` returns the
stored status and the event it resolved to, `player_plays` returns the stored constraint,
`player_note` returns the stored text. Read those rather than assuming the conversation translated
correctly.

For the values the captain will actually read at the tournament, rebuild and open the dossier:

```
tn report build "<your team>" "Springfield Sectionals"
```

then open the written `index.html` (or `.md`) and read the availability grid and the captain-notes
section directly — the same "generate the artifacts and look at them" practice `docs/findings.md`
names repeatedly, and the only way to see the not-registered/unrecorded distinctions (`—` versus a
captured status, and a missing name versus one that has registered) rendered the way the page will
actually show them.

## Known limitations

- **No `tn player avail`/`tn player note` readback command.** The tool result at write time is the
  closest thing to one; there is no `tn availability show` or equivalent, so verifying an OLDER
  entry means rebuilding the dossier and reading the page, not querying for it.
- **Availability can be recorded for a player who never registers.** `onEventRoster: false` is
  informational; nothing in this repo prompts you to register them, or reminds you again later.
- **Captain notes cannot be edited or deleted, by anyone, through any surface.** A note recorded in
  error stays on file; there is no correction mechanism beyond writing a further note.
- **A recorded play-style constraint does not appear on the `tn report build` dossier.** It is read
  only by `tn lineup build` (#149) — the tool-call result and `tn lineup build`'s own page are the
  only places to see it, the same "no readback surface" limitation the bullet above states for
  availability and captain notes.
- **This runbook does not enumerate a paste-able command per roster player.** That shape — a
  template inviting real player names and captain-typed text to be substituted in one line at a
  time — is the exact move `docs/findings.md:288` recorded as a defect, one runbook over. Use agent
  chat for a full-roster capture session; reach for the single-command CLI forms above only when you
  already know the one value you want to write.
