# tn CLI Grammar

`tn <noun> <verb> <target> [payload] [flags]` — one spelling per operation; the entire surface
fits this table. Targets: bare text = name lookup; `usta:`, `wtn:`, `tr:` prefixes select an ID
namespace. Ambiguous names error with candidates listed — never guess. Global flags only:
`--quiet/-q`, `--json`, `--help`. GNU flag style, max one short alias per flag. Every command
prints one deterministic `key=value` summary line; non-zero exit on failure.

`--quiet`/`-q` and `--json` are accepted by **every** command automatically — a command never has
to declare them the way it declares `--players` or `--from` — because `parseArgs` recognizes both
ahead of any command-specific flag. `--quiet` suppresses the command's normal `status=ok` summary
line on stdout; it does **not** touch the exit code or anything written to stderr, so a caller
piping stdout to `/dev/null` still gets a meaningful exit code and still sees an `error`/`partial`
diagnostic. `--json` replaces the `key=value` line with `JSON.stringify` of the same fields (e.g.
`{"status":"ok","team":"Norbury","roster":18,...}`), values unquoted in the CLI sense (no
backslash-escaping — JSON's own string encoding applies instead). Passing both together: **`--quiet`
wins**, suppressing all stdout regardless of `--json`.

**`tn mcp serve` is the one exception, and it takes no arguments at all.** Its stdout *is* the
JSON-RPC stream, so a `--json` payload and a `--quiet`-suppressed summary line are both meaningless
there and writing either would corrupt the protocol. It therefore **rejects** every argument
(exit 1, diagnostic on stderr) rather than ignoring them — so a typo like `tn mcp serve --jsno`
surfaces instead of silently starting a server. `--help` still works, handled by `dispatch` before
the command runs.

`db migrate` rejects unrecognized flags and unexpected arguments the same way every command in this
table does — it used to take no `args` at all and silently accept anything after `tn db migrate`
(#44), unlike `mcp serve` above, which deliberately rejects *every* argument rather than parsing any.

Every value field in that summary line is double-quoted (e.g. `status=ok path="..."`), so a value
can safely contain spaces or `=` without being mistaken for a field boundary. Within a quoted
value: backslashes are escaped first (`\` becomes `\\`), then double quotes (`"` becomes `\"`) —
backslashes before quotes so an escape-aware parser can't misread an escaped backslash as also
escaping the quote after it. Before quoting, every value is sanitized: control characters
(Unicode category `\p{Cc}`), format/bidi characters (category `\p{Cf}`, e.g. RIGHT-TO-LEFT
OVERRIDE), and the Line/Paragraph Separators U+2028/U+2029 are each replaced with a single space —
this keeps the line single-line and un-spoofable. Sanitizing does not trim leading/trailing
whitespace: a quoted value preserves edge whitespace exactly (e.g. a `TN_DB_PATH` with a trailing
space round-trips unchanged), since quoting already makes it unambiguous.

A bare **`--` ends flag parsing:** every token after it is a target or payload, never a flag, so
`tn player note Randy -- "--poach at net"` records a note that begins with `--`. Global flags are
recognized only *before* the delimiter — past it, `--json` is literal text. An unrecognized flag
*before* `--` still fails, so the delimiter is not a way to silence a typo'd flag. (This is a change:
the grammar previously stated there was no `--` terminator, which was true when no command took a
free-text payload and became a defect the moment `player note` landed — an ordinary note beginning
`--` could not be recorded at all, and prefixing whitespace corrupts text that is deliberately
stored untrimmed. Found by the independent reviewer on #17 PR A.)

The rule holds in exactly one shared form, at **both** layers: a `--` that is itself the *value* of
a declared value flag (`--from`, `--source-url` on `team pull` / `player pull`) is that flag's
value, not the end-of-flags delimiter — never a real `--` that could terminate flag parsing. Both
`parseArgs` and `dispatch`'s `--help` scan (`scanFlags`, src/cli/args.ts) walk the same tokens with
the same classification rule to know this, which is what makes `tn player pull X --from --
--source-url URL --help` print help rather than fail with "unrecognized flag --help" (#44 — the two
scans used to disagree here, because `dispatch` ran its own naive first-`--` scan that did not know
any command's value flags).

`team pull` and `player pull` are the exception to "no additional flags beyond the
three listed" above: they also accept `--players` (team pull only, cascades each roster profile
link through a player pull), and `--from <path>` / `--source-url <url>` (read a previously-saved
page instead of fetching live — the two are required together). An unrecognized `--flag` on either
command is an error, not silently ignored.

`status=` carries a third value beyond `ok` and `error`: **`status=partial`**, emitted by
`tn team pull --players` when the team itself was written but one or more requested roster cascades
did not land. It prints to stderr and **exits non-zero**, and names the affected entries in
`skipped=` / `skippedEntries=`. The team write has already committed and is not rolled back — that
is precisely why the outcome is `partial` rather than `error`, and why it must not be reported as
`ok`: a caller that reads only the exit code would otherwise record a success in which zero of the
requested player pulls happened.

The parity test (`test/cli-grammar-parity.test.ts`) fails CI when this table and the router's
registry diverge — in either direction. `dispatch` resolves the noun+verb pair FIRST, and how it
looks for `--help` then depends on whether that resolved:

- **Unresolved** (no such noun+verb, or a bare `tn --help` where there is no verb at all): a raw
  scan of the whole argv, stopping at the first bare `--` if one is present, exactly as if no
  command's flags existed to be value-flag-aware about — there are none. `tn --help`,
  `tn player --help`, and `tn bogus nope --help` all print help this way, rather than the exit-2
  unknown-command diagnostic.
- **Resolved** (a real command, e.g. `db migrate`, `player pull`): the SAME `scanFlags` walk
  `parseArgs` uses, over the same tokens the command's own parser receives, using that command's
  declared `booleanFlags`/`valueFlags`. `tn player note --help` prints help (`tn --help` also does,
  but by the *unresolved* path above — there is no `tn --help` command to resolve);
  past the delimiter it is ordinary text (`tn player note Randy -- --help` records a note reading
  `--help`), and a `--` consumed as a declared value flag's value is likewise never the delimiter —
  see above. Help is checked ahead of every resolved command's own parser, and without that check
  the parser would just reject `--help` as unrecognized — leaving `--help` the one payload the CLI
  could not record while the MCP `player_note` tool accepted it, i.e. the same lossless-escape gap
  the delimiter exists to close (found by the independent reviewer on #17 PR A).

## Commands

| Command | Summary |
|---------|---------|
| `tn db migrate` | Apply pending schema migrations |
| `tn team pull` | Pull a team roster and schedule from TennisRecord |
| `tn team show` | Show a team's roster and match record |
| `tn team home` | Designate a team as home (our team) for availability, notes, and dossiers |
| `tn player pull` | Pull a player's ratings and match history from TennisRecord |
| `tn player show` | Show a player's full profile: ratings trajectory, history, records |
| `tn player avail` | Record a home-team player's availability for an event day |
| `tn player note` | Append a captain note about a home-team player or pairing |
| `tn event add` | Create or update an event and its inclusive date range |
| `tn match add` | Record a scorecard's results from an agent-extracted payload |
| `tn lineup plan` | Predict an opponent's lineup from court-assignment history and ratings |
| `tn report build` | Render per-opponent scouting dossiers (HTML + markdown) to disk |
| `tn mcp serve` | Run the MCP server over stdio, mirroring the CLI grammar as tools |

Planned (spec § Interfaces; rows move up as commands land): `team list`,
`player list`, `event show`,
`db backup/restore`.

`tn player avail <name> <YYYY-MM-DD> <status> [event]` — the fourth positional is **optional** and
names which event the day belongs to. It is needed only when the day falls inside more than one
event's range, which is ordinary rather than exceptional: a district league season runs Mar–Jun and
a districts tournament sits inside it in May, so every day in that window resolves to two events.
Without a name that day refuses (listing the candidates and saying to name one) rather than guessing
which event you meant — the same answer this grammar gives for every other ambiguous target. A name
supplied for an **unambiguous** day is still checked, not ignored: if it does not cover the day, the
command refuses. Availability is stored per (player, event, day), so the same player and day can
legitimately carry a different status for each overlapping event.

`tn event add <name> <league|tournament> <YYYY-MM-DD> <YYYY-MM-DD> [format]` — payload positionals,
the same shape `tn player avail` uses, so this adds no flags. The date range is **inclusive at both
ends**, matching the day lookup `tn player avail` resolves its event through, and a single-day event
(`starts-on` equal to `ends-on`) is legal. A repeat under the same name **updates in place** rather
than duplicating (`events.name` is unique) — except that an update whose new range no longer covers
a day this event already has availability recorded for is **refused**, naming those days. Moving or
narrowing a range is otherwise a silent way to strand availability on an event that no longer
contains it, and which the operator meant — widen the range, or drop that availability — is not
something the command should decide. This is the one target-taking command that does not
resolve its target against existing rows — it is the writer that creates them. It exists because
nothing in production wrote an `events` row before it, which made `tn player avail` unreachable: the
availability writer resolves its event from the day, and there were never any events to find.

The fifth positional, `[format]` (#63), is the event's own court list: a comma-separated
`slot:discipline` list, e.g. `"S1:singles,D1:doubles,D2:doubles,D3:doubles"` — `discipline` is
exactly `singles` or `doubles`, never inferred from the slot's own spelling. It is what
`tn lineup plan`/`tn report build`'s optional trailing `event` argument reads to replace their
derived slot set (see below). **Omitted on a repeat, it PRESERVES whatever format is already
stored** — the same "never clobber a stored value with an incoming null" rule
`upsertTeamMatch` already runs for `scheduledTime`/`site` — so a routine date correction never
silently deletes a format recorded earlier. Given, it REPLACES the stored value outright; there is
no way to CLEAR a stored format back to nothing in v1.

`tn match add <payload-file>` — a positional target, no new flags (like every command above except
`team pull`/`player pull`). The payload is a JSON file matching the scorecard contract in
`src/ingest/scorecard.ts`: a played-on date, both team names, and a list of courts (slot,
discipline, players by side, and an optional winner/score). **This command cannot read a
screenshot directly** — spec § Ingestion path 4 puts extraction through agent vision, not
in-process image decoding, so a photo handed to `tn match add` is refused with a message pointing
at the `match_add` MCP tool instead. Every player name resolves against the NAMED team's own
roster only — a name unresolved, ambiguous, or matching a player on the *other* team's roster is
flagged, never guessed, and the whole ingest is refused (rolled back, nothing written) until every
name is fixed, typically by supplying a `usta:`/`tr:`/`wtn:` prefix-ID in the payload instead of a
bare name. See `docs/runbooks/in-event-screenshot-ingest.md` for the full photo-to-verified-rows
flow, including what to do when a name is flagged.

`tn lineup plan <team> [event]` — renders that team's **predicted lineup, which is a guess** (spec §
Deliverables 1), from court-assignment history plus ratings. The rule is pair-first: the most
frequent doubles partnerships are placed at the slot they most often shared, S1 goes to the player
with the most singles court matches, and ratings break every tie and fill every gap. Each slot
carries a confidence (`high`/`medium`/`low`, from the count of supporting observations) and a basis
(`history` or `rating`), unplaced players are listed rather than dropped, and the output names both
the rating source it ranked within and where the slot set came from.

**The slot set is derived from the team's observed court-match history by default** — no `[event]`
named, unchanged from before #63 — so a team whose league history has five courts is predicted
across five even at a four-court event; the output says so rather than hiding it. **Naming an
`[event]` (#63) — the optional trailing positional, the same shape `tn player avail` uses —
REPLACES the derived set with that event's own format instead**: the event's courts, in the event's
own order, and the output names which event supplied them. The event resolves by exact `events.name`
(the same resolve-by-name-or-refuse mechanism `tn match add` already uses, never inferred); an
unknown name, or one on file with no format recorded (`tn event add`'s optional fifth positional),
**refuses** rather than silently falling back to the observed set. An observed slot absent from the
named event's format is simply not predicted for; a format slot the team has never played is filled
by the same rating-ranked leftover step that already reports a slot "short or empty rather than
omitted".

**Only this team's own matches count as evidence.** A roster member's history includes every league
they play in (spec § Ingestion ingests "their other leagues (18+ etc.)"), and a partnership formed
on a different team says nothing about how *this* team fields courts — so evidence is restricted to
court matches linked to one of this team's `team_matches` rows, and anything else is excluded and
reported as a count. A team whose roster has long individual histories but no matches of its own
therefore **refuses**, which is the honest answer rather than a confident guess built on borrowed
evidence.

`tn report build [sectionals|<team>] [event] [--json]` — `<team>` renders that one team's dossier;
`sectionals`, and bare (no target), render one dossier per team on file plus a top-level
`index.html`/`index.md`. Output root: `TN_REPORTS_PATH`, defaulting to repo-relative `reports/` —
mirroring `TN_DB_PATH`/`TN_RAW_PATH` exactly, so this introduces no new flag. Every write is
checked by the same hardened output-root guard `raw/` uses (`src/fs/output-root.ts`), with
`"reports"` as the one permitted in-repo directory — a misconfigured `TN_REPORTS_PATH` pointed at
any other in-repo path (e.g. `src`) is refused, exit 1.

The optional trailing `[event]` (#63) is the same disambiguator `tn lineup plan` accepts, and it
applies to **every** dossier this run builds: each team's predicted-lineup section uses the named
event's format instead of that team's own observed history, with the same refusals (unknown event,
or one with no format on file) as `tn lineup plan` — a bad name aborts the whole build rather than
producing dossiers that silently disagree about which slot set is in effect.
