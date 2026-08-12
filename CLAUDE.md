# CLAUDE.md

nadal runs on **deuce**. The standard is read at its source —
[github.com/wrburgess/deuce](https://github.com/wrburgess/deuce) — and never vendored; what ships
here is deuce's payload, and [`config/vendoring-receipt.md`](config/vendoring-receipt.md) records
the exact commit this repository vendored. [`PROJECT.md`](PROJECT.md) carries this host's own
values: quality checks, attribution, branch policy, gates, the findings-log discipline.

## The lifecycle

Work runs through the six shipped lifecycle Skills. Each is a **contract file** deuce updates by
sync pull request — read them, never edit them (an edit is drift the receipt's checksums report):

[`skills/assess/SKILL.md`](skills/assess/SKILL.md) ·
[`skills/devise/SKILL.md`](skills/devise/SKILL.md) ·
[`skills/implement/SKILL.md`](skills/implement/SKILL.md) ·
[`skills/verify/SKILL.md`](skills/verify/SKILL.md) ·
[`skills/deliver/SKILL.md`](skills/deliver/SKILL.md) ·
[`skills/distill/SKILL.md`](skills/distill/SKILL.md)

A seventh shipped Skill sits outside the lifecycle:
[`skills/brief/SKILL.md`](skills/brief/SKILL.md) — not a stage but a standing procedure, summoned
whenever the HC asks where something stands (the project, an epic, an issue, or a PR). Read-only by
charter; its formats are the bundled [`skills/brief/formats.md`](skills/brief/formats.md). The same
contract-file rule applies.

[`AGENTS.md`](AGENTS.md) is the contractor-reviewer contract — the file a summoned reviewer reads.
It is not this file's instruction source.

## Rules

None yet, deliberately. Under deuce a host's rules are born empty and grow one at a time on this
repository's own receipts; the ace-vendored set left with the cutover
(deuce [#86](https://github.com/wrburgess/deuce/issues/86)). The findings log
([`docs/findings.md`](docs/findings.md)) is where the receipts accumulate — its discipline is
declared in [`PROJECT.md`](PROJECT.md) → *Findings-Log Discipline*.

## The product

nadal is the tennis-team operations CLI, `tn`. Start at
[`ARCHITECTURE.md`](ARCHITECTURE.md); the operating procedures live in
[`docs/runbooks/`](docs/runbooks/), the CLI grammar at [`docs/cli/`](docs/cli/), and this host's
own decision records at [`docs/adr/nadal/`](docs/adr/nadal/).

## Settings & hooks

`.claude/settings.json` wires two PreToolUse fast-fails —
[`enforce-branch-creation.sh`](.claude/hooks/enforce-branch-creation.sh) and
[`enforce-clean-tree.sh`](.claude/hooks/enforce-clean-tree.sh) — per-tool accelerators over the git
hooks in `.githooks/`. Activate everything on a fresh clone with `bin/setup`.
