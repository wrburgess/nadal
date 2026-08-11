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

## Protocol revision and SDK version

**nadal speaks MCP `2025-11-25`, and deliberately does not track `2026-07-28`
([#106](https://github.com/wrburgess/nadal/issues/106)).**

| | nadal | Current standard |
|---|---|---|
| Spec revision | `2025-11-25` (down to `2024-10-07` on request) | `2026-07-28` |
| Package | `@modelcontextprotocol/sdk@^1.30.0` | `@modelcontextprotocol/{core,client,server}@2.0.0` |

**Nothing here will show up as an outdated dependency.** v2 was published under three *new* package
names, so `@modelcontextprotocol/sdk` still resolves `latest` to `1.30.0` and carries no deprecation
notice; `npm outdated` will never mention this. nadal is current on its dependency and behind on the
protocol, and those are separate facts.

**Why it stays.** The revision's [§ *Deprecated*](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
has four entries — Roots/Sampling/Logging; the HTTP+SSE transport; the `includeContext` values
`"thisServer"`/`"allServers"`; and OAuth 2.0 Dynamic Client Registration — and nadal's MCP surface
uses **none** of them, so nothing here is deprecated or broken.

What the revision *adds* splits two ways, and it is worth keeping them apart rather than waving at
the whole set:

- **Genuinely Streamable-HTTP-only** — the `Mcp-Session-Id` header, `subscriptions/listen` replacing
  the HTTP GET stream, and SSE resumability. None of that reaches a stdio server.
- **Protocol-wide, stdio included** — the removal of **protocol-level sessions** (list endpoints no
  longer vary per connection), statelessness (the handshake removal), a required `resultType` on
  every result, `ttlMs`/`cacheScope` on every list result, MRTR, and the error-code renumbering.
  **These do apply here.** What makes them not worth migrating for is that nadal *needs* none of
  them: `MCP_TOOLS` is a static array, so its list results already do not vary per connection and the
  session removal asks nothing of it; it initiates no server requests, so MRTR replaces nothing; it
  mints no error codes; and it has one client that is not polling a cache.

  **Session removal belongs in the second bucket, and an earlier draft of this page put it in the
  first.** Only the *header* is HTTP machinery — "protocol-level sessions" and the rule that list
  endpoints no longer vary per connection are transport-agnostic, and a stdio server holding
  connection-scoped list state would have to change. nadal does not hold any, which is a fact about
  nadal rather than a fact about the transport.

This is one local stdio process, one user, one SQLite file on a hotel laptop. Set against that: the
migration would rewrite every tool registration and re-open `src/cli/commands/mcp-serve.ts`, whose
stdin-EOF handling was established by *running* it against real pipes rather than from the SDK's
stated contract — and v2's transport is a rewrite, so that would have to be re-derived the same way.

**The one place a strict client could still refuse us, stated rather than smoothed over.** For the
missing `resultType` the spec supplies its own backward-compatibility rule — clients **MUST** read an
omitted field as `"complete"`. For `CacheableResult` (`ttlMs`/`cacheScope` on `tools/list`) the
changelog states no such rule, so a client that validates list results strictly could reject a v1
server's reply. That is unmeasurable from this side and is **exactly** what the trigger below exists
to catch — it is the reason this decision ships with a trigger instead of a compatibility claim.

**What was measured, not assumed** (`test/mcp-protocol-negotiation.test.ts` asserts all four, so
they stay true):

- **A client that never handshakes at all is served in full.** `2026-07-28` removes the
  `initialize`/`notifications/initialized` handshake and carries the protocol version in `_meta` on
  each request instead. The v1 server registers no initialization gate on its request path, so a bare
  `tools/list` from a stateless client is answered with the complete tool list. This is the case
  #106's own write-up expected to be the *one* real exposure; measuring it is what showed it is not.
- A client that *does* announce `protocolVersion: "2026-07-28"` is **not refused** either. The server
  answers with a successful result at `2025-11-25` — it downgrades an unrecognized version rather
  than rejecting it.
- `server/discover`, which `2026-07-28` says servers MUST implement and nadal does not, comes back as
  JSON-RPC `-32601 Method not found` **and the connection keeps working** — so a client's
  backward-compatibility probe is a recoverable refusal, not a dead session.
- An unknown *tool name* is different in shape and equally recoverable: a successful result carrying
  `isError: true`, never a crash.

**What nadal cannot promise.** Whether a real `2026-07-28` client actually *takes* that fallback is
the client's obligation, not this server's. The four facts above are nadal's half; they say nothing
about any particular client's behavior.

**Trigger to revisit — one observation.** *An MCP client connects to `tn mcp serve` and lists **zero**
tools.* That is the fallback failing, and it turns this from a currency question into a bug. If you
see it:

1. **From the nadal checkout**, run `npx vitest run test/mcp-protocol-negotiation.test.ts`. Green says
   this checkout's `McpServer` and all its tool registrations serve a newer-revision client over an
   in-process transport. It does **not** exercise the stdio transport, any binary, or your client.
2. **Probe the stdio surface**, which is the layer step 1 skips. Use the command your client is
   configured to launch — Claude Code prints it with `claude mcp get nadal` — rather than whatever
   `tn` happens to mean in your terminal:
   ```sh
   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | /abs/path/to/tn mcp serve
   ```
   A JSON-RPC line listing tools means that binary's whole server side — transport and registrations
   — is working.

**If both pass, the server side is intact and the cause is on the client side.** Reopen
[#106](https://github.com/wrburgess/nadal/issues/106) with your client, its version, the exact
command it is configured to launch, and what these two steps returned.

**Two limits, stated rather than engineered around** — this section was three steps longer and an
independent review found a defect in the extra steps in each of three successive rounds, so what is
left is only what this repo can actually verify:

- **If your client's configured command is a bare `tn` rather than an absolute path, step 2 cannot
  tell you which binary the client runs** — it resolves in the client's environment, not your shell.
  Say so in the issue; do not assume the two agree. (Configuring the client with an absolute path
  removes the ambiguity, but that is a change to *your* setup and this runbook will not script it for
  you — a `remove`-then-`add` silently drops any `--env` and `--scope` the entry had, which is the
  two-databases failure `docs/findings.md` already records.)
- **Neither step can conclude "this is the protocol case."** They establish that the server side
  works; every remaining cause — client config, client environment, a strict client refusing a v1
  reply — lives where this repo cannot see. That is what the issue is for.

## Tools available

**Every registered `tn <noun> <verb>` is an MCP tool named `noun_verb`** — `tn team pull` is
`team_pull`, `tn player avail` is `player_avail`, and so on. `test/mcp-tool-parity.test.ts` enforces
the rule in both directions, so a command without a tool, or a tool without a command, fails the
suite.

**The exceptions are the `CLI_ONLY_COMMANDS` set in that same test, and reading it there is the
point** — naming them here would rebuild, in miniature, the enumeration this section just deleted.
The test additionally asserts that every member of that set is genuinely CLI-only, so it cannot be
used to paper over a missing tool. At the time of writing it holds `tn mcp serve` alone, which is
CLI-only by construction rather than by omission: starting the server *is* the operation, so there is
no service function for it to call.

**So the tool list is the command list, and it has two live answers** — use one of these rather than a
list typed out here, which is exactly what went stale before (see the note below):

- **the client's own tool list** — whatever your MCP client shows for `nadal`, which is the server's
  own answer to `tools/list`; or
- **[`docs/cli/GRAMMAR.md`](../cli/GRAMMAR.md) § *Commands***, the command registry, which
  `test/cli-grammar-parity.test.ts` holds to `src/cli/router.ts`.

What *no* registry records, and what this section is really for, is where the two surfaces
deliberately differ:

- **`match_add` takes its scorecard payload inline** (see
  [in-event-screenshot-ingest.md](in-event-screenshot-ingest.md)) rather than a file path — the one
  tool whose whole reason to exist is that the agent produced the payload itself and has no file to
  hand.
- **`player_note` accepts an MCP-only `pairTarget` argument** for a pairing note
  (`src/cli/commands/player-note.ts`'s own doc comment explains why that stays MCP-only rather than a
  third CLI positional). This is the one deliberate CLI/MCP argument-shape difference, and it is
  *additive*: every other argument matches the CLI grammar's target/payload positionals by name.

> **Why this section no longer lists the tools** (#106). It used to, and the list drifted: it named
> twelve tools while `src/mcp/tools.ts` had seventeen, silently omitting `db_backup`, `lineup_build`,
> `roster_set`, `player_distinct` and `player_alias` — including `roster_set`, the tool that scopes a
> dossier to who actually registered. The parity test compares CLI commands to MCP tool names and
> never reads this page, so nothing caught it. Re-typing the list with five more names would have
> reset the same clock; adding a second markdown-parsing guard would have repeated a cost this repo
> has already paid in full (see `test/cli-grammar-parity.test.ts`, whose own comment records three
> review rounds producing three new parse defects and residual
> [#85](https://github.com/wrburgess/nadal/issues/85), and whose stated durable fix is to *remove*
> the parser). Deleting the third copy of a fact that already has a checked home is that fix.

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
# If TN_DB_PATH is unset, `tn` used its own anchored default — "<checkout>/data/nadal.db" (issue
# #111), NOT `./data/nadal.db` relative to wherever this shell happens to be — find the checkout
# root and use that path. A stale TN_DB_PATH would otherwise move and rebuild an unrelated database.
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

**Resolve it to an absolute path.** An explicit `TN_DB_PATH` set to a relative path still resolves
against the working directory of the process (issue #111 does not change that), so recovering from
a different directory than the failed run used would move a different file entirely. The *unset*
default no longer has this problem — it is anchored to the `tn` checkout itself — but a stale or
relative override is still a real way to end up moving the wrong file.

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
the same way `tn db migrate` does, so in a fresh shell (with `TN_DB_PATH` no longer exported) they
would fall back to `tn`'s own anchored default and report success — writing a *fresh*, freshly
migrated database at the checkout's `data/nadal.db` (the same file regardless of which shell or
directory you are in, since issue #111) rather than the file you moved aside. If you restore over
MCP instead, the server must have been started with that same `TN_DB_PATH`; the tools read the
server's environment, not yours, and nothing in the tool result would tell you they diverged.

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
