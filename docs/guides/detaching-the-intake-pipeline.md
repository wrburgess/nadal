# Detaching the intake pipeline

The **Intake Pipeline** (see [`CONTEXT.md`](../../CONTEXT.md)) is the bundle's field-monitoring loop:
the [`scout`](../../skills/scout/SKILL.md) sweep, the [`clip`](../../skills/clip/SKILL.md) push front
door, the [`follow`](../../skills/follow/SKILL.md) roster front door, and the Watchlist / Learnings-Log
/ manual-drop-inbox artifacts they read and write
([ADR 0012](../adr/0012-intake-pipeline-placement.md),
[ADR 0015](../adr/0015-intake-front-door-drop-skill.md),
[ADR 0021](../adr/0021-voice-watchlist-front-door.md)).

Not every Host App wants it. A host that only needs the lifecycle skills and the Rules Layer can trim
it out — but the pipeline is **woven through the bundle**, not bolted on, so a partial trim leaves a
red parity check or, worse, a live command pointing at a file that no longer exists. This guide is the
manifest: every file the trim touches, the order the edits must land in, and the two traps that make a
"reasonable-looking" trim fail.

> **Scope.** This covers the intake pipeline only. The `restock` skill and the Tool Roster
> (`docs/reference/tool-roster.yml`) are a **sibling** subsystem, not part of intake
> ([ADR 0023](../adr/0023-tool-roster-facts-tracker-sibling-to-intake.md)) — leave them in place.

## Two trims, and they are not the same

This guide is vendored, so it is read in two different repos — and the manifest differs between them.
Work out which one you are in **before** you start, because several rows below apply to only one:

| | **Host-side trim** (a Host App with the bundle vendored) | **Bundle-side trim** (the config repo that ships the bundle) |
|---|---|---|
| Has `test/` | **No** — `ace-sync` never vendors it | Yes |
| Has the bundle's `README.md` | **No** — a host owns its own README; it is not in the installer's `ALLOW` | Yes |
| Gate to run | `ruby scripts/parity_check.rb` | the parity check **plus** the self-tests |
| The trim survives an update | **No** — see the warning below | Yes, it is the source |

Rows marked **(bundle-side only)** below touch files a Host App never receives. If you are trimming a
host, skip them — do not go looking for the file.

## Read this first — the next `ace-sync` puts all of it back

**A trim is not durable.** `bin/ace-sync` preserves exactly two paths in a Host App —
`PROJECT.md` and `bin/setup` — and overwrites everything else from the source bundle
([ADR 0001](../adr/0001-distribute-as-copy-in-sync-script.md)). So the next time the host updates:

- **Every deleted intake file comes back**, because the sync copies the bundle's tree in; a file the
  host removed is simply re-created.
- **Every trimmed file is overwritten** — the host's edited `AGENTS.md`, `CONTEXT.md`,
  `docs/guides/usage.md`, and `scripts/parity_check.rb` are replaced by the baseline's, losing the
  trim. (Your own `README.md` is safe: it is not in the installer's `ALLOW`, so the bundle neither
  ships nor overwrites it.)
- `PROJECT.md` **survives**, so a host that deleted its *Intake Pipeline* section keeps that deletion —
  which means after a re-sync the trim is in a **half-applied** state: the skills and artifacts are back,
  but the Project Config that points at them is not.

**The practical consequence:** the trim is a **per-update cost**, repeated by hand on every sync, and
the half-applied state above makes each repeat slightly different from the last. Budget for it, or
don't trim.

This is a real limitation of the current design, not an oversight in this guide — the guide documents a
coupling that has **no machine enforcement**, so it will drift as the bundle changes. The durable fix is
to extract intake into a separate, opt-in sidecar bundle so a host simply never vendors it, tracked as a
follow-up to issue #96. Until that lands, prefer **ignoring** the intake pipeline (it costs nothing at
rest — the skills are inert unless invoked) over trimming it.

## The trim manifest

### Group 1 — delete whole

| Path | What it is |
|---|---|
| `skills/scout/` · `skills/clip/` · `skills/follow/` | The three intake Skill bodies |
| `.claude/commands/scout.md` · `clip.md` · `follow.md` | Their Claude Invocation Shims (see the orphan-shim trap below) |
| `docs/reference/voices.yml` | The machine-readable Watchlist |
| `docs/reference/ai-engineering-voices.md` | The Watchlist's human-readable prose sibling |
| `docs/reference/learnings/` | The Learnings Log — schema, index, and all entries |
| `docs/reference/intake-inbox/` | The manual-drop inbox and its drop template |
| `docs/guides/intake-sweep-scheduling.md` | The sweep-scheduling guide |
| `test/voices_watchlist_test.rb` · `test/voices_roster_parity_test.rb` | The intake data-contract self-tests (bundle-only — `ace-sync` never vendors `test/`, so a Host App has nothing to delete here) |

**Keep the ADRs.** [ADR 0012](../adr/0012-intake-pipeline-placement.md),
[0013](../adr/0013-scheduled-intake-sweep-and-empty-sweep-policy.md),
[0014](../adr/0014-manual-drop-inbox-for-unfetchable-sources.md),
[0015](../adr/0015-intake-front-door-drop-skill.md),
[0016](../adr/0016-interactive-sequential-disposition-scout.md) and
[0021](../adr/0021-voice-watchlist-front-door.md) are **point-in-time records** — they document a
decision that was really made, so deleting them rewrites history. They stay, and their links into the
deleted tree become the largest part of Group 4.

### Group 2 — edit a section

| Path | Edit |
|---|---|
| `AGENTS.md` | Drop the `scout` / `clip` / `follow` rows from the *Skills* table |
| `CONTEXT.md` | Drop the **Intake Pipeline**, **Clip skill**, Watchlist, Learnings Log and Manual-drop-inbox glossary terms, and the intake bullet in *Relationships* |
| `PROJECT.md` | Delete the `## Intake Pipeline` section, and drop `scout` / `clip` / `follow` from the *Human Gates* "intake and authoring" bullet |
| `docs/guides/usage.md` | Drop the intake rows from the skills list and from the per-tool invocation table |
| `README.md` | **(bundle-side only)** Drop the intake section and the intake entries in the skills overview. A Host App's README is its own and is never vendored — nothing to do there |
| `scripts/parity_check.rb` | Remove `"scout"`, `"clip"`, `"follow"` from `REQUIRED_SKILLS`, and every deleted path from `LINK_CHECKED` — **including the three shim paths**, which are enumerated there too and are the easiest to overlook |
| `.github/workflows/parity.yml` | Remove the two intake self-test steps (Watchlist data-contract, roster parity) |
| `test/parity_check_test.rb` | **(bundle-side only)** Delete the three floor pins — `test_required_scout_skill_absent_fails`, `test_required_clip_skill_absent_fails`, and `test_required_follow_skill_absent_fails`. Each asserts the floor still contains a skill you just removed, so all three fail the moment `REQUIRED_SKILLS` is edited |
| `test/parity_check_test.rb` | **(bundle-side only)** Repoint `test_vendored_markdown_walk_reaches_every_docs_subtree`, which asserts a specific Learnings-Log entry path to prove the vendored-file walk recurses. Delete the log and it fails on a file that is *supposed* to be gone — pick any surviving deep path instead |

### Group 3 — decrement a count

The skill count is written as prose in exactly two places, and neither is machine-checked:

- `AGENTS.md` → *Skills*: "ships **thirteen Skills**"
- `docs/guides/usage.md` → §4: "ships **thirteen Skills**"

Removing three takes both to **ten**. `CLAUDE.md` carries **no** total count — do not go looking for
one there. The bundle's `README.md` carries no total count either, though it does enumerate skills by
group and needs those groups pruned **(bundle-side only** — a host never receives that file**)**.

### Group 4 — fix a link

This is the group a trim reliably misses: files that **survive** but link into the deleted tree. Each
one is a dead link, and each reddens the parity check the moment `check_links` runs. Known instances:

| Surviving file | Link that dies |
|---|---|
| `skills/distill/SKILL.md` | the Watchlist (`docs/reference/voices.yml`) — a *lifecycle-adjacent* skill body reaching into intake |
| `docs/adr/0020-right-size-plan-revisable-direction.md` | a Learnings-Log entry — a **non-intake** ADR citing intake evidence |
| `docs/reference/README.md` | the Watchlist, the Learnings Log, the inbox, and the voices prose doc |
| the kept intake ADRs (0012-0016, 0021) | the skill bodies and artifacts they decided on |

Treat this table as a **starting point, not an inventory** — it is prose with no enforcement behind it.
Re-derive the real list on your own tree before trusting it:

```sh
grep -rln 'skills/scout/\|skills/clip/\|skills/follow/\|voices\.yml\|learnings/\|intake-inbox/' \
  --include='*.md' .
```

## The ordering hazard: the trim cannot be staged

`check_skills` in `scripts/parity_check.rb` enforces two invariants that pull in opposite directions:

- every name in `REQUIRED_SKILLS` **must have a body** at `skills/<name>/SKILL.md`; and
- every **present** `skills/<name>/` directory **must be referenced by `AGENTS.md`**.

So each of the three "natural" first steps fails on its own:

| If you do only this first | The check says |
|---|---|
| Delete `skills/scout/` | `Required skill missing: skills/scout/SKILL.md` |
| Remove `scout` from `REQUIRED_SKILLS` | *(green, but the directory is still there — nothing is actually removed)* |
| Remove the `AGENTS.md` reference | `Skill scout is not referenced by AGENTS.md` |

Only the **simultaneous three-way edit** — delete the directory, drop it from `REQUIRED_SKILLS`, and
remove its `AGENTS.md` row, in one commit — is green. Plan the trim as a single atomic change per
skill; there is no green intermediate state to stop at, and no way to land it as a reviewable series.

## The orphan-shim trap

`present_skills` walks `skills/<name>/` **directories only** — nothing walks `.claude/commands/`. So a
deleted `skills/scout/` with `.claude/commands/scout.md` left behind leaves `/scout` a **live slash
command** pointing at a body that no longer exists, and the skill-shape checks say nothing: they only
ever ask questions about *present* skill directories.

What catches it today is the **link check**, not the skill check. Each shim is enumerated in
`LINK_CHECKED`, so its markdown link to the canonical body is resolved, and an orphaned shim reddens
with:

```
Dead link in .claude/commands/scout.md: `../../skills/scout/SKILL.md` does not resolve
```

**The residual gap:** that catch depends on the shim pointing at its body with a **markdown link**.
`check_skills` only requires the shim to *contain the substring* `skills/<name>/SKILL.md`, which a
backticked path satisfies just as well — and a backticked path is invisible to the link check. A shim
written that way would still orphan silently. So delete each shim in the same commit as its body rather
than relying on the check, and confirm nothing is left:

```sh
ls .claude/commands/
```

## Finish the trim

Run the *Quality Checks* from [`PROJECT.md`](../../PROJECT.md) and get them green. Which commands those
are depends on which trim you are doing.

**Host-side** — `test/` was never vendored, so the structural check is the whole gate (plus whatever
checks your own `PROJECT.md` declares):

```sh
ruby scripts/parity_check.rb
```

**Bundle-side** — the parity check *and* the self-tests, since the trim edits both the checker and the
tests that pin it:

```sh
ruby scripts/parity_check.rb
ruby test/parity_check_test.rb
ruby test/ace_sync_test.rb
```

`check_links` now scans every markdown file the bundle vendors — the shims included — so a Group-4 link
you missed, and an orphaned shim that still links its deleted body, both redden here by name rather than
shipping silently (issue #96). A green run is necessary but **not sufficient**: a shim that references
its body as a *backticked path* rather than a markdown link is invisible to the check, so do the `ls`
check by hand as well.
