# Runbook: agent chat over MCP

## When to use this

Spec § Interfaces: "Same services; tool names mirror the grammar (`team_pull`, `player_show`,
`lineup_plan`, …). Agent chat is the analysis/planning surface and where captain notes are captured
conversationally." This runbook is how an HC points a real agent chat (Claude Code, Claude Desktop,
or any other MCP-capable client) at nadal's data and writes availability/captain notes
*conversationally* instead of one `tn player avail`/`tn player note` invocation at a time.

Every tool here calls the exact same service functions `tn` itself calls (`src/query/`,
`src/ingest/`, `src/report/write.ts`) — nothing is re-implemented for the MCP surface, so a dossier
built via `report_build` over MCP is byte-identical to one built via `tn report build`.

## Before you start

- The database is migrated (`tn db migrate`, or call the `db_migrate` tool as your first message —
  see *Steps* below; server construction never opens the database, so this is always safe as the
  first call on a brand-new machine).
- A home team is designated (the prompt form in
  [pre-tournament-full-pull.md](pre-tournament-full-pull.md) step 2, or the `team_home` tool) — availability
  and captain notes both refuse until one is (nadal ADR 0001, #37): they are "our team only, by
  design" (spec § Domain model), and there is no "our team" to scope them to otherwise.

## Transport: stdio, not Hono

Spec § Stack names "Hono for the MCP server." That premise turned out to be wrong for v1's actual
shape and was corrected here rather than silently: Hono is an HTTP framework, needed only for MCP's
*streamable-HTTP* transport. The consumer this runbook describes is a local agent chat on Randy's
own laptop talking to a local SQLite file — stdio needs no port, no bind address, and no auth story
at all, on a machine whose whole design premise is "zero-ops on a hotel laptop." `tn mcp serve`
therefore speaks stdio, and nothing in `src/mcp/` imports Hono. See the PR body / `docs/findings.md`
for the full reasoning; the transport sits behind the same `McpServer` object either way, so this is
cheap to revisit if a remote surface (e.g. a phone during the tournament) ever becomes worth it.

## Connecting a client

**Claude Code** — add a project- or user-level MCP server pointing at the `tn` binary:

```
claude mcp add nadal -- tn mcp serve
```

(Or hand-edit the client's MCP config with `"command": "tn", "args": ["mcp", "serve"]` — the exact
config file/format is the client's own, not nadal's; consult that client's own MCP docs.) Set
`TN_DB_PATH` (and `TN_REPORTS_PATH` if you want reports somewhere other than the repo-relative
default) in the server's environment the same way you would for the `tn` CLI directly — the MCP
server reads the identical env vars via the identical `src/db/client.ts`/`src/report/write.ts`.

## Tools available

Every tool mirrors a `tn` command 1:1 (`test/mcp-tool-parity.test.ts` enforces this both directions):
`db_migrate`, `team_pull`, `team_show`, `team_home`, `player_pull`, `player_show`, `player_avail`,
`player_note`, `event_add`, `match_add`, `lineup_plan`, `report_build`. `match_add` takes its
scorecard payload inline (see [in-event-screenshot-ingest.md](in-event-screenshot-ingest.md)) rather
than a file path — the one tool whose whole reason to exist is that the agent produced the payload
itself and has no file to hand. `player_note` additionally accepts an MCP-only `pairTarget` argument
for a pairing note (`src/cli/commands/player-note.ts`'s own doc comment explains why that stays
MCP-only rather than a third CLI positional) — this is the one deliberate CLI/MCP argument-shape
difference, and it is *additive*: every other argument matches the CLI grammar's target/payload
positionals by name.

## Steps: a captain-notes session

1. **Migrate and designate home**, if not already done:
   > "Call `db_migrate`, then call `team_home` with target `HOA/Burgess-Zingg/40&over3.5M`."
2. **Pull an opponent** so there's something to discuss:
   > "Call `team_pull` with target `<opponent TennisRecord URL or name>` and `players: true`."
3. **Look at a real dossier before trusting anything the agent says about it** — the counter-practice
   `docs/findings.md` names repeatedly: "generate the artifacts and look at them." Call `report_build`
   (bare, or with a `target`), then actually open the written `index.html`.
4. **Capture availability and notes conversationally.** This is the payoff spec § Interfaces
   describes — talk normally, and let the agent translate into tool calls:
   > "Randy Rostered is out Saturday, uncertain Sunday. Also: he serves big on break points, and he
   > and Kai Kestrel are strong together at the net."

   The agent should end up calling `player_avail` twice (`day: "2026-08-30"`, `status:
   "unavailable"`; `day: "2026-08-31"`, `status: "uncertain"`) and `player_note` twice — once plain,
   once with `pairTarget: "Kai Kestrel"`. **Read back what it recorded** rather than assuming intent
   translated correctly — the tool results themselves are the readback (`player_avail` returns the
   stored status *and the event it resolved to*; `player_note` returns the stored text). Not
   `player_show` or `report build`: those report only a data-gap *status*, never the values, so they
   cannot tell you whether the right day or the right event was written. See *Verifying what a write
   actually recorded* below for the row-level SQL when you need it.
5. **Re-render and check.** Call `report_build` again and re-open the dossier; the "prior meetings vs
   our players" section (populated once a home team is designated — Task 5, #17) and the "not
   collected yet" block (truthful about which sections actually have writers — it should now list
   `events` alone) are both worth a second look here, not just the availability you just added.

## Verifying it landed

> **Every direct `sqlite3` read below must target the database the MCP SERVER writes — and the
> server has its own environment.** `TN_DB_PATH` set for the server is not `TN_DB_PATH` set in your
> shell. Two distinct ways that bites, and a default fixes neither:
>
> - `sqlite3` **creates** a database at a path that does not exist, so a wrong path returns a
>   confident empty answer rather than an error;
> - and if `data/nadal.db` happens to **exist** from some earlier run, a default silently reads
>   unrelated historical rows — which looks like a successful verification.
>
> So there is no default here. Name the server's database explicitly and prove it exists:
>
> ```sh
> printf "the MCP server's database path: "; IFS= read -r DB || DB=
> test -f "$DB" || echo "STOP: no database at '$DB' — do not trust anything below" >&2
> ```
>
> Every read below is written `test -f "$DB" && sqlite3 "$DB" …`, so a missing path fails closed
> rather than fabricating an empty database. That guard cannot tell you the path is the *right* one,
> though — only you can, by matching it against the server's own environment. (This block took three
> attempts across the Codex adversarial review of #56: a hardcoded literal, then a default that could
> create the wrong file, then a default that could *read* an existing wrong one.)

- Every tool call writes a `request_log` row with `surface="mcp"` — `test -f "$DB" && sqlite3 "$DB"
  "select surface, command, outcome from request_log order by id desc limit 10"` shows the last ten calls
  from either surface, interleaved, which is the whole point of one shared telemetry table (spec §
  Request telemetry).
- **Verifying what a write actually recorded.** The tool's own result is the readback: `player_avail`
  returns the stored `availability` and the `event` it resolved to, `player_note` returns the stored
  note text. Check those rather than assuming a successful call means the intended value landed —
  the event a day resolves to is the part most worth confirming.

  `tn player show` is **not** a readback for these. It reports availability and captain notes only as
  a `dataGaps` status (`not-collected` / `empty` / `has-data`) — a count, never the rows — so it can
  tell you *that* something was recorded and never *what*. (This runbook previously said otherwise;
  corrected on #17 PR B after an independent review, since an HC following it would have treated
  "the section is no longer empty" as confirmation of a specific value.)

  For the rows themselves there is no command yet, so read the table directly:

  ```sh
  test -f "$DB" && sqlite3 "$DB" "select p.canonical_name, e.name, a.day, a.status
    from availability a
    join players p on p.id = a.player_id
    join events  e on e.id = a.event_id
    order by a.day"
  ```

## If `tn db migrate` fails with "duplicate column name: is_home"

Only reachable if you migrated a database **on this branch before it was merged with `main`** — i.e.
while it still carried the pre-merge `0004_free_warstar` migration. `main` later landed its own
`0004`, so this branch's home-team migration renumbered to `0005`; a database that recorded the old
`0004` will try to apply `0005` on top of a column it already has.

**Recovery is one line, and losing the database costs nothing by design.** This error is rethrown
unchanged, so it does **not** name the failing database — you have to identify it yourself:

```sh
# This error does not name the database, so the shell's TN_DB_PATH is the best signal available.
# Confirm it is the one you were using — `echo "${TN_DB_PATH:-data/nadal.db}"` — before running
# this; a stale value would move and rebuild an unrelated database.
case "${TN_DB_PATH:-}" in
  /*) DB="$TN_DB_PATH" ;;                                   # set, and absolute — use it as-is
  *)  printf 'absolute path to the database that failed: '  # otherwise paste it; `read -r` takes the
      IFS= read -r DB || DB= ;;                             # line verbatim, so quotes need no care
esac

case "$DB" in
  /*) export TN_DB_PATH="$DB"   # binds EVERY `tn` below — migrate, re-pull AND restore.
                               # A one-off `TN_DB_PATH="$DB" tn db migrate` binds only
                               # that child process; the restore would then write the
                               # default while appearing to succeed.
      mv -i -- "$DB" "$DB.pre-0005.bak" && tn db migrate ;;
  *)  echo "STOP: need an ABSOLUTE path; got '$DB'" >&2 ;;
esac
```

**Resolve it to an absolute path.** The `data/nadal.db` default is *relative* and resolves against
the working directory of the process, so recovering from a different directory than the failed run
used would move a different file entirely.

Two things this line used to get wrong, both fixed under #56 after the Codex adversarial review found
the same class one runbook over:

- It said `rm`, which is **destructive** for no benefit — `tn db migrate` only needs the file gone,
  and the backup is what makes the export procedure in
  [db-migration-recovery.md](db-migration-recovery.md) → *General note on data at risk* possible
  *after* you have a working database again rather than only before.
- It hardcoded `data/nadal.db`, so following it literally while `TN_DB_PATH` pointed elsewhere would
  have **deleted an unrelated database** and left the failing one untouched. That is the wrong-file
  class rated critical in issue #46, Codex round 1.

`-i` refuses a silent overwrite, `--` ends option parsing, and `"$DB"` double-quoted survives a path
containing a space *or an apostrophe* — which a pasted single-quoted path does not, the third defect
this line carried and the one that reached both runbooks. Check `ls "$DB".pre-0005*` first: a backup
name that is already taken means a *second* recovery would destroy the first one's captain notes.
See [db-migration-recovery.md](db-migration-recovery.md) for why each of those is there.

Then re-pull. The database is a *cache* over `raw/`, not a system of record — spec § Ingestion makes
every fetch an idempotent upsert and archives every page, precisely so it can be rebuilt at any time.
Nothing you typed by hand is at risk **except captain notes and availability**, which exist nowhere
else.

**Stay in the shell where you ran the `export` above** — the restore commands resolve their database
the same way `tn db migrate` does, so in a fresh shell they would write `data/nadal.db` and report
success. If you restore over MCP instead, the server must have been started with that same
`TN_DB_PATH`; the tools read the server's environment, not yours, and nothing in the tool result
would tell you they diverged.

**To recover those, follow
[db-migration-recovery.md](db-migration-recovery.md) → *General note on data at risk*, reading from
the `.pre-0005.bak` you just created** — not from the configured database path, which after the move
is either absent or a freshly rebuilt empty one. Three things that procedure gets right and a
one-liner here cannot:

- it exports **joined to names**, because `captain_notes` and `availability` store `player_id` /
  `event_id` foreign keys and a rebuilt database assigns new autoincrement ids — so a `select *` dump
  is unrestorable by construction, its numbers pointing at different players;
- it covers the **home-team designation and the events** as well, which notes and availability cannot
  be restored without;
- it names the **order** the three have to come back in.

This paragraph previously said `sqlite3 data/nadal.db "select * from captain_notes;"`, which was wrong
in all three ways *and* named the default database rather than the one that actually failed (Codex
adversarial review of #56, round 2, rated critical).

**This cannot happen to a database created after the merge**, which applies `0000`..`0005` in order.
No permanent repair path is shipped for it, deliberately: that would mean carrying
migration-reconciliation machinery in production forever to serve a window that closed on merge.

### The two tools added by #17 PR B

- **`lineup_plan`** takes a `target` (a team) and returns that team's **predicted lineup, which is a
  guess** — spec § Deliverables 1. The structured result is deliberately richer than the CLI's
  rendered text, because agent chat is where the pairings actually get worked: every slot carries a
  `confidence`, a `basis` (`history` or `rating`) and a `support` count, and the payload names the
  rating scale it ranked within, where the court set came from, who went unplaced, and how many of
  the roster's matches were excluded as belonging to other teams. Reason with those fields; do not
  present the slots as a lineup card.

  It **refuses** for a team with no court matches of its own on file. A roster whose players have
  long histories for *other* teams still refuses, and correctly so — see the
  [lineup runbook](predict-an-opponent-lineup.md) for why, and for the rule itself.

- **`event_add`** takes `target` (the event name), `kind` (`league` or `tournament`), `startsOn` and
  `endsOn`. It is idempotent on the name. It exists because `player_avail` resolves its event from
  the day, so without an event on file that tool cannot succeed at all.

  `player_avail` accordingly gained an **optional `event`** argument, needed only when a day falls
  inside more than one event's range — a league season and a tournament inside it, which is ordinary.
  Without it that day refuses and lists the candidates rather than guessing which you meant.

  `event_add` also takes an optional **`format`** (the court list, #63) and an optional
  **`leagueScope`** (#97) — `"exclude:Mixed"` for Springfield, `"only:Mixed"` for a mixed-doubles
  event over the same rows. Both follow "omitted preserves what is stored, given replaces it", so a
  call made only to correct a date never silently deletes either. Because MCP arguments are keyed
  rather than ordered, `leagueScope` is nameable here **without** also supplying a `format`, which
  the CLI's positional sixth argument cannot do.

- **`player_show` / `team_show`** take an optional **`event`** (#97), whose league scope restricts the
  court matches every record, slot tendency, partner count and prior-meeting row is computed over.
  This matters more in chat than at the terminal: agent chat is where the pairings get worked, so an
  agent reasoning over unscoped records while the printed binder shows scoped ones would be arguing
  from different evidence than the captain holding the page.

  The result carries an **`evidenceScope`** object either way — the filter applied (`null` when
  none), how many court matches were considered, retained and excluded, how many carry no league
  context at all, and the leagues that survived. Read it before quoting a record: after
  `exclude:Mixed`, a large share of what remains is still out-of-league, and `evidenceScope` is where
  that is stated rather than assumed.

## Known limitations
- **`team_pull`/`player_pull` still make real, live HTTP requests** when given a live target — an
  agent chat calling them mid-conversation hits the real network exactly like the CLI does. Prefer
  `--from`/`sourceUrl` (a previously-saved page) when testing against fixture data instead.
- **No authorization layer.** Anyone who can talk to the MCP server can call any tool, including
  writes. nadal is single-user, zero-ops — this is the same posture the CLI already has, not a new
  gap MCP introduces.
