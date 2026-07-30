---
name: follow
description: Turn a bare handle or a link into the correct add-or-update on the Watchlist roster — normalize the input, dedup against the existing entries before proposing anything, assemble a schema-valid entry that honors the real-URL discipline, keep the roster's prose companion in parity, and open a review PR. Use as the intake pipeline's roster front door when a person wants someone put on — or refreshed on — the Watchlist, rather than feeding the Learnings Log.
---

<what-to-do>

Turn one **handle or link a human hands you** — an at-handle, a profile URL, a site, a channel, a
code-forge or newsletter link — into the correct, deterministic action on the **Watchlist roster**:
**add a new voice, or update the existing one.** `follow` is the intake pipeline's **roster front
door**. Where [`clip`](../clip/SKILL.md) (push) and [`scout`](../scout/SKILL.md) (pull) feed the
**Learnings Log** — *field output*, each earning a `stance` — `follow` maintains **who the sweep
watches**: the roster itself. That is a different artifact, with a different schema, and **no
`stance`**. Its defining move is **dedup-first**: resolve the input against the entries that already
exist *before* proposing anything, so an account already tracked yields an **update**, never a
duplicate.

`follow` **adds no learnings-intake procedure of its own** and never touches the Learnings Log or the
manual-drop inbox — those live once in `scout`'s and `clip`'s bodies, which `follow` neither restates
nor invokes. What `follow` owns is the roster front door: read the input, normalize it, dedup, assemble
a schema-valid add-or-update, keep the roster's prose companion in parity, and hand a human a
reviewable proposal.

Read host-specific values from [`PROJECT.md`](../../PROJECT.md): the **Watchlist** location (and its
prose companion) from *Intake Pipeline*, the branch/PR/issue-linking policy from *Branch & PR Policy*,
and the attribution/model from *Attribution & Model Declaration*. Never hardcode a path, a branch
name, a platform proper noun, or a stack command here — the body stays business-neutral, and a Host
App repoints its intake artifacts in Project Config, not in this skill.

**Terminal artifact: a reviewable PR** appending or updating the entry (and mirroring the prose
companion when a new name is added). For an input that is **already tracked with nothing to change**,
the terminal artifact is instead an **"already tracked" report** — no empty PR, no invented change.

</what-to-do>

<procedure>

1. **Read what the human handed over, then normalize it — before anything else.** The input is one of
   two shapes: a bare handle (an at-handle or a plain username) or a link (a profile, site, channel,
   code forge, or feed page). Reduce it to a **canonical form** so the dedup in step 3 can match it
   against however the roster already stores the same account: fold a platform's **equivalent/alternate
   domains** to one form, an **at-handle ↔ its full profile URL** to one form, and strip
   trailing-slash / case / `www.`-style subdomain variants. Deriving a profile URL from a handle the
   human actually gave you is **normalization, not invention** — step 2 governs what you may *not*
   conjure.

2. **Honor the real-URL discipline (HARD RULE).** Every handle you record and every feed you list must
   be a **real URL a human could open** — the same "never invent a URL" discipline the Watchlist, the
   Learnings Log, and the manual-drop inbox already state; it is honored here, not re-argued. A real
   but unfetchable page (a handle behind a login, a feed-less site) is fine to *record* when the human
   supplied it; what you must never do is **fabricate** a handle or a feed, or fudge an unknown to a
   plausible-looking guess. An unresolved handle stays **absent** (its schema null), an unresolved feed
   stays an **empty list** — never a placeholder string. If the input itself resolves to no real,
   openable account, stop and ask the human.

3. **Dedup-first — the load-bearing rule.** Resolve the normalized input against **every existing
   entry's handles** (not just names) before you propose. Two outcomes, and only these two:
   - **A match → propose an *update* to that one entry.** Refresh what the input justifies — bump the
     verified date, fill a previously-empty handle, adjust the focus/tier/cadence — and change nothing
     else. Never append a second entry for an account already on the roster.
   - **No match → propose a *new* entry.** Proceed to step 4.

   Uniqueness is **not** enforced by the roster's data test, so this dedup is the skill's
   responsibility, not a gate that will catch a slip downstream — do it here, deliberately.

4. **Assemble a schema-valid entry honoring the Watchlist's own contract.** Follow the **Watchlist's
   documented schema and invariants** (its header / the data test that guards it) rather than a set
   restated here — the schema is business-neutral mechanism that lives with the artifact, so deferring
   to it keeps this body from going stale when a field is added or renamed. Populate each field the
   header defines; resolve the *other* handles and any real feed from the one input **best-effort**,
   leaving each unresolved handle absent and each unresolved feed an empty list per step 2. Keep every
   enumerated field within its documented set, and stamp the entry's verification date as a **real
   date** (today's). Feeds are an optimization, not a requirement — an entry with no discoverable free
   feed legitimately keeps an empty feed list.

5. **Keep the roster's prose companion in parity — by construction.** The Watchlist has a human-readable
   companion kept in sync with it (a cross-file parity check asserts every roster entry appears there).
   A **new** name must therefore be mirrored into that companion **in the same PR**, under the matching
   section, so parity is green without a human hand-edit. An **update** that touches only machine fields
   (a verified date, a feed, a status) needs no prose change. Resolve both locations from
   [`PROJECT.md`](../../PROJECT.md) → *Intake Pipeline*; never hardcode them.

6. **Propose via PR — a human disposes.** Open the review PR per [`PROJECT.md`](../../PROJECT.md) →
   *Branch & PR Policy*, linking the issue if one drove the change; **never commit the roster edit
   directly.** If step 3 found a match and nothing about the input justifies a change, do **not** open
   an empty PR — report **"already tracked, nothing to change"** and surface the existing entry so the
   human can decide whether anything is stale.

*Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0005](../../docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)):* on a
tool with sub-agents, the handle/feed **discovery** in steps 1–4 may be offloaded and its findings
folded back in; on a tool without them, run the discovery **inline**. The mechanism degrades; the
normalization, the real-URL discipline, the dedup, and the human-disposes gate never do.

</procedure>

<quality-gate>

Before opening the PR — and before the run is complete: the input was **normalized** and **deduped
against existing handles**, so an already-tracked account produced an *update* (or an "already
tracked" report), **never a duplicate**; the proposed entry is **schema-valid and honors every
Watchlist invariant** — real-URL handles and feeds, no fabricated handle or feed, no placeholder
string, every enumerated field within its documented set, and a real verified date; the roster's
**prose companion is in parity** (a new name mirrored in the same PR); and the body named **no
hardcoded path or platform proper noun** — the Watchlist location came from `PROJECT.md`. The output
is a **reviewable PR** (or the reported "already tracked" outcome), **never a direct commit** to a
protected branch. Sign any lifecycle-host comment with the footer from [`PROJECT.md`](../../PROJECT.md)
→ *Attribution & Model Declaration*, using your runtime-actual model.

**The gate that never degrades:** `follow` **proposes** — it normalizes, dedups, and assembles a
schema-valid add-or-update; a **human disposes** on the PR. The roster front door never edits the
Watchlist on its own.

</quality-gate>
