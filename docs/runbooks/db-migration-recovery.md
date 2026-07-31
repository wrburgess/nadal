# Runbook: recovering from a `tn db migrate` failure

## When to use this

`tn db migrate` (or the `db_migrate` MCP tool) can refuse to apply a pending migration when an
existing on-disk database already holds data the new migration's constraint forbids. Every case
below shares the same recovery, for the same reason: `data/nadal.db` is a **cache**, not a system of
record. spec § Ingestion makes every fetch an idempotent upsert and archives every raw page under
`raw/` before parsing it, precisely so the database can be rebuilt from scratch at any time. Nothing
you typed by hand is at risk *unless* you had already recorded captain notes or availability against
that database — see the note at the end.

## If `tn db migrate` fails with "UNIQUE constraint failed: teams.tennisrecord_url"

Reachable if your database already holds **two team rows sharing the same `tennisrecord_url`** —
the exact damage issue #46 fixes: before that fix, `upsertTeam` conflicted only on `teams.name`, so
re-pulling a team that had been renamed upstream (the same TennisRecord URL, parsed to a new name)
missed the old row and inserted a second one carrying the identical URL. Migration 0009 adds a
partial unique index on `teams.tennisrecord_url` (`WHERE tennisrecord_url IS NOT NULL`) to make that
column a real source identity going forward — and a database that already has such a pair fails the
`CREATE UNIQUE INDEX` itself. `runMigrations()` (`src/db/client.ts`) catches exactly this failure and
rethrows it naming the cause and this recovery, rather than surfacing SQLite's bare "UNIQUE
constraint failed: teams.tennisrecord_url".

**Recovery is one line. It moves the database aside rather than deleting it** — substitute the path
the error message names, which is the database that actually failed (`TN_DB_PATH` if you set it,
`data/nadal.db` otherwise). The error prints this command with your real path already filled in:

```sh
mv -i -- '/abs/path/to/nadal.db' '/abs/path/to/nadal.db.pre-0009.bak' && tn db migrate
```

The command the error prints always uses **absolute** paths, so you can run it from wherever you are
standing, and neither argument can be mistaken for an option even if you set `TN_DB_PATH` to
something dash-prefixed. `-i` refuses to overwrite silently, and `--` ends option parsing — belt and
braces on top of the absolute paths. The backup name is also chosen to be one that does not already
exist, so recovering **twice** cannot destroy the first backup.

Deleting would work too — `tn db migrate` only needs the file gone — but there is no reason to make
the recovery destructive, and keeping the backup is what makes the export step below possible
*after* you have a working database again rather than only before. Delete the `.bak` once you have
re-pulled and confirmed the notes you cared about are restored.

Then re-pull every team you had on file. No dedupe migration ships for this pair on purpose: which
of the two rows is "the" team, and what to do with a rename that collides with a name a *different*
row already holds, are merge decisions — spec § Ingestion puts a silent merge out of bounds
entirely, the same reasoning behind `upsertTeam`'s own `AmbiguousIdentityError` for that collision
case (issue #46). Rebuilding from `raw/` is the honest alternative to carrying
merge-reconciliation logic in production for a database that is disposable by design.

## If `tn db migrate` fails with "index `teams_tennisrecord_url_unique` already exists"

Only reachable on a database you migrated **on the `fix/46-team-url-unique-identity` branch before
it was merged** — i.e. while #46's migration was still numbered `0006`. `main` then landed #49's
own `0006`/`0007`/`0008`, so #46's renumbered to `0009`, and drizzle's migrator decides what to
apply by a **timestamp watermark**, not per-migration hashes (`sqlite-core/dialect.js`: apply only
`if (Number(lastDbMigration.created_at) < migration.folderMillis)`).

That watermark is what breaks: a database carrying the old `0006` recorded `when = 1785511662427`,
which sits *between* #49's `0006` (`1785511384473`) and its `0007` (`1785515827922`). So on the next
`tn db migrate`:

| Migration | Outcome |
|---|---|
| #49 `0006_married_bug` | **skipped** — its timestamp is below the watermark |
| #49 `0007_big_blob`, `0008_lame_shaman` | applied |
| #46 `0009_premium_bruce_banner` | **fails** — the index already exists from the old `0006` |

So you end up with the roster-retirement columns missing *and* a failed migration.

**Recovery is the same one line, and losing the database costs nothing by design:**

```sh
mv -i -- 'data/nadal.db' 'data/nadal.db.pre-0009.bak' && tn db migrate
```

Then re-pull. Read *General note on data at risk* below **first** if you had recorded captain notes
or availability on that branch.

**This cannot happen to a database created after #46 merges**, which applies `0000`..`0009` in order
against a single consistent journal. No permanent repair path is shipped for it, deliberately and on
precedent: the same call was made for the `is_home` window below (#17 PR A), for the same reason —
carrying migration-reconciliation machinery in production forever to serve a window that closes at
merge, on a database the spec makes a disposable cache over `raw/`, costs more than it protects. The
reachability was checked rather than assumed before making that call: no `.db` file existed anywhere
at the time of writing.

## If `tn db migrate` fails with "duplicate column name: is_home"

Covered in [agent-chat-over-mcp.md](agent-chat-over-mcp.md), in its own "If `tn db migrate` fails
with..." section — only reachable on a database migrated on a specific pre-merge branch (#17 PR A),
and closed permanently for every database created after that merge. That section predates this one
and still writes the recovery as `rm`; prefer the `mv` form above for it too — the end state is
identical (`tn db migrate` only needs the file gone) and the backup costs nothing.

## General note on data at risk

The recovery above is safe for the database itself, but **not** for anything recorded only in it.
Team rosters, ratings, and match history are never at risk — they are re-derivable from a re-pull of
the same `tennisrecord_url` targets, which is the whole point of treating the database as a cache.
**Captain notes and availability are the exception: nothing outside the database holds them.**

Three things live only in the database, and **all three must come back in this order** — availability
cannot be entered before its event exists, and neither notes nor availability can be entered before a
home team is designated:

1. **The home-team designation** (`teams.is_home`) — set by `tn team home`, never by a pull.
2. **Events** — created by `tn event add`, never by a pull. Re-pulling restores teams, rosters,
   ratings and match history; it does **not** restore events, so an availability row exported with
   only its event *name* has nothing to attach to.
3. **Captain notes and availability** themselves.

Export them from the backup — **joined to names, never raw**. `captain_notes` and `availability`
store `player_id` / `event_id` foreign keys, and a rebuilt database assigns new autoincrement ids, so
a `select *` dump is unrestorable by construction: the numbers in it will point at different players.
Events must carry `kind`, `starts_on` and `ends_on` too, because those are the arguments
`tn event add <name> <league|tournament> <YYYY-MM-DD> <YYYY-MM-DD>` requires to recreate one.

`data/nadal.db.pre-0009.bak` below stands in for the backup path — use the one the recovery command
actually named, which is absolute and may not be under `data/` at all if you set `TN_DB_PATH`.

```sh
# 0. The home team and the events — without these, steps below have nothing to attach to.
sqlite3 -header -csv 'data/nadal.db.pre-0009.bak' "
  select name from teams where is_home = 1" > home-team-backup.csv

sqlite3 -header -csv 'data/nadal.db.pre-0009.bak' "
  select name, kind, starts_on, ends_on
  from events
  order by starts_on" > events-backup.csv

sqlite3 -header -csv 'data/nadal.db.pre-0009.bak' "
  select p.canonical_name        as player,
         pp.canonical_name       as pair_player,
         n.note,
         n.created_at
  from captain_notes n
  join players p        on p.id  = n.player_id
  left join players pp  on pp.id = n.pair_player_id
  order by n.created_at" > captain-notes-backup.csv

sqlite3 -header -csv 'data/nadal.db.pre-0009.bak' "
  select p.canonical_name as player,
         e.name           as event,
         a.day,
         a.status
  from availability a
  join players p on p.id = a.player_id
  join events  e on e.id = a.event_id
  order by a.day" > availability-backup.csv
```

`pair_player` is `LEFT JOIN`ed because `captain_notes.pair_player_id` is nullable — a note about one
player rather than a pairing. An inner join would silently drop every single-player note.

To restore after re-pulling, work back **up** the dependency order above.

> **Do not paste stored note text into a shell command.** A captain note is arbitrary text you
> typed: it can contain apostrophes, double quotes, backslashes, newlines, or `$(…)` / backticks.
> Inside double quotes a shell will *evaluate* the last of those, and an apostrophe breaks the
> single-quoted forms below — so the naive copy-paste can mangle, drop, or execute the very content
> this procedure exists to preserve. Player, team and event names have the same problem the moment
> one contains an apostrophe (`O'Brien`).
>
> The shell forms below are safe **only** for simple values — no quotes, no newlines, no `$` or
> backticks. For anything else, restore notes through the **`player_note` MCP tool** via
> [agent-chat-over-mcp.md](agent-chat-over-mcp.md): it takes the note as a **structured JSON
> argument**, so no shell ever parses it, and it is also the only route that can restore a
> **pairing** note. When in doubt, use it — it is strictly safer and never wrong.

```sh
# Safe for simple values only — see the warning above before using these for note text.
tn team home '<name from home-team-backup.csv>'
tn event add '<name>' '<kind>' '<starts_on>' '<ends_on>'      # one per events-backup.csv row
tn player avail '<player>' '<day>' '<status>' '<event>'       # one per availability-backup.csv row
tn player note  '<player>' '<note>'                           # one per captain-notes-backup.csv row
```

(Single quotes, not double, for the note: single quotes stop `$(…)`, backticks and `$VAR` from
being evaluated. They still cannot carry an apostrophe — that is the case the MCP tool exists for.)

Every one of those resolves the player, team and event by **name** against the rebuilt database —
which is why the export must carry names, and why the events export must carry `kind` and the date
range. Names are the only columns the old and new databases agree on.

Two more things to know about the restore. A note about a **pairing** (a non-empty `pair_player`
column in the export) cannot be restored from the CLI at all — `tn player note` takes one name by
design — but it *is* restorable through the `player_note` MCP tool, which accepts the second player.
And `captain_notes.created_at` is stamped at insert time, so restored notes carry the restore date
rather than the original; the exported CSV keeps the true timestamps, so keep it after restoring
rather than deleting it with the `.bak`.

A note on the CSV itself: `sqlite3 -csv` quotes and doubles embedded quotes correctly, so a note
containing commas, quotes or newlines **survives the export** intact. The hazard is entirely on the
way back in — a spreadsheet or a shell, not the file. Read it with a real CSV parser (or the MCP
route above), never with `cut -d,`.
