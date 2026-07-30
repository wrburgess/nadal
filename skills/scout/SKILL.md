---
name: scout
description: Sweep the intake Watchlist for new field output, draft dated Learnings-Log entries that each carry a stance and a touches target, then — on an interactive run — walk them one finding at a time for a human to accept, edit, or reject before opening the PR (a scheduled run opens the PR for asynchronous disposition). Use to keep the Config Bundle's guidance current against how AI-assisted engineering is evolving.
---

<what-to-do>

Run one **intake sweep**: read the [Watchlist](../../CONTEXT.md), find what each tracked source has
published since the last sweep (plus any items a human left in the **manual-drop inbox**), and draft
**Learnings-Log** entries that compare each finding against how *this* Config Bundle already works —
then open a pull request of those drafts for a human to accept, edit, or reject. This is the mechanism of the [Intake Pipeline](../../CONTEXT.md); `scout`
**proposes**, a human **disposes**.

The sweep runs the **same discovery-and-drafting procedure** whether a person invokes it by hand or a
schedule fires it — there is no fast path and no tool-specific quality drift. The one place interactive
and scheduled runs legitimately differ is **disposition** (step 7): an interactive run walks each
finding one at a time; a scheduled/headless run opens the PR for asynchronous disposition — the terminal
artifact (a review PR) and the quality bar are identical either way. How a schedule is wired — the
cadence, and how to enable or disable it — is host-configured; the intake-sweep scheduling guide
(`docs/guides/intake-sweep-scheduling.md`) documents both.

Read host-specific values from [`PROJECT.md`](../../PROJECT.md): the **intake artifact locations**
(Watchlist, Learnings Log, last-swept marker) from *Intake Pipeline*, the branch/PR/issue-linking
policy from *Branch & PR Policy*, and the attribution/model from *Attribution & Model Declaration*.
Never hardcode a path, a branch name, or a platform verb here — the body stays business-neutral and a
Host App repoints its intake artifacts in Project Config, not in this skill.

**Terminal artifact: an open PR** appending the drafted entries to the current-quarter Learnings Log.
`scout` never commits directly to a protected branch — a reviewable PR is the only output.

</what-to-do>

<procedure>

**Scope — two invocation modes.** Most runs are a **full sweep**; a hand-off from the front door is
an **inbox-only** run:

- **Full sweep (default — manual or scheduled).** Everything below applies: sweep the Watchlist
  feeds/handles **and** the manual-drop inbox, and advance the last-swept marker. This is the mode a
  person or a schedule invokes with no specific item in mind.
- **Inbox-only / specific-drop.** When the [`clip`](../clip/SKILL.md) front door hands off a single
  item (or a run is otherwise scoped to the inbox), process **only** the manual-drop inbox — the
  handed-over drop. In this mode: **(a)** skip the Watchlist feed/handle sweep entirely (step 3's
  feed poll and step 4's search); **(b)** do **not** advance the last-swept marker (step 8) — no feed
  window was swept, and advancing it would make a later full sweep skip everything up to today; and
  **(c)** do **not** surface feed-staleness for un-swept sources (step 9) — only the inbox item is in
  scope. Steps 5–6 (draft + the one hard rule), the interactive disposition (step 7), and step 10 (open
  the PR) apply unchanged, scoped to the drop.

1. **Resolve the intake locations from Project Config.** Read [`PROJECT.md`](../../PROJECT.md) →
   *Intake Pipeline* for the Watchlist path, the Learnings-Log directory + index, the last-swept
   marker, and the manual-drop inbox. Everything below refers to those by role, never by a hardcoded path.

2. **Read the last-swept marker** — the date the previous sweep recorded in the Learnings-Log index.
   It defines the **incremental window**: this run only looks for output published *after* it. A
   missing or seed marker means "first sweep — take the recent window your judgment supports," not
   "read everything ever."

3. **Load the Watchlist and pick the sources to sweep.** *(Skipped in an inbox-only run — go to the
   inbox in step 4.)* For each entry, honor its fields:
   - Skip `dormant` sources; include `active` and `in-flux`.
   - Let `cadence` set expectations — a `high`-cadence source likely has new output every sweep; a
     `low`-cadence one often has none, and that is a valid result, not a miss.

4. **Find output published since the last sweep — never invent a source.** *(In an inbox-only run,
   skip the feed/handle sweep in the first two bullets and process only the manual-drop inbox.)*
   - When the entry has resolved `feeds`, poll them for items newer than the window.
   - When `feeds` is empty (`[]` — unresolved), fall back to `WebSearch` / `WebFetch` against the
     source's `handles` (site, and named accounts) to find genuinely new, dated output.
   - **Also read the manual-drop inbox.** Each drop is a human-curated pointer to output the automated
     sweep can't reach on its own (X, paywalled, feed-less). Treat every drop as a first-class
     candidate: fetch or read its `url` and carry it into step 5 exactly like a feed item. A drop is
     *raw input* — it carries no `stance`, and assigning its `stance` and `touches` is your job, not the
     dropper's.
   - **No URL is ever fabricated.** If a source has no resolvable new output, it contributes nothing,
     and an unresolved feed is reported as *staleness to surface* (see step 9), never papered over
     with a placeholder.

5. **Draft a Learnings-Log entry for each genuine finding — stance and touches are required.** Follow
   the Learnings Log's entry schema (resolved from Project Config). Every entry carries, at minimum:
   - `date`, and a `source` with a real `link` (never invented) and its `medium`;
   - a one-line `claim`;
   - a **`stance`** — `confirms`, `challenges`, `extends`, or `orthogonal` **relative to how this repo
     already works**;
   - a **`touches`** target — the artifact the learning bears on (a rule, a skill, an ADR, or `none`);
   - a `status` of `noted` (the sweep only proposes; disposition is the human's).

   The body of each entry is the compare/contrast prose: *why* that stance, and what — if anything —
   should change in the `touches` target.

6. **Apply the one hard rule: a stance-less finding is noise, not a learning.** If you cannot state
   whether a finding *confirms*, *challenges*, *extends*, or is *orthogonal* to this repo, **drop it**.
   That single discipline is what keeps the log from decaying into a dead-link dump. Better an empty
   sweep than a stance-less entry.

   **Empty sweep → no PR, log-only.** If **no** entry survives this rule — every source produced
   nothing new in the window, or nothing new could state a stance — the sweep is *empty*: open **no**
   pull request and **do not** advance the last-swept marker. Record that the sweep ran and found
   nothing (a scheduled session simply logs "swept, nothing new" and exits clean) and leave the window
   intact so the next run re-scans it. An empty sweep is a valid, expected result — not a failure, and
   never a reason to open an empty PR or to invent a finding to justify one. Steps 7–10 below apply
   **only when at least one entry survived.**

7. **Dispose interactively — one finding at a time.** When a human is present (an interactive
   invocation), do **not** hand the drafts over as a bulk list. Walk the surviving findings **one at a
   time**: for each, present its `claim`, `stance`, `touches`, and a **recommended disposition** (accept
   as drafted / edit / drop) with a one-line rationale, then **wait for the human's accept, edit, or
   reject before presenting the next** — the same one-at-a-time discipline
   [`distill`](../distill/SKILL.md) uses for questions. Apply each decision as it is
   made: an accepted entry stands, an edited one is revised in place, a rejected one is dropped and
   never appended. This step runs **only when at least one entry survived step 6** — an empty sweep has
   nothing to walk. A single-finding run (a [`clip`](../clip/SKILL.md) hand-off) walks that one finding,
   then continues to the PR, so the degenerate case feels identical.

   *Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)):*
   the one-at-a-time walk is the **interactive enhancement**, not a new gate. A **scheduled/headless**
   sweep (no human to answer) and any **tool without an interactive-question mechanism** skip the walk,
   append every surviving draft, and open the PR for **asynchronous disposition** — the reviewable PR is
   the floor and the terminal artifact either way. The disposition *mechanism* degrades; the
   human-disposes gate never does.

8. **Append the surviving entries to the current-quarter Learnings Log.** Add one file per entry under the log's
   entries directory (dated, per the schema's naming), add its row to the recency-first index, and —
   **on a full sweep** — **update the last-swept marker to today** so the next run is incremental and
   any staleness is visible (in an inbox-only run **leave the marker untouched**: no feed window was
   swept). Recency is stamped, never assumed. **Clear each processed drop from the manual-drop inbox
   in this same PR** — a drop whose learning has been proposed has done its job and must not be swept
   again.

   **Then, when you are sweeping the config bundle itself, keep the link enumeration in step with the
   files you just added.** The structural check in `scripts/parity_check.rb` resolves links for an
   **explicit list** of the markdown files the bundle ships (`LINK_CHECKED`), and a drift guard in the
   bundle's own self-tests reds any PR that adds a shipped markdown file without listing it. So add
   every file you created — each new entry, plus any drop you deliberately left in the inbox per step 9
   — to that list **in this same PR**.

   **In a Host App, add nothing.** The distinction is *which repo you are in*, not where the artifacts
   live: the shipped *Intake Pipeline* defaults already point inside the enumerated tree
   (`docs/reference/` — the Watchlist, the Learnings Log and its index, the manual-drop inbox), so a
   default-configured host writes to enumerated locations too and would otherwise look like the first
   case. It isn't, for two reasons: the drift guard lives in the bundle's `test/` tree, which is never
   vendored, so nothing reds; and an edit to the host's vendored `scripts/parity_check.rb` is
   overwritten by the next update anyway. Tell the two apart by whether the repo ships the bundle's own
   self-tests. If a host *wants* its own entries link-checked, that is a deliberate local customization
   with a known per-update cost — not part of this sweep.

9. **Surface staleness.** *(Full sweep only — an inbox-only run swept no feeds, so it reports no
   feed-staleness; only the inbox item is in scope.)* In the PR description, note which sources had
   unresolved feeds (still `[]`), which produced nothing this window, and any handles whose `verified`
   date is aging — so the human sees the sweep's blind spots rather than a false "all clear." **Also
   flag any drop that could not
   earn a stance:** leave it in the manual-drop inbox (a human curated it — never silently discard) and
   name it here so the dropper can sharpen the context or remove it.

10. **Open the PR — never commit directly.** Create the feature branch per
   [`PROJECT.md`](../../PROJECT.md) → *Branch & PR Policy*, commit the new entries + index update with
   the attribution trailer from *Attribution & Model Declaration*, push, and open a pull request whose
   body lists each drafted entry (source, claim, stance, touches) plus the staleness notes (full
   sweep; an inbox-only run swept no feeds, so its PR body covers only the handed-over drop). Link the
   issue per the branch/PR policy. The PR is a **proposal**: the human accepts, edits, or rejects each
   entry before anything merges.

*Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)):*
the fetch-and-draft churn (steps 3–6) is output-heavy and **may be offloaded to a sub-agent** that
returns the drafted entries + staleness notes; the invoking context keeps the judgment (the stance
call, the one hard rule, the interactive disposition) and owns the lifecycle-host I/O (commit, push,
open PR). On a tool without
sub-agents, run every step inline. The mechanism degrades; the procedure, the stance discipline, and
the human-disposes gate never do.

</procedure>

<quality-gate>

Before opening the PR: every drafted entry carries a real `source.link` (no invented URL), a
**`stance`**, and a **`touches`** target, and no stance-less entry survived. Whenever at least one
entry survives, the output is a reviewable PR, **never a direct commit** to a protected branch. When
the sweep ran against **the config bundle itself** (the repo that ships this Skill's self-tests), every
file it added is also listed in `LINK_CHECKED` (`scripts/parity_check.rb`) in the same PR (step 8) —
otherwise the drift guard reds the PR you just opened, so verify before pushing rather than after CI
says so; in a Host App this does not apply. The
marker and staleness invariants depend on the invocation mode (steps 8–9):

- **Full sweep** — the last-swept marker was advanced to today and the staleness notes are in the PR
  body.
- **Inbox-only / specific-drop** — the last-swept marker is **left untouched** (no feed window was
  swept; advancing it would make a later full sweep skip everything up to today) and **no
  feed-staleness notes** are produced (only the handed-over drop was in scope). A surviving inbox-only
  drop still opens a PR — do **not** advance the marker to satisfy this gate.

On an **empty sweep** — no entry survives the stance rule — the correct output is **no PR and an
unadvanced marker** (a log-only result), never an empty PR. Sign the PR and any lifecycle-host comment
with the footer from [`PROJECT.md`](../../PROJECT.md) → *Attribution & Model Declaration*, using your
runtime-actual model.

**The gate that never degrades:** the sweep proposes and a human disposes — **one finding at a time when
a human is present** (step 7), on the PR otherwise. `scout` does not decide what counts as a durable
learning — it drafts, stamps recency, and hands a person the findings to judge.

</quality-gate>
