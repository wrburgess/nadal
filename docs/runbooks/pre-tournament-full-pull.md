# Runbook: pre-tournament full pull

## When to use this

Before Sectionals (or any tournament), to refresh every already-scouted team end to end so
dossiers ([build-and-print-dossiers.md](build-and-print-dossiers.md)) and predictions
([predict-an-opponent-lineup.md](predict-an-opponent-lineup.md)) are built from current data, not
whatever was on file weeks ago. `tn report build` never fetches — it renders from whatever the
database already holds — so a stale pull produces a confidently-printed stale binder with no
warning.

**This is not one command.** It is three separate refresh paths, each with its own reach, and none
of them cover TennisLink. Read *Three boundaries* below before running anything, so a clean exit 0
on every step is read as "every source this repo can reach is current" and not as "everything is
current."

## Three boundaries

1. **Live network** — `tn team pull "<team>" --players` and `tn player pull "<player>"` (both
   without `--from`/`--source-url`) fetch TennisRecord's team, match-history, and player-profile
   pages live over `fetch()` (`src/ingest/fetch.ts`). This is the only fully-automated path in this
   runbook, and it is also the path the zero-network dry run (`test/dry-run-2025.test.ts`) never
   exercises on purpose — that test's own `fetchPage` spy throws if anything in the pipeline ever
   falls back to it, so live-fetch behavior itself has no automated regression coverage beyond
   TennisRecord's parsers holding up against real pages.
2. **Human-in-the-loop** — USTA's player-search profile (and the WTN widget riding on it) sits
   behind a signed-in `account.usta.com` session; nothing in this repo automates that login on
   purpose (Phase 3, #15, "seam-first": no browser dependency shipped). Every NTRP/WTN refresh goes
   through [login-assisted-scrape.md](login-assisted-scrape.md), with an HC standing by to sign in,
   not through this runbook directly.
3. **Absent** — TennisLink is unbuilt. `src/cli/router.ts`'s `COMMANDS` registry holds exactly 13
   commands (verify: `grep -n noun: src/cli/commands/*.ts`, or read `docs/cli/GRAMMAR.md`'s
   `## Commands` table) and none of them touch `tennislink.usta.com`. Every `tennislink.usta.com` path today
   redirects to USTA OAuth, and the login-assisted capture that would get past it is tracked as
   issue #27 — not shipped. Anything that would only ever have come from TennisLink (league
   schedules pulled from that source specifically) is simply missing from every dossier until #27
   lands, and no step below closes that gap.

## Before you start

- The database is migrated: `tn db migrate`.
- You know which teams are already on file. There is no `tn team list` yet (`docs/cli/GRAMMAR.md`'s
  *Planned* section, not the 13 shipped commands) — enumerate directly:
  ```sh
  sqlite3 "${TN_DB_PATH:-data/nadal.db}" "select name, tennisrecord_url, is_home from teams order by name"
  ```
- You know which players' dossiers need NTRP/WTN specifically (step 4 below), since that path is
  manual per player, not a blanket re-pull.

## Steps

### 1. Migrate to the latest schema

```
tn db migrate
```

Expected: `db migrate status=ok path="<db path>"`, exit 0. A failure here is not this runbook's
job — see [db-migration-recovery.md](db-migration-recovery.md).

### 2. Re-pull every already-scouted team, live, cascading rosters

For each team the query in *Before you start* listed:

```
tn team pull "<team name>" --players
```

No `--from`/`--source-url` here — that pair replays a **previously saved** page (what the dry run
and this repo's own tests use to stay offline); leaving both off is what makes this command fetch
TennisRecord live. `--players` cascades every roster entry that carries a profile link through its
own `player pull`, so one command refreshes the team's schedule, roster membership, and (for linked
players) their own match history and TennisRecord dynamic rating together.

Expected: `team pull status=ok team="<team>" roster=N matches=M archived="<raw dir>/tennisrecord/….html" retired=R`, exit 0.

`archived=` is where the raw fetched page landed (`TN_RAW_PATH` if set, `raw/` otherwise) — every
live pull archives the page it fetched before parsing it, the same as a `--from` replay archives the
file it read. `retired=R` is not a failure signal: it is how many previously-rostered players this
pull found absent from the current page (issue #49) — expected when a roster turns over between
pulls, worth a second look if `R` is large and unexpected.

**If a cascade partly fails**, the line reads
`team pull status=partial team="<team>" roster=N matches=M archived="…" retired=R skipped=K skippedEntries="<names>"`
and exits 1. The team write already landed — only the named player pulls did not. Re-run those
individually (step 3) rather than re-running the whole `team pull`, which would just re-attempt (and
may re-skip) the same entries for whatever reason skipped them the first time (commonly: a roster
row with no profile link on the page at all, which cascades can never reach).

### 3. Pull any player individually who needs it

```
tn player pull "<player name>"
```

Expected: `player pull status=ok player="<name>" matches=N archived="<raw dir>/tennisrecord/….html"`,
exit 0. Same live-network rule as step 2: no `--from`/`--source-url` means a live fetch. Use this
for anyone step 2's cascade skipped, or any player you track outside a full team roster.

### 4. USTA/WTN ratings — human-in-the-loop, not this runbook's job

Neither step above ever touches USTA or WTN — TennisRecord carries neither rating. For every player
whose dossier needs NTRP or WTN, run the full procedure in
[login-assisted-scrape.md](login-assisted-scrape.md) end to end, with an HC signed in to
`account.usta.com`. That runbook owns its own verification step; this one does not duplicate it.

### 5. Verify the refresh actually landed — not just that each command said ok

A readback distinct from trusting each command's own `status=ok`:

```
tn team show "<team name>"
```

Read the roster block: every player you expect to still be on the team should be listed (someone
missing here, with `retired=` having incremented in step 2, aged off the roster rather than being a
pull glitch — cross-check against the actual team page if that surprises you). Compare `roster=`
and the slot tendencies against what you saw on your last pre-tournament pull; a roster that
shrank without a corresponding `retired=` count, or a `slots:` line that went quiet for someone you
know played recently, is worth investigating before you build dossiers on top of it — `tn team show`
does not print ratings at all (its `RosterMemberProfile` type carries no rating field), so a ratings
spot-check is `tn player show "<player>"`'s job, not this command's.

### 6. Rebuild the binder

Once every relevant team is refreshed, follow
[build-and-print-dossiers.md](build-and-print-dossiers.md) from its own step 1 — it starts from "is
the data here what I expect" and ends at a printed dossier.

## Known limitations

- **Live network, human-in-the-loop, and absent — see *Three boundaries* above.** A clean run of
  steps 1–3 refreshes TennisRecord data only; it says nothing about NTRP/WTN (step 4, manual) or
  anything TennisLink would have supplied (#27, unbuilt).
- **No `tn team list` yet.** *Before you start*'s `sqlite3` query is the substitute until it ships
  (`docs/cli/GRAMMAR.md`'s *Planned* list).
- **No automated check verifies this runbook's prose.** `test/cli-grammar-parity.test.ts` parity-checks
  only `docs/cli/GRAMMAR.md`'s `## Commands` table (noun/verb/summary, in both directions) — it has
  no opinion on anything under `docs/runbooks/`, and nothing else reads this file either.
  `test/dry-run-2025.test.ts` pins the command **spine** this runbook follows (the sequence composes
  end to end, offline, against fixtures) — a real and useful guard, but a partial one: it proves the
  commands compose, not that this specific document's wording (a flag name, a summary-line shape, a
  cross-reference) still matches the code. A flag renamed in `src/cli/commands/` tomorrow would not
  fail any check this repo runs; it would just make this page wrong until a human notices.
- **This runbook does not itself designate a home team or create events.** Those are one-time setup
  steps (`tn team home`, `tn event add`), not part of a recurring pre-tournament *refresh* — see
  [predict-an-opponent-lineup.md](predict-an-opponent-lineup.md) for availability, and
  [agent-chat-over-mcp.md](agent-chat-over-mcp.md) for captain notes.
