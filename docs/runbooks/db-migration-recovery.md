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
missed the old row and inserted a second one carrying the identical URL. Migration 0006 adds a
partial unique index on `teams.tennisrecord_url` (`WHERE tennisrecord_url IS NOT NULL`) to make that
column a real source identity going forward — and a database that already has such a pair fails the
`CREATE UNIQUE INDEX` itself. `runMigrations()` (`src/db/client.ts`) catches exactly this failure and
rethrows it naming the cause and this recovery, rather than surfacing SQLite's bare "UNIQUE
constraint failed: teams.tennisrecord_url".

**Recovery is one line, and losing the database costs nothing by design:**

```sh
rm data/nadal.db && tn db migrate
```

Then re-pull every team you had on file. No dedupe migration ships for this pair on purpose: which
of the two rows is "the" team, and what to do with a rename that collides with a name a *different*
row already holds, are merge decisions — spec § Ingestion puts a silent merge out of bounds
entirely, the same reasoning behind `upsertTeam`'s own `AmbiguousIdentityError` for that collision
case (issue #46). A blanket delete-the-database recovery is the honest alternative to carrying
merge-reconciliation logic in production for a database that is disposable by design.

## If `tn db migrate` fails with "duplicate column name: is_home"

Covered in [agent-chat-over-mcp.md](agent-chat-over-mcp.md), in its own "If `tn db migrate` fails
with..." section — only reachable on a database migrated on a specific pre-merge branch (#17 PR A),
and closed permanently for every database created after that merge. Same one-line recovery.

## General note on data at risk

The one-line recovery above is safe for the database itself, but **not** for anything recorded only
in it. If you had already captured availability or captain notes against the database you are about
to delete, copy them out first:

```sh
sqlite3 data/nadal.db "select * from captain_notes;"
sqlite3 data/nadal.db "select * from availability;"
```

Team rosters, ratings, and match history are never at risk this way — they are re-derivable from a
re-pull of the same `tennisrecord_url` targets, which is the whole point of treating the database as
a cache.
