# tn CLI Grammar

`tn <noun> <verb> <target> [payload] [flags]` — one spelling per operation; the entire surface
fits this table. Targets: bare text = name lookup; `usta:`, `wtn:`, `tr:` prefixes select an ID
namespace. Ambiguous names error with candidates listed — never guess. Global flags only:
`--quiet/-q`, `--json`, `--help`. GNU flag style, max one short alias per flag. Every command
prints one deterministic `key=value` summary line; non-zero exit on failure.

Every value field in that summary line is double-quoted (e.g. `status=ok path="..."`), so a value
can safely contain spaces or `=` without being mistaken for a field boundary. Within a quoted
value: backslashes are escaped first (`\` becomes `\\`), then double quotes (`"` becomes `\"`) —
backslashes before quotes so an escape-aware parser can't misread an escaped backslash as also
escaping the quote after it. Before quoting, every value is sanitized: control characters
(Unicode category `\p{Cc}`), format/bidi characters (category `\p{Cf}`, e.g. RIGHT-TO-LEFT
OVERRIDE), and the Line/Paragraph Separators U+2028/U+2029 are each replaced with a single space —
this keeps the line single-line and un-spoofable. Sanitizing does not trim leading/trailing
whitespace: a quoted value preserves edge whitespace exactly (e.g. a `TN_DB_PATH` with a trailing
space round-trips unchanged), since quoting already makes it unambiguous. There is no `--` payload
terminator. `team pull` and `player pull` are the exception to "no additional flags beyond the
three listed" above: they also accept `--players` (team pull only, cascades each roster profile
link through a player pull), and `--from <path>` / `--source-url <url>` (read a previously-saved
page instead of fetching live — the two are required together). An unrecognized `--flag` on either
command is an error, not silently ignored.

The parity test (`test/cli-grammar-parity.test.ts`) fails CI when this table and the router's
registry diverge — in either direction. `dispatch` treats `--help` ANYWHERE in argv as a request
for help text (checked before the target is parsed), so a target literally spelled `--help` can
never be reached by any command.

## Commands

| Command | Summary |
|---------|---------|
| `tn db migrate` | Apply pending schema migrations |
| `tn team pull` | Pull a team roster and schedule from TennisRecord |
| `tn player pull` | Pull a player's ratings and match history from TennisRecord |

Planned (spec § Interfaces; rows move up as commands land): `team show/list`,
`player show/note/list`, `match add`, `event show`, `lineup plan`, `report build`,
`db backup/restore`.
