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

A bare **`--` ends flag parsing** — with one documented exception below: every token after it is a
target or payload, never a flag, so
`tn player note Randy -- "--poach at net"` records a note that begins with `--`. Global flags are
recognized only *before* the delimiter — past it, `--json` is literal text. An unrecognized flag
*before* `--` still fails, so the delimiter is not a way to silence a typo'd flag. (This is a change:
the grammar previously stated there was no `--` terminator, which was true when no command took a
free-text payload and became a defect the moment `player note` landed — an ordinary note beginning
`--` could not be recorded at all, and prefixing whitespace corrupts text that is deliberately
stored untrimmed. Found by the independent reviewer on #17 PR A.)

**The exception:** a `--` that is itself the *value* of a declared value flag (`--from`, `--source-url`
on `team pull` / `player pull`) is that flag's value, not a delimiter — the parser consumes it
statefully. `dispatch`'s help scan, which runs earlier and does not know a command's value flags,
uses a simpler first-`--` scan, so the two disagree in exactly that case: `tn player pull X --from --
--source-url URL --help` prints no help. This needs an argument literally named `--` to reach and is
tracked as #44 rather than fixed inside #17 PR A.

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
registry diverge — in either direction. `dispatch` treats `--help` anywhere **before the `--`
delimiter** as a request for help text (checked before the target is parsed), so `tn player note
--help` and `tn --help` both print help. Past the delimiter it is ordinary text: `tn player note
Randy -- --help` records a note reading `--help`. That exception exists because the help check runs
ahead of every command's parser, and without it the check would silently outrank the delimiter for
exactly one token — leaving `--help` the single payload the CLI could not record while the MCP
`player_note` tool accepted it, i.e. the same lossless-escape gap the delimiter exists to close.

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
| `tn report build` | Render per-opponent scouting dossiers (HTML + markdown) to disk |
| `tn mcp serve` | Run the MCP server over stdio, mirroring the CLI grammar as tools |

Planned (spec § Interfaces; rows move up as commands land): `team list`,
`player list`, `match add`, `event show`, `lineup plan`,
`db backup/restore`.

`tn report build [sectionals|<team>] [--json]` — `<team>` renders that one team's dossier;
`sectionals`, and bare (no target), render one dossier per team on file plus a top-level
`index.html`/`index.md`. Output root: `TN_REPORTS_PATH`, defaulting to repo-relative `reports/` —
mirroring `TN_DB_PATH`/`TN_RAW_PATH` exactly, so this introduces no new flag. Every write is
checked by the same hardened output-root guard `raw/` uses (`src/fs/output-root.ts`), with
`"reports"` as the one permitted in-repo directory — a misconfigured `TN_REPORTS_PATH` pointed at
any other in-repo path (e.g. `src`) is refused, exit 1.
