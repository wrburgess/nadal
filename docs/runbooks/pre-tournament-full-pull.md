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
  # This `${TN_DB_PATH:-data/nadal.db}` fallback assumes you are running this shell FROM the tn
  # checkout root — it re-derives the default against THIS SHELL's cwd, which only matches what
  # `tn` itself resolves (issue #111: anchored to the checkout, not the caller's cwd) when the two
  # agree. Run this from the checkout root, or export TN_DB_PATH explicitly, so they cannot diverge.
  DB="${TN_DB_PATH:-data/nadal.db}"
  # Refuse before touching anything: sqlite3 CREATES an empty database for a path that does not
  # exist, so a typo in TN_DB_PATH would otherwise print "no teams", read as "nothing to refresh",
  # and leave a decoy file that a later `tn db migrate` happily migrates. Check first.
  [ -f "$DB" ] || { echo "STOP: no database at $DB — check TN_DB_PATH" >&2; exit 1; }
  # `?`/`#`/`%` are syntax to the `file:` URI parser below, which would silently open a different
  # file with mode=ro dropped. Refuse rather than escape for a third parser.
  case "$DB" in
    *'?'*|*'#'*|*'%'*) echo "STOP: database path must not contain ? , # or % ; got '$DB'" >&2; exit 1 ;;
  esac
  # Read-only: an enumeration should never be able to create the thing it is enumerating.
  sqlite3 "file:$DB?mode=ro" "select name, tennisrecord_url, is_home from teams order by name"
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

**Never type a team name into a command, and never paste one between quotes.** A team name is
*scraped data* — it comes from TennisRecord and lands in the database unaltered. Pasting it into
`tn team pull "<name>"` lets a `"` close the argument and run whatever follows; pasting it into
`team='<name>'` lets an `'` do the same, and apostrophes in team names are ordinary, not exotic.
This is this repo's own #56/#57 lesson (`docs/findings.md`) with the roles swapped: there a
*message* handed a human something executable, here a *runbook* would. Either way stored data must
never become syntax, and no amount of quoting advice fixes an instruction whose final step is
"splice this text into a command".

So the refresh **never carries a name at all.** It drives on each team's stored URL, which
`tn team pull` accepts directly (`src/ingest/team-pull.ts`'s `resolveTargetUrl`: an `https://`
target is used as-is). A URL is percent-encoded and cannot contain a space, a quote or a newline, so
it is safe *as shell transport*.

**Safe as shell transport is not the same as trusted, and the query below enforces the difference.**
`teams.tennisrecord_url` stores whatever target a previous `tn team pull` was given —
`resolveTargetUrl` accepts *any* `http://` or `https://` string with no host check, and the value is
persisted verbatim (`src/ingest/team-pull.ts:146`). So a one-off pull against some other host leaves
that host in the column, and an unfiltered batch would re-fetch it on **every** refresh from then
on, letting that page rewrite the roster. A one-time operator-chosen target is not the same risk as
a standing automatic one. The batch therefore selects **only** TennisRecord hosts, and prints
anything it skipped rather than silently dropping it:

```sh
# Same assumption as step "Before you start" above: this fallback re-derives the default against
# THIS shell's cwd, so it only agrees with `tn`'s own anchored default (issue #111) when you are
# running from the checkout root. Export TN_DB_PATH explicitly if you are not.
DB="${TN_DB_PATH:-data/nadal.db}"
[ -f "$DB" ] || { echo "STOP: no database at $DB — check TN_DB_PATH" >&2; exit 1; }
# The reads below use SQLite's `file:` URI form (`mode=ro`, so they cannot modify the DATABASE —
# note SQLite may still create `-wal`/`-shm` sidecars for a read-only connection, so this is a
# no-change guarantee about your data, not a no-file-touched one), and that
# form is its own parser: `?` starts the query string, `#` a fragment, `%` an escape. A database path
# containing one would silently open a DIFFERENT file with `mode=ro` dropped.
case "$DB" in
  *'?'*|*'#'*|*'%'*) echo "STOP: database path must not contain ? , # or % ; got '$DB'" >&2; exit 1 ;;
esac

# Anything stored that is NOT a TennisRecord URL — shown, never auto-pulled. Investigate before
# refreshing: a row here means some earlier pull targeted another host.
sqlite3 "file:$DB?mode=ro" "select name, tennisrecord_url from teams
  where tennisrecord_url is not null
    and tennisrecord_url not like 'https://www.tennisrecord.com/%'
    and tennisrecord_url not like 'https://tennisrecord.com/%'"

# Enumerate to a file, NOT into a pipe. `sqlite3 … | while …` reports the STATUS OF THE LOOP: an
# unreadable or corrupt database emits no rows, the loop body never runs, and the pipeline exits 0 —
# a total enumeration failure that reads exactly like "no teams to refresh".
urls="$(mktemp)" || exit 1
# Two traps, deliberately, because they do different jobs. EXIT only CLEANS UP — and it preserves
# whatever exit status was already set. The signal traps clean up AND exit: a handler that merely
# tidies up returns control to the next command, so Ctrl-C part-way through the pulls below would
# delete the file and then calmly keep issuing the remaining network pulls. Cancelling a batch has
# to actually cancel it.
trap 'rm -f "$urls"' EXIT
trap 'rm -f "$urls"; echo "ABORTED — refresh is PARTIAL" >&2; exit 130' HUP INT TERM
sqlite3 "file:$DB?mode=ro" "select tennisrecord_url from teams
  where tennisrecord_url like 'https://www.tennisrecord.com/%'
     or tennisrecord_url like 'https://tennisrecord.com/%'
  order by name" > "$urls" \
  || { echo "STOP: could not read teams from $DB" >&2; rm -f "$urls"; exit 1; }

failed=0
# Redirected, not piped, so the loop runs in THIS shell and `failed` survives it.
while IFS= read -r url; do
  [ -n "$url" ] || continue
  tn team pull "$url" --players || { echo "FAILED: $url" >&2; failed=1; }
done < "$urls"
rm -f "$urls"

# Exit NONZERO, not just noisy. `[ "$failed" -eq 0 ] || echo …` ends the block with echo's own
# (successful) status, so a partial refresh would still leave the block exiting 0 — the very
# outcome the accumulator exists to prevent.
if [ "$failed" -ne 0 ]; then
  echo "STOP: at least one pull failed — this refresh is PARTIAL" >&2
  exit 1
fi
```

The `failed` accumulator is not decoration: without it a failed pull followed by a successful one
leaves the loop's exit status 0, and a partial refresh reads as a clean one. **A team with no stored
`tennisrecord_url`, or one stored against another host, is skipped by the query** — the first
because there is nothing to pull it from, the second on purpose (above); the two queries in
*Before you start* and at the top of this step show you both sets rather than leaving them invisible.

To drive one team at a time, read it at a **prompt** rather than pasting it into shell syntax —
the same `IFS= read -r` pattern [db-migration-recovery.md](db-migration-recovery.md) and
[backup-restore.md](backup-restore.md) use. What you type at a prompt is never parsed by the shell:

```sh
printf 'team name (or its TennisRecord URL): '; IFS= read -r team
tn team pull "$team" --players
```

No `--from`/`--source-url` here — that pair replays a **previously saved** page (what the dry run
and this repo's own tests use to stay offline); leaving both off is what makes this command fetch
TennisRecord live. `--players` cascades every roster entry that carries a profile link through its
own `player pull`, so one command refreshes the team's schedule, roster membership, and (for linked
players) their own match history and TennisRecord dynamic rating together.

**The cascade fetches two seasons by default** (#108) — the team page's own and the one before it —
because TennisRecord's match history is partitioned by season, and pulling only the current one left
the database with no court-level play whatsoever from the prior season. Add `--since YYYY` to reach
further back; `--since <the team page's season>` narrows it to one.

Budget for that: **roughly double the requests of a one-season pull** — about 154 for a 77-player
field rather than 77 — against a source that has already been observed rate-limiting. Expect
proportionally more transient skips than the four seen in a single 20-player session, and handle them
exactly as below; nothing about a skip changes, there are just more chances to hit one. The
politeness delay between requests is unchanged, so a full-field pull takes correspondingly longer.

Expected: `team pull status=ok team="<team>" roster=N matches=M archived="<raw dir>/tennisrecord/….html" retired=R years="2026,2025"`, exit 0.

`years=` is the seasons the cascade actually fetched, newest first — **empty without `--players`**,
since nothing was cascaded. Check it rather than assuming: it is the only thing in the output that
distinguishes a full range pull from a one-season one.

`archived=` is where the raw fetched page landed (`TN_RAW_PATH` if set, `raw/` otherwise) — every
live pull archives the page it fetched before parsing it, the same as a `--from` replay archives the
file it read. `retired=R` is not a failure signal: it is how many previously-rostered players this
pull found absent from the current page (issue #49) — expected when a roster turns over between
pulls, worth a second look if `R` is large and unexpected.

**If a cascade partly fails**, the line reads
`team pull status=partial team="<team>" roster=N matches=M archived="…" retired=R years="…" skipped=K retryable=<n> permanent=<n> unclassified=<n> skippedEntries="<entries>"`
and exits 1. The team write already landed — only the named player pulls did not.

**Each skipped entry names its season**, as `"<name> (year=2025)"` (#108). That qualifier is the
retry instruction: a player listed for one season only needs that season re-pulled, and a player
listed for every season is a different problem. `K` therefore counts (player × season) failures, not
players — 36 on a total cascade failure across an 18-player roster and two seasons, not 18. A roster
entry with **no profile link** is the one unqualified entry: it is named once, without a season,
because no season was ever attempted for it.

**And each entry carries what to do about it**, as a `[retryable]` / `[permanent]` /
`[unclassified]` suffix, counted by the three fields that sum to `K` (#98). Read those first — they
size the work before you read a single warning:

| Field, when non-zero | Then |
|---|---|
| `retryable=` | those entries hit a fault **positively identified** as transient — HTTP 408/425/429 or any 5xx; a request timeout or abort; one of the enumerated connection codes `ECONNRESET` · `ECONNREFUSED` · `ETIMEDOUT` · `EAI_AGAIN` · `EPIPE`; or SQLite contention (`SQLITE_BUSY*`, `SQLITE_LOCKED`, `SQLITE_LOCKED_SHAREDCACHE`). Re-pull each `[retryable]` player individually (step 3); they typically succeed immediately. Four such failures in one live session were all clean on the first retry. |
| `permanent=` | those entries reproduce exactly on a retry — any other 4xx, a parse failure, an unruled ambiguous identity, or a roster row with no profile link. **Do not re-run them**; read the matching warning below and act on its cause. |
| `unclassified=` | the failure could not be positively identified either way. Read the `team pull: cascading …` warning for those entries; the reason is there. This is a deliberate third answer — a wrong `retryable` would have you re-run a doomed pull twice. **A network failure lands here more often than you might expect**: only the enumerated connection codes are `retryable`, so `ENOTFOUND` (NXDOMAIN — a dead host and a flapping resolver are indistinguishable), `ENETUNREACH` and `EHOSTUNREACH` all report `unclassified`. The reason names the code; judge it yourself. |

**There is no automatic retry, deliberately** — it carries its own rate-limiting question
(#96 → *Not in scope*, reaffirmed in #98).

**`skippedEntries` names the players it was CASCADING, which is not always who the problem is.** Once
the counts have told you the shape, read the `team pull: cascading …` warnings on stderr for the
cause; each one names the identity that actually failed **and why** (#96). Every warning ends
`— skipped` and carries its reason in between. There are three common causes:

- *A roster row with no profile link on the page at all* — tagged `[permanent]`, and cascades can
  never reach it.

  **`tn player pull "<their name>"` will NOT work here, and step 3 as written cannot help.** The team
  pull did create the player and their membership, but with no `tennisrecord_url` — so resolving them
  by name refuses with `unknown player target "<name>"`, because there is no stored handle to fetch.
  That is the same refusal a never-seen name gives, and it is not a bug: the roster page never
  supplied a URL for this person.

  Find their profile on TennisRecord by hand and pull **the URL**, which bypasses name resolution and
  stores the handle for next time:

  ```sh
  printf 'their TennisRecord match-history URL: '; IFS= read -r url
  tn player pull "$url"
  ```

  If no profile exists upstream, this roster entry cannot be enriched at all — the team is refreshed
  without their match history, and the `[permanent]` tag is telling you exactly that.
  (Found by the independent Codex review of PR #119: the previous wording sent an operator to a
  command that answers `unknown player target` every time.)
- *A fetch, parse, or write failure* — the warning reads
  `cascading "<roster player>" failed (error) — <reason>`. **The tag already sorted it for you; the
  disposition table above is the one place that says which failures map to which tag, and this bullet
  deliberately does not repeat it.** (It did, for three review rounds: once too wide — "a socket
  error" — and once too narrow, omitting SQLite contention and aborts. Every patch was right about
  the instance and wrong the next round, which is the tell that the second copy was the defect. Same
  class as the runbook digression deleted in #96.)

  What the tag does **not** tell you is *which* thing broke, and that is what the reason is for. On a
  `[permanent]` one it decides whether to look at the upstream page or at the parser; on an
  `[unclassified]` one it is the whole diagnosis, since nothing classified it for you.

  One thing worth internalizing rather than looking up: **a failure that looks like a network problem
  is not automatically `[retryable]`.** `ENOTFOUND`, `ENETUNREACH` and `EHOSTUNREACH` all tag
  `[unclassified]`, because none of them distinguishes a transient fault from a permanent one.

- *An ambiguous identity* — tagged `[permanent]`. The warning reads
  `cascading "<roster player>" failed (ambiguous) — ambiguous identity "<incoming>" (<where>) — near: <candidates>`,
  or, when that player's pull met more than one,
  `— <N> ambiguous identities — [1] "<incoming>" (<where>) — near: <candidates>; [2] …`.
  Here `<roster player>` usually resolves fine; each `<incoming>` is a partner or opponent met while
  ingesting their history, and those are the names needing a decision. Re-running the pull (whole or
  individual) refuses identically until someone rules on them:

  ```sh
  tn player distinct "<incoming>"          # different people who happen to look alike
  tn player alias "<candidate>" "<incoming>"  # the same person, spelled two ways
  ```

  **Rule on every identity the warning listed before re-running.** One pass reports all of them
  (#96), so the ruling session is one sitting rather than one round trip per name — this used to
  cost a full re-fetch of every roster member to reach each next ambiguity (`NE/Penland` took three
  complete `--players` runs, ~4 minutes each, to surface six). Ruling on one *can* change how a later
  name resolves, so a second run occasionally reports a new one; that is a smaller loop, not a
  guarantee of none.

  Then re-run the cascade. Observed live on `OK/Dickason` (#94): three skipped entries, whose real
  ambiguities were `Karson Davis` near `Mason Davis`, `Austin DuBois` near `Justin DuBois`, and
  `Steve Coon` near `Steve Boos` — none of them the three players `skippedEntries` named.

**Driving this from an agent rather than a terminal?** The `team_pull` MCP tool returns
`skippedRosterEntries` as one `{ entry, disposition, reason }` record per skip, so nothing has to be
extracted from the summary line. `skippedEntries=` is a human display — a scraped roster name can
itself contain a comma or a bracket, and neither is escaped against that (`docs/cli/GRAMMAR.md`).

### 3. Pull any player individually who needs it

Same rule as step 2 — a player name is scraped data too, so read it at a prompt rather than pasting
it into shell syntax:

```sh
printf 'player name (or their TennisRecord URL): '; IFS= read -r player
tn player pull "$player"
```

Expected: `player pull status=ok player="<name>" matches=N archived="<raw dir>/tennisrecord/….html"`,
exit 0. Same live-network rule as step 2: no `--from`/`--source-url` means a live fetch. Use this
for anyone step 2's cascade skipped, or any player you track outside a full team roster.

A refusal exits 1 and prints its reason in `message=`, in the same words the cascade warning uses —
including the plural form when this player's history holds several ambiguities:
`player pull status=error message="3 ambiguous identities — [1] … ; [2] … ; [3] …"`. Rule on every
one listed (`tn player distinct` / `tn player alias`, as in step 2) and re-run once.

**All-or-nothing means the DATABASE, not the disk.** No player, rating, court-match or participant
row is committed until the pull succeeds — the whole pull is one transaction and a refusal rolls it
back. The **raw page is already archived** either way: `archivePage` runs before parsing, so the
fetched HTML and its provenance sit under `TN_RAW_PATH` (`raw/` when unset) even for a pull that
refused. A **refused player pull does not print that path**, because only its `ok` result carries one
— so find the file by its URL-derived slug if you want to inspect what was fetched.

### 4. USTA/WTN ratings — human-in-the-loop, not this runbook's job

Neither step above ever touches USTA or WTN — TennisRecord carries neither rating. For every player
whose dossier needs NTRP or WTN, run the full procedure in
[login-assisted-scrape.md](login-assisted-scrape.md) end to end, with an HC signed in to
`account.usta.com`. That runbook owns its own verification step; this one does not duplicate it.

### 5. Verify the refresh actually landed — not just that each command said ok

A readback distinct from trusting each command's own `status=ok`:

```sh
printf 'team name: '; IFS= read -r team
tn team show "$team"
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

**If Sectionals' own court format is known, record it once (#63)** — a setup step, not part of the
recurring refresh loop, so it belongs here rather than in either of those two runbooks' own numbered
steps:

```
tn event add "Springfield Sectionals 2026" tournament 2026-08-28 2026-08-30 "S1:singles,D1:doubles,D2:doubles,D3:doubles"
```

Idempotent on the event name — safe to re-run every time you refresh, and it never clobbers a
previously-recorded format with a later call that omits the fifth argument. Once it is on file, name
the event on both the prediction and the build:

```
tn lineup plan "<opponent>" "Springfield Sectionals 2026"
tn report build sectionals "Springfield Sectionals 2026"
```

so every prediction and every dossier uses the tournament's own courts, rather than each team's own
observed history — see [predict-an-opponent-lineup.md](predict-an-opponent-lineup.md) step 0 for the
full syntax and what it changes in the output.

## Known limitations

- **Live network, human-in-the-loop, and absent — see *Three boundaries* above.** A clean run of
  steps 1–3 refreshes TennisRecord data only; it says nothing about NTRP/WTN (step 4, manual) or
  anything TennisLink would have supplied (#27, unbuilt).
- **No `tn team list` yet.** *Before you start*'s `sqlite3` query is the substitute until it ships
  (`docs/cli/GRAMMAR.md`'s *Planned* list).
- **A team name containing a literal newline cannot be driven by name, and an earlier draft of this
  runbook was wrong about why that is safe.** It claimed a newline-bearing name would simply split
  into two records that both fail to resolve, writing nothing. That is false: if a team is stored as
  `North⏎South` while teams named `North` and `South` also exist, a name-driven loop resolves both
  halves to those *unrelated* teams and live-pulls them — updating and possibly retiring rosters
  nobody asked to touch. This is exactly why step 2 drives on the stored **URL** instead: a
  percent-encoded URL cannot contain a newline, so the transport removes the failure mode rather
  than documenting it. The single-team prompt reads one line, so such a name cannot be entered
  whole there either — use its TennisRecord URL.
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
