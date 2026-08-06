# tn CLI Grammar

`tn <noun> <verb> <target> [payload] [flags]` — one spelling per operation; the entire surface
fits this table. Targets: bare text = name lookup; `usta:`, `wtn:`, `tr:` prefixes select an ID
namespace. Ambiguous names error, naming the **incoming** value, **where** it came from, and the
candidates it is **near** — never guess; settle it with `player distinct` / `player alias` below.
Global flags only:
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

Every **string** value field in that summary line is double-quoted (e.g. `path="..."`), so a value
can safely contain spaces or `=` without being mistaken for a field boundary. Two kinds of field are
rendered **bare**, and deliberately: `status`, which is always the first field and always one of a
small code-controlled set (`ok`, `error`, `partial`, …), and numeric counts (`roster=18`). Neither
can contain a space, an `=`, or a control character, so quoting them would buy nothing and would
change the shape of every line every command has ever printed. (This paragraph previously claimed
*every* value field was quoted while its own example showed `status=ok` unquoted — issue #64.) The
rendering is pinned by an executable test rather than by this sentence: `test/cli-emit.test.ts`'s
*"status=ok prints a deterministic key=value line to stdout: status bare, strings quoted, numbers
bare"* asserts the literal line
`team pull status=ok team="Norbury" roster=18 matches=10 archived="raw/tennisrecord/x.html"`.
Within a quoted
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
`skipped=` / `skippedEntries=`. Each entry reads `"<name> (year=<Y>) [<disposition>]"`. The
`(year=<Y>)` qualifier is #108's: the cascade spans several seasons, and the same player can fail one
season and succeed another — a bare name could not say which, nor whether a retry should re-fetch one
season or all of them. The one exception is a roster entry with **no profile link at all**, which is a
property of the entry rather than of any season: it is named once, unqualified, because no season was
ever attempted for it. The team write has already committed and is not rolled back — that
is precisely why the outcome is `partial` rather than `error`, and why it must not be reported as
`ok`: a caller that reads only the exit code would otherwise record a success in which zero of the
requested player pulls happened.

The `[<disposition>]` suffix is #98's, and it answers *what to do next* — three values, alongside
three bare-number fields that count them and sum to `skipped=`:

| Disposition | Field | Means | Do |
|---|---|---|---|
| `retryable` | `retryable=` | positively identified as transient — a 5xx/408/425/429, a timeout, a socket or DNS error, or SQLite contention | re-run that player's pull; it typically succeeds immediately |
| `permanent` | `permanent=` | positively identified as reproducible — any other 4xx, a parse failure, an unruled ambiguous identity, or a roster row with no profile link | investigate; a retry reproduces it exactly |
| `unclassified` | `unclassified=` | neither could be established from the failure itself | read the `team pull: cascading …` warning on stderr, which carries the reason |

`unclassified` is a real third answer and not a placeholder: a wrong `retryable` would send an
operator to re-run a doomed pull twice before reading the warning, which is worse than saying nothing.
Every `retryable` and `permanent` verdict is derived from a typed error — an HTTP status, an error
class, or a `code` — never from matching the text of a message, because a failure's message can quote
a fetched page.

**`skippedEntries=` is a human display, not a parse target.** A roster name is scraped, so it may
itself contain a comma or a bracket, and neither the `", "` separator nor the `[…]` suffix is escaped
against that. A caller that needs to act per entry reads the `team_pull` MCP tool's
`skippedRosterEntries`, which returns one `{ entry, disposition, reason }` record per skip; a caller
that only needs to size a re-run reads the three count fields, which are their own `key=value` pairs
and need no extraction from a string.

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
| `tn db backup` | Take a verified snapshot of the database |
| `tn team pull` | Pull a team roster and schedule from TennisRecord |
| `tn team show` | Show a team's roster and match record |
| `tn team home` | Designate a team as home (our team) for availability, notes, and dossiers |
| `tn player pull` | Pull a player's ratings and match history from TennisRecord |
| `tn player show` | Show a player's full profile: ratings trajectory, history, records |
| `tn player avail` | Record a home-team player's availability for an event day |
| `tn player note` | Append a captain note about a home-team player or pairing |
| `tn player distinct` | Declare a name a different person from its near-matches, creating that player |
| `tn player alias` | Record a second spelling as the same person as a known player |
| `tn event add` | Create or update an event and its inclusive date range |
| `tn match add` | Record a scorecard's results from an agent-extracted payload |
| `tn lineup plan` | Predict an opponent's lineup from court-assignment history and ratings |
| `tn report build` | Render per-opponent scouting dossiers (HTML + markdown) to disk |
| `tn mcp serve` | Run the MCP server over stdio, mirroring the CLI grammar as tools |

Planned (spec § Interfaces; rows move up as commands land): `team list`,
`player list`, `event show`,
`db restore`.

`tn team pull <name|tr:…|url> [--players] [--since YYYY] [--from … --source-url …]` — `--players`
cascades each roster entry with a profile link through `pullPlayer`, and `--since` (#108) names the
**earliest season** that cascade fetches. The range is inclusive from `--since` through the team
page's own season, walked **newest-first**, and the seasons actually fetched are reported as
`years="2026,2025"` on every summary line — a one-season pull and a range pull are otherwise
indistinguishable from the output, which is how the original single-season cascade stayed invisible
for the whole v1 build.

**Omitted, `--since` defaults to the season before the team page's own**, so the default is a
two-season pull. That default is the fix rather than a convenience: before #108 the cascade fetched
exactly one season, and the database held no court-level play at all from the season before it. A
range that had to be opted into would have left a forgotten flag silently reproducing that.

`--since` refuses rather than clamping: a value that is not a four-digit year, one later than the
team page's season, or a span longer than ten seasons all exit `status=error` naming the bound and
the count. The ten-season ceiling is a typo guard — `--since 1990` against a 2026 team page would
otherwise issue roughly thirty-seven match-history requests **per roster entry**. "Four-digit" means
the value must also **round-trip** as a number: `0999` is refused, because the derived list is built
from the parsed number and would emit the three-digit `999` — accepting four digits and producing
three.

**`--since` without `--players` is refused, not ignored.** There is no cascade for it to bound, so
the flag can only mean the operator believes they asked for one; the refusal names the missing
`--players` rather than validating a value nothing would use.

**The range reaches match history only — never the team page.** A team profile at an older season is
a stale roster snapshot, and reconciling against one would soft-retire every player who joined since.
The team page is fetched exactly once, at its own season, whatever `--since` says.

`tn player avail <name> <YYYY-MM-DD> <status> [event]` — the fourth positional is **optional** and
names which event the day belongs to. It is needed only when the day falls inside more than one
event's range, which is ordinary rather than exceptional: a district league season runs Mar–Jun and
a districts tournament sits inside it in May, so every day in that window resolves to two events.
Without a name that day refuses (listing the candidates and saying to name one) rather than guessing
which event you meant — the same answer this grammar gives for every other ambiguous target. A name
supplied for an **unambiguous** day is still checked, not ignored: if it does not cover the day, the
command refuses. Availability is stored per (player, event, day), so the same player and day can
legitimately carry a different status for each overlapping event.

`tn player show <name|usta:…> [event]` and `tn team show <name|tr:…> [event]` — the optional trailing
`[event]` (#97) names an event whose **league scope** restricts the court matches every record, slot
tendency, partner count and prior-meeting row is computed over. Same optional-trailing-positional
shape as everywhere else; no new flags.

Both commands print the scope **whether or not one applies** — `evidence:` names the filter and the
count it set aside, `leagues counted:` names what survived it. The unscoped line ("no league scope
applied — every league counts") is not filler: a filtered record that does not say what it filtered
is the defect #97 was opened for, and an unfiltered record a reader cannot distinguish from a
filtered one is that same defect one step out. An unknown event **refuses** rather than quietly
falling back to unscoped, for the same reason `tn report build` refuses one.

Unlike `tn lineup plan`/`tn report build`, these two do **not** require the event to have a `format`
on file — they read its `league_scope`, never its court list. `tn team show`'s own `record:` line is
never scoped: it comes from `team_matches`, which carries no league context at all, and the printed
line says so.

`tn event add <name> <league|tournament> <YYYY-MM-DD> <YYYY-MM-DD> [format] [league-scope]` — payload positionals,
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

The sixth positional, `[league-scope]` (#97), is the event's **evidence scope**: which league
contexts a dossier built for this event may draw on. Syntax `<exclude|only>:<prefix>[,<prefix>…]`,
matched as a **case-insensitive prefix** of `court_matches.league_context` —
`"exclude:Mixed"` for Springfield Sectionals, and `"only:Mixed"`, its exact inverse, for a
mixed-doubles tournament reading the same rows. It follows the identical omitted-preserves /
given-replaces rule as `[format]`, with the identical v1 limitation (no way to clear one), and
silently dropping it on a routine date correction would be worse than dropping a format: the dossier
would not look wrong, it would quietly go back to counting every league.

**A court match with no `league_context` on file is retained by every scope, in both modes** — a
scope removes only what it can positively classify — and every surface reports that count separately
rather than folding it into a league. This is not a preference: `tn match add` records a null league
context for every court it takes from an in-event scorecard photo, and those are the event's own
courts, the most in-scope evidence there is.

**A scope is only reachable via the sixth positional if a `[format]` is also given**, since these are
ordered positionals. That is stated rather than worked around, and it is unreachable in practice:
the one command that READS a scope is `tn report build`, which already refuses an event with no
format on file, so an event worth scoping necessarily has a format to re-state. The `event_add` MCP
tool takes keyed arguments and has no such ordering, so `leagueScope` is nameable there alone.

`tn player distinct <name>` and `tn player alias <known> <other>` (#94) — the two rulings a human can
make about an ambiguous identity, and the **only** commands that write `players` / `player_aliases`
outside a scrape. Every other write path routes through the identity ladder, whose tier-3 contract is
"report the candidates and create nothing" (spec § Ingestion forbids a silent merge) — the right
refusal, and a dead end until these existed: a team with one colliding roster name could not be
pulled at all.

Both take positionals only, no flags. `distinct` says the incoming name is a **different person** and
creates it as its own player (recorded as its own first alias, exactly as a pull's own creation path
does), so the ladder's exact tier matches it from then on and the fuzzy tier is never consulted for it
again; the summary names who it is now `distinctFrom=`. `alias` says the two spellings are the **same
person** and records `<other>` against `<known>` — `<known>` accepts the `usta:`/`wtn:`/`tr:`
prefix-IDs as well as a bare name, and argument order is load-bearing: only `<known>` has to already
exist. Both are **idempotent** and exit 0 on a repeat, reporting `created=false` / `recorded=false`.

Neither merges two existing players. A merge would have to reassign court matches, memberships and
ratings, and is deliberately out of scope — `distinct` on a name already held by two rows refuses and
says so rather than adding a third.

They refuse in opposite directions, and the asymmetry is deliberate. `distinct` **requires the name to
actually be ambiguous**: a name near nothing was never refused by anything, so it is a typo (`Karsen`
for `Karson`) or a job for `player pull`, and accepting it would mint a person nobody meant to create
one letter from a real one. `alias` requires no such thing, because a spelling further away than the
fuzzy radius ("Bob" for "Robert") is never *reported* ambiguous — it silently creates a duplicate on
the next pull, which is exactly the case worth recording ahead of time. What `alias` does refuse is
an `<other>` another player already answers to: both rows would then share one comparison key, so the
name would resolve to two players **permanently**, and nothing removes an alias.

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

**A named event's league scope (#97) does NOT apply here, deliberately.** The obvious assumption is
the opposite, so it is stated: this command's evidence is already restricted by something stronger
than a league predicate — court matches linked to this team's own `team_matches` rows, which come
from the team's own league page. Measured on the live database when #97 landed, 89 of 89 of this
command's evidence rows were already `Adult 40+ 3.5`. Adding a league filter on top would remove
nothing and would imply a correctness this command gets from the team linkage instead. The scope
governs `tn report build`'s records, `tn player show` and `tn team show`; it does not govern this.

`tn report build [sectionals|<team>] [event] [--json]` — `<team>` renders that one team's dossier;
`sectionals`, and bare (no target), render one dossier per team on file plus a top-level
`index.html`/`index.md`. Output root: `TN_REPORTS_PATH` when set (resolved against the caller's cwd
when relative), defaulting otherwise to `reports/` anchored to the `tn` checkout itself (issue
#111 — the same directory regardless of which directory `tn` was invoked from) — mirroring
`TN_DB_PATH`/`TN_RAW_PATH` exactly, so this introduces no new flag. Every write is
checked by the same hardened output-root guard `raw/` uses (`src/fs/output-root.ts`), with
`"reports"` as the one permitted in-repo directory — a misconfigured `TN_REPORTS_PATH` pointed at
any other in-repo path (e.g. `src`) is refused, exit 1.

The optional trailing `[event]` (#63) is the same disambiguator `tn lineup plan` accepts, and it
applies to **every** dossier this run builds: each team's predicted-lineup section uses the named
event's format instead of that team's own observed history, with the same refusals (unknown event,
or one with no format on file) as `tn lineup plan`.

**The named event also supplies the dossier's evidence scope** (#97, `tn event add`'s sixth
positional). Each team's roster records, court-slot tendencies and prior-meeting rows are then
computed only over court matches that scope retains, and every dossier carries an **Evidence scope**
section naming the filter applied, the count it excluded, and — the other half — the leagues that
survived it. That last part is not decoration: after `exclude:Mixed`, between 37% and 69% of the
remaining evidence is still out-of-league (Adult 18+ 3.5, Adult 55+ 7.0/8.0, Tri-Level, Combo), an
accepted residual that the page states rather than leaves implicit. A build that names **no** event
prints the same section saying no scope applied.

Two things on the page are **not** covered by the scope, and the section says so: the team record
(derived from `team_matches`, which carries no league context) and the predicted lineup (restricted
to this team's own schedule instead — see `tn lineup plan` below).

The format and the scope are read from the event row **in one read**, once, before any dossier is
prepared. Two lookups would let a `tn event add` committing mid-build from the neighbouring `tn mcp
serve` process give one run version A's courts and version B's scope.

**The event's format is resolved exactly once, before any dossier is prepared** — not once per team.
That is what makes "every dossier" true rather than merely intended: nadal runs `tn mcp serve`
alongside a CLI invocation against one WAL database, so a `tn event add` committing part way through
a build is an ordinary concurrent-process interleaving, and a per-team lookup would let one batch
emit a two-court dossier and a four-court dossier that each name the same event. Resolving up front
also moves the refusal earlier: a bad name aborts the whole build **with nothing written**, in the
same fail-before-any-write direction the output-path validation already takes, and it is caught even
when no team on file has any lineup to build.
