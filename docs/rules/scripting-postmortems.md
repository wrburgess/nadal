# Scripting — Postmortems (Tier 2)

Deferred deep doc for the Tier-1 rule [`rules/scripting.md`](../../rules/scripting.md). Heavy,
subsystem-specific case studies for bundled and CLI scripts — **not** auto-loaded; read on demand when
the trigger in [`docs/rules/README.md`](README.md) fires (working in `scripts/` or `bin/`). Each entry
ends with a `(Reference: #NNNN)` pointer to the issue/PR that produced it.

## A mirrored script must mirror the invariant, not just the shape (Reference: #94)

**The case.** Issue #94 made the lifecycle's human-gate policy a Project Config value. The new parser
`scripts/human_gates.rb` was authored — deliberately, and said so in its own comments and in the PR —
as a mirror of `scripts/protected_branches.rb`, the repo's one proven pattern for a machine-read host
value. Both scan `PROJECT.md` from an `## ` heading, stop at the next `## `, and pull a backticked
token out of the matching line.

**What nearly shipped.** The mirroring copied the *shape* — the heading scan, the next-H2 cutoff, the
backtick extraction — but not the control flow. `protected_branches.rb` **`break`s on its first
match**; the new extractor never broke, so its `gates[key] = value` assignment kept reassigning and
became **last-match-wins**. A second table row labelled for the same gate therefore overrode the
authored one.

That is not a hypothetical. `PROJECT.md`'s own prose style leans on illustrative tables, so a host
documenting its options inline — *"an overnight autonomous track would declare: `| **Plan approval** |
`auto` |`"* — silently flipped the real setting from `required` to `auto` while
`ruby scripts/parity_check.rb` exited **0** with `OK`. The failure ran in the **unsafe direction**: a
host that had authored the strict value got the permissive one, which is precisely the direction the
design's stated fail-safe property claimed was impossible. A related positional bug rode along — the
value was read from a fixed column index, so merely reordering the table's columns yielded the wrong
cell.

An adversarial verify pass caught both before merge by attacking the parser with malformed input
rather than confirming the happy path; the fix restored first-match-wins and located the value column
by its header cell.

**The rule it yields.** A script advertised as "modeled on" a sibling inherits the reader's trust in
that sibling's hard-won edge-case handling — and reviewers grant that trust on the strength of the
resemblance. So the resemblance must be earned at the level of **invariants**, not structure. Diff the
two control flows and name what each one protects: *first*-match-wins and *last*-match-wins are
different contracts, and the whole difference can live in one `break`. Where the two diverge,
either restore the sibling's behavior or state plainly that this script's contract differs and why.

Two corollaries worth generalizing beyond this instance:

- **Grade a parser bug by its direction.** One that resolves to the more permissive, less safe value
  is a defect even when every check is green; one that fails toward the restrictive default is a
  robustness gap. Reason about *both* directions explicitly — the design note here argued only the
  safe direction and therefore never noticed the unsafe one was reachable.
- **Read positionally only when the position is a contract.** Locate a value by a stable label (a
  header cell, a key) where you can; a bare index silently returns the wrong thing the first time
  someone rearranges the authored source, and no test that only ever writes the canonical layout will
  catch it.

**Symptom to watch for.** A host insisting a setting is authored one way while the tooling behaves the
other — with the gate green, because a structural check asserts the parse *ran*, never that it chose
the right occurrence.

_(Reference: #94; parser and fix in PR #102.)_
