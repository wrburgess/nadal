# Runbook: backup and restore

## When to use this

Before anything risky to `data/nadal.db` (or wherever `TN_DB_PATH` points) — a migration, a bulk
re-pull, an experiment you might want to walk back. **Run `tn db backup` (#110).** It resolves the
source from `TN_DB_PATH` (`data/nadal.db` by default), refuses rather than silently overwriting an
existing snapshot, and reads back the written file's own table-by-table row counts against the
source before reporting success — the coordination step 2 below exists to hand-roll. On a
verification disagreement it leaves the (still-diagnosable) snapshot on disk rather than deleting
the only evidence of what went wrong.

**`tn db restore` does not exist yet.** Grep `src/cli/router.ts`'s `COMMANDS` registry and the noun
is absent; `docs/cli/GRAMMAR.md`'s *Planned* section still lists `db restore` as a future surface.
Until it ships, getting a backup file BACK into place means talking to SQLite directly — steps 3-5
below. Steps 1 and 2 below keep their manual `sqlite3` form too, labelled as the fallback for a
machine with no `tn` on `PATH`; prefer `tn db backup` when you have it, verified end to end against
a real database in the same way this drill always was: take a safe backup, prove it actually holds
your rows, restore it, and confirm `tn db migrate` still accepts the result.

## Before you start

- `sqlite3` on `PATH` (bundled with macOS; `apt install sqlite3` / `brew install sqlite3` elsewhere).
  This is a separate binary from the `better-sqlite3` npm dependency `tn` itself links against —
  this drill talks to the database file directly, never through `tn`, except to re-verify with
  `tn db migrate` at the end.
- Know the absolute path to the database: `TN_DB_PATH` if set (still resolved against **your
  shell's** cwd when it is a relative path — issue #111 does not change that explicit-override
  behavior), or `data/nadal.db` **anchored to the `tn` checkout itself** otherwise (issue #111 — the
  same file regardless of which directory you run `tn` from) — the same resolution `dbPath()` uses
  (`src/db/client.ts`).
- `tn` runs every database with `journal_mode = WAL` (`src/db/client.ts`) — every step below is
  written the way it is *because* of that, not despite it. See the callout in step 1.

## Steps

### 1. Take a backup — with `.backup`, never `cp`

**Prefer `tn db backup`** — no arguments, no prompts:

```sh
tn db backup
```

Prints `db backup status=ok source="..." destination="..." tables=N rows=M` and exits 0, or
`status=error message="..."` on stderr and exits 1 on any refusal or verification failure. The
destination is always `{source's directory}/backups/{name}-{UTC timestamp}.db`; there is no `--to`
override in v1. What follows is the manual fallback — for a machine with no `tn` on `PATH`, or to
hand-verify the mechanism `tn db backup` automates.

```sh
printf 'absolute path to the live database: '; IFS= read -r DB || DB=
printf 'absolute path to write the backup to: '; IFS= read -r BAK || BAK=

case "$DB" in
  /*) : ;;
  *) echo "STOP: need an ABSOLUTE path for the database; got '$DB'" >&2; exit 1 ;;
esac
case "$BAK" in
  /*) : ;;
  *) echo "STOP: need an ABSOLUTE path for the backup; got '$BAK'" >&2; exit 1 ;;
esac
# There are THREE parsers between you and this file, not one. (1) The shell, handled by quoting.
# (2) The dot-command below, which re-parses its argument with SQLite's OWN tokenizer — a `"` there
# is syntax, not pathname, so the backup lands somewhere other than $BAK, or nowhere. (3) The
# `file:…?mode=ro` URI form step 2 verifies through, where `?` starts the query string, `#` starts a
# fragment and `%` starts a percent-escape — so a legal path like /tmp/good?x=1 would be VERIFIED as
# /tmp/good, certifying a different database than the one you backed up. Refuse all of them here,
# once, before anything is written, rather than trying to escape correctly for three parsers.
case "$BAK" in
  *'"'*|*'?'*|*'#'*|*'%'*|*'
'*) echo "STOP: backup path must not contain a double quote, ? , # , % or newline; got '$BAK'" >&2; exit 1 ;;
esac
# And the SOURCE must already exist. `sqlite3 "$DB"` on a path with no file CREATES an empty
# database, which `.backup` then faithfully copies — producing a real, structurally valid, EMPTY
# backup. Step 2's `integrity_check` answers `ok` for it, because it is a perfectly good empty
# database. A typo in the source path is otherwise indistinguishable from a successful backup right
# up until the row counts, and by then you may already have discarded what you were protecting.
[ -f "$DB" ] || { echo "STOP: no database at $DB — nothing to back up" >&2; exit 1; }

sqlite3 "$DB" ".backup \"$BAK\"" || { echo "STOP: .backup failed" >&2; exit 1; }
```

Both prompts use `IFS= read -r` verbatim, same as
[db-migration-recovery.md](db-migration-recovery.md) — a path with a space or an apostrophe lands in
`$DB`/`$BAK` unchanged, with no shell-escaping to get wrong. Both are checked absolute before use,
so a relative `data/nadal.db` typed at either prompt cannot silently resolve against whatever
directory this shell happens to be in.

**Why `.backup`, never `cp "$DB" "$BAK"`.** A live database under `journal_mode = WAL` is not one
file's worth of truth — the most recently committed rows can sit in a sidecar `<db>-wal` file, not
yet checkpointed back into the main file (confirmed: a fresh `tn db migrate` plus one `player pull`
left `nadal.db-shm`/`nadal.db-wal` next to `nadal.db`; both prevent this in different ways, but the
underlying reason is the same). `cp` copies whichever single file you name, with no coordination
with SQLite's own locking — copy just the main file mid-session and the copy can miss whatever sits
in `-wal`; copy while `tn` (or anything else) is mid-write and the copy can land torn, mid-page, with
nothing to stop it. `sqlite3 "$DB" ".backup …"` instead drives SQLite's Backup API: it takes the
same lock a normal connection would, walks the live page set (WAL included), and produces one
self-contained file at `$BAK` — safe to run while `tn` is running, and safe against a concurrent
write landing mid-copy. Verified directly: `tn db migrate` + one `player pull --from` fixture-replay seed,
backed up with `.backup` while WAL sidecars were present, round-tripped every row through steps 2–5
below.

**Double-quote the destination *inside* the dot-command string, not single-quote it — this is a
second, separate quoting layer from the outer `"$BAK"` above, and it has its own hazard.** The
`sqlite3` shell's dot-commands run their own tiny quote-aware tokenizer over the one string they
receive, independent of the shell's. Verified: `sqlite3 "$DB" ".backup '$BAK'"` (single-quoted
*inside* the dot-command) against a real `O'Brien.db` path fails with
`Error: unknown database …/O` — the apostrophe closes the inner single quote early, and `.backup`'s
own two-argument form (`.backup ?DB? FILE`) then reads the fragment before the break as an *attach
point name*, not a path fragment, and silently repurposes the whole command instead of merely
writing to the wrong place. **It can be worse than a clean failure, too**: in one verification run
the leftover fragment after the broken quote (`Brien.bak'`, with the literal trailing apostrophe)
was not absolute, so `.backup` silently wrote a zero-byte file by *that* name into the shell's
current working directory — nowhere near `$BAK`, and nothing about the error message pointed at it.
Always check `git status` (or equivalent) after a misfired `.backup`/`.restore` for exactly this
kind of stray file, in whatever directory the command actually ran from — do not assume a failure
in stderr means nothing was written on disk. Double-quoting the inner argument survives an
apostrophe (verified against the same path); it does not survive a literal `"` in the path, which is
avoidable by not choosing a backup destination that contains one.

### 2. Verify the backup — a passing `PRAGMA` is not enough on its own

`tn db backup` already did this step itself — its readback-and-compare against the source's own
table counts (not merely `PRAGMA integrity_check`) IS this verification, and a disagreement is why
it would have exited non-zero above rather than printing `status=ok`. Run the manual version below
only when you took the backup by hand in step 1's fallback, or want independent confirmation.

```sh
# Check the file exists BEFORE opening it: `sqlite3 "$BAK"` on a missing path creates an empty
# database, and the very next command would then certify that fresh emptiness as `ok`. Verifying a
# backup by opening it is only meaningful once you know you are opening the backup.
[ -f "$BAK" ] || { echo "STOP: no backup file at $BAK — step 1 did not produce one" >&2; exit 1; }
# `immutable=1` on top of `mode=ro`: a finished backup is not being written by anyone, and telling
# SQLite so is what makes this open genuinely side-effect-free. `mode=ro` ALONE still lets SQLite
# create `-wal`/`-shm` sidecars beside the file when they are absent and the directory is writable —
# so "read-only" is a promise about your DATA, not about the filesystem, unless you add this.
sqlite3 "file:$BAK?mode=ro&immutable=1" "PRAGMA integrity_check;"
```

Expect the single line `ok`. This proves the file is not corrupt; it does **not** prove your data is
in it — `PRAGMA integrity_check` reports `ok` against an empty, freshly-created database too, because
opening a path that does not exist yet **creates** one (SQLite treats "open" as "create" — the exact
false-empty trap [db-migration-recovery.md](db-migration-recovery.md)'s own export guard was built
around after failing this same check across four attempts). Follow it with a readback naming real
rows:

```sh
# This fence is separately pasteable, so it carries its own guard — the rule this runbook states
# elsewhere and broke here. Without it, `BAK=/tmp/missing.db` makes sqlite3 CREATE that file before
# the query fails, and the empty file it leaves behind then satisfies step 3's `[ -f "$BAK" ]`
# check: a missed error here becomes an empty database restored over your live one.
[ -f "$BAK" ] || { echo "STOP: no backup file at $BAK" >&2; exit 1; }
# The URI form below is a THIRD parser (after the shell and the dot-command): `?` starts its query
# string, `#` a fragment, `%` an escape. /tmp/good?x=1 would open /tmp/good and silently drop
# mode=ro — certifying a DIFFERENT database than the one you backed up. Step 1 refuses these, but
# this fence is pasteable on its own, so it refuses them again rather than assuming step 1 ran.
case "$BAK" in
  *'?'*|*'#'*|*'%'*) echo "STOP: backup path must not contain ? , # or % ; got '$BAK'" >&2; exit 1 ;;
esac
# `mode=ro&immutable=1` for the same reason as the integrity check above: nothing is writing this
# finished backup, so this verification touches nothing at all — not the database, not a sidecar.
sqlite3 -header -column "file:$BAK?mode=ro&immutable=1" "select count(*) as teams from teams;
select count(*) as players from players;
select count(*) as court_matches from court_matches;"
```

If any of those reads back `0` when you expected rows, the backup did not capture what you think it
did — stop and re-run step 1 before trusting this file for anything. Keep these numbers; step 5
compares against them.

### 3. Restore it

```sh
printf 'absolute path to restore INTO (this will be overwritten): '; IFS= read -r TARGET || TARGET=
case "$TARGET" in
  /*) : ;;
  *) echo "STOP: need an ABSOLUTE path; got '$TARGET'" >&2; exit 1 ;;
esac
# Same fail-closed check as step 1, and it matters MORE here: `$BAK` goes into `.restore`'s own
# tokenizer, and the operation on the other side of it overwrites `$TARGET`. Refuse before the
# destructive step, never after it.
case "$BAK" in
  *'"'*|*'?'*|*'#'*|*'%'*|*'
'*) echo "STOP: backup path must not contain a double quote, ? , # , % or newline; got '$BAK'" >&2; exit 1 ;;
esac
# And the backup must exist before it overwrites anything. Without this, `.restore` on a missing
# `$BAK` opens/creates an empty database and restores THAT over `$TARGET` — a silent wipe dressed as
# a recovery, which is the worst possible outcome of this entire runbook.
[ -f "$BAK" ] || { echo "STOP: no backup file at $BAK — refusing to restore" >&2; exit 1; }

sqlite3 "$TARGET" ".restore \"$BAK\"" || { echo "STOP: .restore failed" >&2; exit 1; }
```

`.restore` is `.backup`'s mirror and carries the identical inner-quoting rule above — double-quote
`$BAK` inside the dot-command string, for the same reason, and refuse the characters that rule
cannot survive before running anything. **`sqlite3 "$TARGET" …` creates
`$TARGET` if it does not already exist** — the same open-creates-a-file behavior step 2 warned
about, except here it is the point: `.restore` then overwrites whatever schema that connection just
opened (or created) with the backup's. If `$TARGET` is a database still in use by a running
`tn mcp serve`, or by a shell with `TN_DB_PATH` exported to it, close that connection first — SQLite's
own locking contends with an open writer rather than silently corrupting anything, but the restore
can stall or fail partway rather than completing cleanly.

### 4. Re-run `tn db migrate` and confirm

```sh
TN_DB_PATH="$TARGET" tn db migrate
```

Expected: `db migrate status=ok path="<the $TARGET path>"`, exit 0 — verified directly (a restored
database that already carried every migration re-ran `tn db migrate` cleanly, applying nothing new,
same as any already-current database would). If a restored database instead predates a migration
this checkout has moved past, `tn db migrate` applies it now, same as any other database would; if
migration itself then fails, that is an ordinary `tn db migrate` failure and
[db-migration-recovery.md](db-migration-recovery.md) is the runbook for it, not this one.

### 5. Readback proving the restore actually landed

Don't stop at exit 0 above — confirm the counts from step 2 survived the round trip:

```sh
# Own guards, because this fence is pasteable on its own too — and because a readback is the last
# place that should be able to CREATE what it claims to be checking. Without these, a typo'd
# $TARGET leaves an empty decoy database behind and the query fails with "no such table: teams",
# which is easy to misread as a restore problem rather than a path problem.
[ -f "$TARGET" ] || { echo "STOP: no restored database at $TARGET" >&2; exit 1; }
case "$TARGET" in
  *'?'*|*'#'*|*'%'*) echo "STOP: path must not contain ? , # or % ; got '$TARGET'" >&2; exit 1 ;;
esac
sqlite3 -header -column "file:$TARGET?mode=ro" "select count(*) as teams from teams;
select count(*) as players from players;
select count(*) as court_matches from court_matches;"
```

These must match step 2's numbers exactly. A restore that silently landed an empty or partial
database would otherwise look identical to a healthy one at exit code 0 — the same
readback-over-trust-the-status-line discipline `docs/findings.md` names for every write in this
codebase, applied here to a restore instead of a `tn` command.

## What losing the database costs (and what it doesn't)

By design (`docs/runbooks/db-migration-recovery.md`), `data/nadal.db` is a **cache**, not a system
of record: team rosters, ratings, and match history are every one of them re-derivable by re-pulling
the same `tennisrecord_url` / USTA-profile targets — see
[pre-tournament-full-pull.md](pre-tournament-full-pull.md). Losing the database and re-pulling
everything costs time at Sectionals, not data, for those tables — which is exactly why a backup of
*that* data is nice-to-have rather than load-bearing.

**Three things live only in the database and re-pulling never brings them back**, per
`db-migration-recovery.md`'s own *General note on data at risk* — this is what a backup here is
actually protecting:

1. **The home-team designation** (`teams.is_home`, set only by `tn team home`).
2. **Events** (`tn event add`) — a re-pull restores teams/rosters/history, never events.
3. **Captain notes and availability** — nothing outside the database records either at all.

If you lose the database with no recent backup on hand, `db-migration-recovery.md`'s own
*General note on data at risk* section has export queries that work against **any** readable SQLite
file that still carries the old data — not only one shaped by `.backup` — but only if such a file
still exists somewhere at all. A backup taken by this drill is the reliable version of that fallback;
an ad hoc leftover file is the unreliable one.

## Known limitations

- **`tn db restore` does not exist.** It is listed in `docs/cli/GRAMMAR.md`'s *Planned* section
  only — grep `src/cli/router.ts`'s `COMMANDS` registry and the noun is absent. `tn db backup`
  (#110) shipped, so steps 1-2 above prefer it; steps 3-5 (the restore half) remain the manual
  substitute until restore is scoped and shipped too.
- **`tn db backup` has no `--to` flag.** The destination is always derived from the source's own
  path (`{source's directory}/backups/{name}-{UTC timestamp}.db`); there is no way to name a
  different destination from the CLI. Out of scope for #110 per PROJECT.md -> "What a PR is for".
- **No automated check verifies this runbook's prose.** `test/cli-grammar-parity.test.ts`
  parity-checks only `docs/cli/GRAMMAR.md`'s `## Commands` table (noun/verb/summary, in both
  directions); it has no opinion on `docs/runbooks/`, and nothing else reads this file either. A
  `sqlite3` flag or dot-command quoted wrong here would go undetected until someone actually ran the
  drill and hit it.
- **This is a manual drill, not a scheduled job.** Nothing in this repo runs it on a cadence.
  Forgetting to take a backup before a risky operation (a migration, a bulk re-pull) is on the
  operator, not on any safeguard this repo ships.
- **A backup is a point-in-time snapshot, not a log.** Anything recorded between your last backup
  and a loss is gone, same as any snapshot-shaped backup scheme — this drill has no incremental or
  continuous mode.
