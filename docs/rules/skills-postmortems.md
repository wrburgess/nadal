# Skills — Postmortems (Tier 2)

Deferred deep doc for the Tier-1 rule [`rules/skills.md`](../../rules/skills.md). Heavy,
subsystem-specific case studies for authoring Skill bodies + Invocation Shims — **not** auto-loaded;
read on demand when the trigger in [`docs/rules/README.md`](README.md) fires (working in `skills/` or
`.claude/commands/`). Each entry ends with a `(Reference: #NNNN)` pointer to the issue/PR that
produced it.

## A scoped invocation must not advance a shared progress marker (Reference: #46)

**The case.** `scout` runs an intake **sweep** and records a **last-swept marker** — a high-water
mark that defines the next run's incremental window. Issue #46 added the `clip` front door, which
invokes `scout` in a new **inbox-only / specific-drop scope**: it processes only the handed-over drop
and skips the Watchlist feed/handle sweep entirely.

**What nearly shipped.** The scope change correctly guarded the *procedure* steps (skip the feed poll,
don't advance the marker, surface no feed-staleness) — but `scout`'s `<quality-gate>` still carried
the pre-existing invariant *"for a non-empty sweep, the last-swept marker was advanced, the staleness
notes are in the PR body."* An inbox-only run whose drop earns a stance **is** a non-empty sweep (it
opens a PR), so an agent reconciling against that checklist would advance the marker to today —
recording a feed window it never swept. The next full sweep would then treat everything up to that
date as already covered and **skip it silently**. An adversarial review pass caught the contradiction
before merge; the fix (PR #49) carved the marker/staleness invariants by mode in both the steps *and*
the gate.

**The rule it yields.** When a sweep/scan-style skill gains a **scoped or partial** invocation mode,
every piece of **shared progress state** it can advance — a recency/last-swept marker, a cursor, a
high-water mark, a dedupe cache — must be gated on the **full-scope** path. A partial run records only
the progress it actually made, never progress it skipped. And the audit is not just the numbered
steps: **the quality-gate / self-review checklist carries the same invariant**, and it is exactly
where a stale "always advance" assertion hides — it reads as a completion requirement an agent will
satisfy literally.

**Symptom to watch for.** A later full run that "finds nothing new" in a window you know had output —
the marker was advanced by a run that never covered that window.

_(Reference: #46; fix in PR #49.)_

## A host value's default must be resident in every body that reads it (Reference: #94)

**The case.** Issue #94 moved the lifecycle's human-gate policy out of fixed prose and into
`PROJECT.md` as a host value, so a Host App could declare a different policy without forking vendored
files. The obvious implementation is the idiom the Skills already use everywhere: delete the hardcoded
statement and replace it with *"read the gate policy from [`PROJECT.md`](../../PROJECT.md) →
*Human Gates*."*

**What that would have shipped.** The Rules Layer already warns that Copilot does not follow external
links, so a load-bearing instruction relocated behind a pointer is lost to it (the Tier-1
anti-pattern). Gate policy **is** load-bearing — it decides whether an agent may write code without a
human's approval. A pointer-only body therefore ships a link-averse tool no policy at all, and it
fails *open*: the reader is left to infer a default for the one value the change existed to declare.
The trap is that this reads as *more* correct than the alternative, because "never hardcode a host
value" is itself a standing rule — the two rules pull against each other, and the resolution is not
obvious until the failure mode is named.

The resolution adopted: state the shipped default **inline** in every body that reads the value —
*"plan approval is `auto`; a Host App may set it back to `required` in `PROJECT.md` → Human Gates"* —
making the Project Config the **override** rather than the sole source. Prose stays generic (no host's
setting is baked in) while remaining legible to a tool that reads only the file in front of it.

**Why a check does not save you here.** The same PR added a parity assertion that each gate-aware body
names *Human Gates*. That catches a body which forgot the value entirely; it cannot distinguish a
resident default from a bare pointer, because both contain the string. This is the structural-check
boundary ([ADR 0008](../adr/0008-structural-parity-check-not-model-in-the-loop.md)): the gate proves a
reference exists, never that the instruction survives without following it. Treat a pointer-only body
as a **High** review finding rather than a style note — it is a silent policy outage on one harness,
invisible to CI and to any reviewer reading with links available.

**The rule it yields.** Splitting a value into a declaration and a default is a **two-part** job.
Wherever a host value carries a safe default, that default is resident text in every body that reads
it, and the Project Config supplies only the deviation. Ask of each edited body: *if the reader
cannot open `PROJECT.md`, do they still know what to do?* If the answer is no, the instruction moved
when only the value should have.

**Symptom to watch for.** One harness behaving as though a policy does not exist while the others honor
it — and every structural check green, because the pointer is present on all of them.

_(Reference: #94; resolution in PR #102.)_
