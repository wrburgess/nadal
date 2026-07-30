# tn CLI Grammar

`tn <noun> <verb> <target> [payload] [flags]` — one spelling per operation; the entire surface
fits this table. Targets: bare text = name lookup; `usta:`, `wtn:`, `tr:` prefixes select an ID
namespace. Ambiguous names error with candidates listed — never guess. Global flags only:
`--quiet/-q`, `--json`, `--help`. GNU flag style, max one short alias per flag. Every command
prints one deterministic `key=value` summary line; non-zero exit on failure.

The parity test (`test/cli-grammar-parity.test.ts`) fails CI when this table and the router's
registry diverge — in either direction.

## Commands

Planned (spec § Interfaces; rows move up as commands land): `team pull/show/list`,
`player pull/show/note/list`, `match add`, `event show`, `lineup plan`, `report build`,
`db backup/restore`.
