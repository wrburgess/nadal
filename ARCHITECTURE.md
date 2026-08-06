# nadal — Architecture

**Who this is for:** someone who thinks in Model / View / Controller and wants to review this app's
*structure*, not its diffs. No TypeScript needed. Everything below is named at the directory or file
level, so you can open a folder and see whether the claim holds.

---

## 0. What nadal is

nadal scouts USTA league tennis and plans lineups for a specific destination: the Springfield
Sectionals. It **scrapes** public match history, **stores** it in one local SQLite file, **derives**
records and tendencies from it, and **prints** a per-team dossier a captain can carry to a match.

It has **two front doors over one model layer** — a command-line tool (`tn`) and an MCP server that
exposes the same operations to an agent. There is no web server and no user accounts: one operator,
one database file, one machine.

---

## 1. The MVC map

| Directory | Role | What lives there | What must **not** |
|---|---|---|---|
| `src/cli/` | **Controller** (+ its own View) | The `tn` front door: argument parsing (`src/cli/args.ts`), the command registry (`src/cli/router.ts`), and one file per command in `src/cli/commands/`. | Scouting, lineup, or persistence logic. A command should translate arguments, call one model function, and shape the result. |
| `src/mcp/` | **Controller** | The agent front door: the tool table (`src/mcp/tools.ts`) and the only server-aware file (`src/mcp/server.ts`). | Query or write logic — its own module note says so, and there is one live exception (§6). |
| `src/db/` | **Model** (schema + connection) | Table definitions (`src/db/schema.ts`), opening the database (`src/db/client.ts`), and the name-comparison primitives identity resolution depends on (`src/db/name-key.ts`). | Business rules. This layer says what a table *is*, not what it *means*. |
| `src/parsers/` | **Model** (input adapters) | Turning fetched HTML into typed records — one subdirectory per source. Pure functions over a document. | Fetching, database access, or filesystem access. This purity is real today and is the layer's whole contract. |
| `src/ingest/` | **Model** (writes) | Everything that brings the outside world in: fetching, archiving, identity resolution, and every write primitive. | Rendering for a human. Its errors are formatted once, in `src/ingest/errors.ts`, for both doors. |
| `src/query/` | **Model** (reads + domain services) | The derived-value layer: records, slot tendencies, partner frequency, rating trajectory, and the lineup prediction itself (`src/query/derive.ts`). | Fetching or parsing. Note the name undersells it — four files here also write (§6). |
| `src/report/` | **View** | The dossier: assembly and disk-writing (`src/report/write.ts`) and two renderers, `src/report/html.ts` and `src/report/markdown.ts`. | Deciding *what is true* — it renders a struct the model layer produced. |
| `src/fs/` | **Cross-cutting** | `src/fs/output-root.ts` — the single hardened path for every file this app writes: containment checks, exclusive creation, symlink and inode re-verification. | Nothing domain-specific. It is a security kernel, not a layer of the map. |
| `src/telemetry/` | **Cross-cutting** | `src/telemetry/request-log.ts` — one row per invocation, from either door. | Affecting the operation it wraps. A logging failure prints a line and is swallowed. |
| `src/sanitize.ts` | **Cross-cutting** | Stripping control and formatting characters at every **output** boundary. | Being mistaken for an input filter — see §4. |
| `src/error-message.ts` | **Cross-cutting** | Extracting a message from an arbitrary thrown value without trusting it. | — |

---

## 2. The front doors

**The `tn` CLI.** `bin/tn` launches `src/cli/main.ts`, which hands the arguments to the dispatcher in
`src/cli/router.ts`. Commands are a flat list — adding one means adding an import and an array entry.
There are **15**. The authoritative surface is `docs/cli/GRAMMAR.md`, which is guarded by an executable
test (`test/cli-grammar-parity.test.ts`); this document deliberately does **not** restate the command
table, because a second copy would drift from the guarded one.

**The MCP server.** `tn mcp serve` starts the server in `src/mcp/server.ts`, which registers the
**14** tools declared in `src/mcp/tools.ts`. Each tool's handler calls the *same model function* its
CLI sibling calls.

> **The invariant: front doors route and translate. Scouting and lineup logic lives in the model layer
> and is shared, never duplicated per door.**

Two pieces of evidence that it holds, and one that shows what breaking it costs:

- **Enforced, not merely intended.** `test/mcp-tool-parity.test.ts` asserts a two-way mapping between
  the CLI registry and the tool table, with `tn mcp serve` the single declared exception — the server
  cannot register itself as a tool of itself.
- **One brain, both doors.** The lineup heuristic exists once, in `src/query/derive.ts`; both doors
  reach it through the same wrapper in `src/query/lineup.ts`.
- **What it costs when violated.** The "this name is ambiguous" message used to live in the CLI
  directory. The MCP door had no reason to reach into the CLI for it, so it shipped a stale version.
  The formatter now lives in `src/ingest/errors.ts` — below both doors — and both call it.

**Where the doors legitimately differ.** The CLI returns an exit code and one `key=value` summary line;
MCP throws and lets the protocol shape the error. One capability is MCP-only by design: pairing a
captain's note to a second player, which the CLI has no argument for.

---

## 3. A request walkthrough

**"Refresh a player's record from TennisRecord, then rebuild their team's dossier."** It is two
commands, because that is genuinely how it works.

**Leg 1 — `tn player pull "<name>"`**

| Step | Where |
|---|---|
| Launcher resolves its own symlink chain, starts the app | `bin/tn` → `src/cli/main.ts` |
| Dispatcher finds the command, wraps it in telemetry | `src/cli/router.ts` → `src/telemetry/request-log.ts` |
| **Controller**: parse arguments, open the database, call one service | `src/cli/commands/player-pull.ts` → `src/db/client.ts` |
| **Model — fetch** the page, politely paced and timed out | `src/ingest/player-pull.ts` → `src/ingest/fetch.ts` |
| **Model — archive the capture *before* anything reads it** | `src/ingest/archive.ts` → `src/fs/output-root.ts` |
| **Model — parse** the saved bytes into typed records | `src/parsers/tennisrecord/` |
| **Model — resolve identity**: source ID, then alias, then a narrow fuzzy band | `src/ingest/identity.ts` → `src/db/name-key.ts` |
| **Model — persist**, all inside one transaction | `src/ingest/upsert.ts` |
| **View** — one deterministic summary line, sanitized | `src/cli/emit.ts` → `src/sanitize.ts` |

If a name is ambiguous, the whole transaction rolls back and the refusal names the incoming value, where
it came from, and the candidates it is near. The fetched page stays on disk, because it was archived
before parsing.

**Leg 2 — `tn report build "<team>"`**

| Step | Where |
|---|---|
| Same dispatcher, different command | `src/cli/router.ts` → `src/cli/commands/report-build.ts` |
| Anchor the season to the **event**, not to today's date | `src/query/events.ts` → `src/cli/window.ts` |
| **View entry**: assemble the dossier | `src/report/write.ts` |
| **Model**: team profile, each roster member's profile, the derived numbers | `src/query/team-profile.ts`, `src/query/player-profile.ts`, `src/query/derive.ts` |
| **Model**: the predicted lineup, labelled a guess | `src/query/lineup.ts` |
| **View**: render | `src/report/html.ts`, `src/report/markdown.ts` |
| Validate every file, *then* write every file | `src/fs/output-root.ts` |

The operator-facing versions of both legs are in `docs/runbooks/` — for example
`docs/runbooks/pre-tournament-full-pull.md` and `docs/runbooks/build-and-print-dossiers.md`.

---

## 4. Data flow and ownership

**Where the outside world gets in — three parsers, two very different entry paths.**

| Source | How it arrives | Parser |
|---|---|---|
| **TennisRecord** | Fetched live over HTTP, paced and timed out | `src/parsers/tennisrecord/` |
| **USTA** | **Never fetched.** The operator saves the rendered page from their own logged-in session and hands over the file (`docs/runbooks/login-assisted-scrape.md`) | `src/parsers/usta/` |
| **WTN** (world tennis number) | The **same bytes** as the USTA page — one capture, two parsers | `src/parsers/wtn/` |
| **Scorecards, in-event** | A photo, read by an agent into a checked payload (`docs/runbooks/in-event-screenshot-ingest.md`) | `src/ingest/scorecard.ts` |

**Archive before parse** is the discipline for all of them: the raw capture and a provenance sidecar
are written as a pair before a parser runs, so a parse failure leaves the page recoverable. The one
deliberate inversion is scorecard ingest, which commits to the database first — a refused ingest must
persist nothing.

**Who owns each table.** Schema in `src/db/schema.ts`; migrations in `drizzle/`, with a CI job in
`.github/workflows/ci.yml` that fails if the two disagree.

| Table | Written by | ⚠ |
|---|---|---|
| `players` | `src/ingest/identity.ts`, `src/ingest/upsert.ts`, `src/ingest/disambiguate.ts`, `src/db/name-key.ts` | 4 writers |
| `player_aliases` | `src/ingest/identity.ts`, `src/ingest/disambiguate.ts`, `src/db/name-key.ts` | 3 writers |
| `teams` | `src/ingest/upsert.ts`, `src/ingest/identity.ts`, `src/ingest/team-pull.ts`, `src/query/home-team.ts`, `src/db/name-key.ts` | 5 writers |
| `team_memberships` | `src/ingest/upsert.ts`, `src/ingest/roster-set.ts` | 2 writers |
| `team_matches` | `src/ingest/upsert.ts`, `src/ingest/match-add.ts` | 2 writers |
| `court_matches` | `src/ingest/upsert.ts` | |
| `court_match_players` | `src/ingest/upsert.ts`, `src/ingest/match-add.ts` | 2 writers |
| `rating_observations` | `src/ingest/upsert.ts` | |
| `events` | `src/query/events.ts` | |
| `availability` | `src/query/availability.ts` | |
| `captain_notes` | `src/query/captain-notes.ts` | |
| `request_log` | `src/telemetry/request-log.ts` | nothing reads it yet |

Which team is *ours* is a flag on `teams`, with a database-level guarantee that at most one row carries
it, and one writer — `src/query/home-team.ts`. The reasoning is in
`docs/adr/nadal/0001-our-team-is-a-team-level-flag.md`.

**Sanitization is an output control, not an input filter.** Nothing scrubs data on the way *into* the
database; scraped names are stored exactly as they were published. `src/sanitize.ts` runs at the four
places text leaves the app — the CLI summary line, MCP results, the rendered dossier, and the telemetry
row — because a hostile name is only dangerous once it reaches a terminal, a protocol, or a file.

---

## 5. Review questions for any future PR

Each of these is answerable by opening a named path.

1. **Is scouting or lineup logic leaking into a front door?** New logic in `src/cli/commands/` or
   `src/mcp/tools.ts` that is not argument translation, target resolution, or output shaping. The test:
   *could the other door reuse it?* If yes, it belongs below both.
2. **Does this belong in a parser or in ingest?** If it fetches, writes to the database, or touches the
   filesystem, it is not a parser. `src/parsers/` reads a document and returns records — nothing else.
3. **Did the change land on both doors?** `test/mcp-tool-parity.test.ts` guards tool *names* only. A new
   flag, result field, or refusal reaching one door and not the other is guarded by nothing.
4. **Which module writes this table now, and did that count go up?** Six tables already have more than
   one writer (§4). Adding a seventh deserves a sentence of justification.
5. **Is a derived value being stored?** Records and tendencies are computed at read time so they cannot
   go stale. A new column that could have been derived is a red flag.
6. **Was the raw page archived before it was parsed?** That ordering is the recoverability guarantee.
7. **Does the new output boundary sanitize?** Names are stored verbatim, so every new terminal,
   protocol, or file sink needs `src/sanitize.ts` plus its own medium's escaping.
8. **Does a refusal name the incoming value, its context, and the candidates?** `src/ingest/errors.ts`
   is the one formatter. A hand-rolled message is a regression.
9. **Is a new file write going through `src/fs/output-root.ts`?** A direct write bypasses every
   containment control.
10. **Is external input checked at the boundary, before it reaches the model layer?** Both doors and
    every parser should validate against a declared schema and fail closed rather than pass a
    half-understood value inward.
11. **Does the schema diff contain only this change's migration?** `drizzle/` is generated; an unrelated
    table appearing in the diff means something else was regenerated along with it.
12. **Does every MCP tool declare its full input schema?** An undeclared field is one that passes
    through unchecked and unlogged.

---

## 6. Where the map bends

§1 is the intended shape. These are the places the code does not match it today. They are listed so a
reviewer is not misled by a clean table — none is a bug in itself, and several are reasonable.

- **The View imports from the Controller directory.** `src/report/html.ts` and `src/report/markdown.ts`
  take their formatters from `src/cli/format-profile.ts`; `src/report/write.ts` takes season arithmetic
  from `src/cli/window.ts`. Shared rather than duplicated — but the shared home is `src/cli/`.
- **One front door imports from the other's directory.** `src/mcp/tools.ts` also uses
  `src/cli/window.ts`.
- **The View runs its own queries.** `src/report/write.ts` reads the `teams` table directly; no
  `src/query/` function owns "list all teams".
- **Both controllers run the same one-line query.** `src/cli/commands/team-home.ts` and
  `src/mcp/tools.ts` each fetch one team row by id.
- **`src/query/` is not read-only.** `src/query/events.ts`, `src/query/availability.ts`,
  `src/query/captain-notes.ts` and `src/query/home-team.ts` all write. Read it as *domain services*,
  not as a read model.
- **`src/db/` writes domain tables.** The name backfill in `src/db/name-key.ts` updates `players`,
  `player_aliases` and `teams`.
- **Ingest touches tables it does not own.** `src/ingest/match-add.ts` reads `events` and deletes from
  `court_match_players`; `src/ingest/player-pull.ts` reads `team_matches`.
- **The database-handle type lives under ingest.** Nine files across `src/query/`, `src/report/` and
  `src/db/` import it from `src/ingest/db-types.ts`.
- **The Controller directory contains its own View.** `src/cli/emit.ts`, `src/cli/format-profile.ts`
  and `src/cli/format-lineup.ts` are rendering code inside `src/cli/`.
- **`src/fs/output-root.ts` is the largest file in the app** and belongs to no letter of the map.
- **Nothing reads `request_log`.** Any claim that telemetry feeds analysis is aspirational today.

**And the two invariants that genuinely hold, which are the ones worth defending:**

- **`src/parsers/` is pure.** No fetching, no database, no filesystem — it imports only its HTML and
  schema libraries and its own helpers (`src/parsers/index.ts`, `src/parsers/dom.ts`,
  `src/parsers/types.ts`).
- **`src/query/derive.ts` imports only types.** The entire scouting and lineup heuristic — the part a
  captain actually acts on — touches nothing: no database, no clock, no filesystem. It takes rows and
  returns numbers, which is why it is the easiest part of this app to test and to argue about.

---

## 7. What this document is not

- **It is not governance.** It adds no rule, no gate, and no obligation on a PR beyond the one the
  issue that created it states: *a change that invalidates the map updates the map.*
- **It is not the command reference.** `docs/cli/GRAMMAR.md` is, and it is test-guarded. This document
  names directories; it never lists commands.
- **It is guarded only loosely, and the looseness is the honest part.**
  `test/architecture-paths.test.ts` is a **best-effort** check that tokens shaped like repo paths
  resolve on disk. It is a heuristic over delimiter-separated text — **not a Markdown parser, and not
  exhaustive**; its known bypasses are recorded as an accepted residual (#104) rather than implied away. It
  catches the case it exists for, a path here that no longer exists on disk, for every spelling this
  document actually uses. It does **not** check the things that matter more: whether a claim *about* a
  path is true, whether the map is complete, or whether a new `src/` directory was given a row. Those
  are maintained by reading, not by CI — as is every other document in this repo.
- **It supersedes an older count.** The v1 design spec
  (`docs/superpowers/specs/2026-07-29-nadal-v1-springfield-design.md`) describes "three thin
  presenters". There are **two** front doors; the dossier is a renderer, not a third door. That spec
  also lists commands that were never built and names libraries this app does not use. It remains the
  historical record of what was intended — this document describes what exists.
- **Known gaps and accepted limitations** are recorded one line at a time in `docs/findings.md`, not
  here.
