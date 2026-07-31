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
- A home team is designated (`tn team home "<your team>"`, or the `team_home` tool) — availability
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
`player_note`, `event_add`, `lineup_plan`, `report_build`. `player_note` additionally accepts an MCP-only `pairTarget` argument
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
   translated correctly — `player_show` or `report build` shows exactly what landed.
5. **Re-render and check.** Call `report_build` again and re-open the dossier; the "prior meetings vs
   our players" section (populated once a home team is designated — Task 5, #17) and the "not
   collected yet" block (now truthful about which sections actually have writers — Task 5's other
   fix) are both worth a second look here, not just the availability you just added.

## Verifying it landed

- Every tool call writes a `request_log` row with `surface="mcp"` — `sqlite3 data/nadal.db "select
  surface, command, outcome from request_log order by id desc limit 10"` shows the last ten calls
  from either surface, interleaved, which is the whole point of one shared telemetry table (spec §
  Request telemetry).
- `tn player show "<name>"` (the CLI, not MCP) reads back availability/notes recorded via MCP — same
  database, same service functions, so there is nothing surface-specific to reconcile.

## If `tn db migrate` fails with "duplicate column name: is_home"

Only reachable if you migrated a database **on this branch before it was merged with `main`** — i.e.
while it still carried the pre-merge `0004_free_warstar` migration. `main` later landed its own
`0004`, so this branch's home-team migration renumbered to `0005`; a database that recorded the old
`0004` will try to apply `0005` on top of a column it already has.

**Recovery is one line, and losing the database costs nothing by design:**

```sh
rm data/nadal.db && tn db migrate
```

Then re-pull. The database is a *cache* over `raw/`, not a system of record — spec § Ingestion makes
every fetch an idempotent upsert and archives every page, precisely so it can be rebuilt at any time.
Nothing you typed by hand is at risk unless you had already recorded captain notes or availability on
that branch, in which case copy them out first (`sqlite3 data/nadal.db "select * from captain_notes;"`).

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

## Known limitations
- **`team_pull`/`player_pull` still make real, live HTTP requests** when given a live target — an
  agent chat calling them mid-conversation hits the real network exactly like the CLI does. Prefer
  `--from`/`sourceUrl` (a previously-saved page) when testing against fixture data instead.
- **No authorization layer.** Anyone who can talk to the MCP server can call any tool, including
  writes. nadal is single-user, zero-ops — this is the same posture the CLI already has, not a new
  gap MCP introduces.
