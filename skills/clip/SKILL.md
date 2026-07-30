---
name: clip
description: Capture field output a human hands you in any session — a screenshot, a link, or a quote — enforce a real-URL gate, write a well-formed stance-less drop into the manual-drop inbox, then delegate to scout to draft the Learnings-Log entry and open the review PR. Use as the intake pipeline's push front door when a person wants a specific item ingested now, rather than waiting for the next sweep.
---

<what-to-do>

Turn one piece of **human-handed field output** — a screenshot, a link, or a pasted quote — into a
reviewable intake proposal. `clip` is the intake pipeline's **push front door**: where
[`scout`](../scout/SKILL.md) is the **pull** sweep that goes looking for new output on a schedule,
`clip` is the **push** lane a person reaches for the moment they have something specific in hand and
want it ingested now. It captures the item, enforces a hard **real-URL gate**, writes a well-formed
**stance-less** drop into the **manual-drop inbox**, then **delegates the rest of the pipeline to
`scout`** — the compare/contrast, the drafted Learnings-Log entry (its `stance` and `touches`), the
clearing of the processed drop, and the review PR. One invocation → a reviewable
PR is the **happy path**; a human **disposes** exactly as with any sweep finding — on the single
finding interactively when a human is present, otherwise on the PR.

`clip` **adds no ingestion procedure of its own**. The compare/contrast, the stance call, the
drop-clear, and the PR all live once in `scout`'s canonical body, which `clip` references and never
restates. What `clip` owns is the front door: the capture, the URL gate, the well-formed drop, and
the hand-off.

Read host-specific values from [`PROJECT.md`](../../PROJECT.md): the **manual-drop inbox** location
from *Intake Pipeline*, the branch/PR/issue-linking policy from *Branch & PR Policy*, and the
attribution/model from *Attribution & Model Declaration*. Never hardcode a path, a branch name, or a
platform verb here — the body stays business-neutral and a Host App repoints its intake artifacts in
Project Config, not in this skill.

**Terminal artifact: `scout`'s reviewable PR** proposing the drafted Learnings-Log entry. For an item
that genuinely cannot earn a stance, the terminal artifact is instead the **drop left in the inbox
plus a report** — no PR, no invented stance.

</what-to-do>

<procedure>

1. **Capture what the human handed over.** Read the item into three facts — its `source` (who
   published it), its `claim` (what it asserts, in one line), and its `medium` (post, video, blog,
   paper, …):
   - **A screenshot** — extract those facts from the image, and find the item's real permalink.
   - **A link** — you already have the URL; read the target for the source/claim/medium. If the target
     is one you cannot fetch — an X post, a paywalled or feed-less page — that does **not** void the
     drop: take the `source`, `claim`, and `medium` from what the human supplied alongside the link.
     This is the manual-drop inbox's whole reason to exist
     ([ADR 0014](../../docs/adr/0014-manual-drop-inbox-for-unfetchable-sources.md)): a real human-curated
     pointer to output the automated sweep can't reach on its own.
   - **A quote** — take the claim from the text and ask who said it and where (the URL).

   *Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)):*
   a tool that cannot read an image asks the human to paste the text **and the URL** instead; a tool
   that cannot fetch a real human-supplied link takes the `source`/`claim`/`medium` from what the human
   provided (above) rather than blocking on the fetch. The capture mechanism degrades; the procedure and
   the URL gate in step 2 never do.

2. **Enforce the real-URL gate (HARD RULE).** A drop needs a **real permalink** to the item itself —
   one a human could open. The gate is *reality*, not the agent's own reach: a **real but
   unfetchable** human-supplied URL (an X post, a paywalled or feed-less page) **passes** — that is
   exactly the unreachable-by-sweep output the manual-drop inbox exists to carry. What fails is an
   **absent or fake** URL — a screenshot of a post with no link, a quote with no attribution: **ask the
   human for the permalink**. Never fudge to a profile/handle/home-page URL, and never invent one. This
   is the same "never invent a URL" discipline the Watchlist, the Learnings Log, and the manual-drop
   inbox already state — honor it here; it is not re-argued. Without a real permalink there is no drop:
   stop and ask.

3. **Write the drop into the manual-drop inbox.** Resolve the inbox location from
   [`PROJECT.md`](../../PROJECT.md) → *Intake Pipeline* (never a hardcoded path) and follow the inbox's
   own drop schema (its README / template): one `YYYY-MM-DD-slug.md` file with a small YAML
   front-matter block carrying the required real `url`, the recommended `source` and `medium`, an
   optional `dropped` date, plus one line of context — why it caught the human's eye, or what in this
   repo to weigh it against. **The drop carries no `stance`**
   ([ADR 0014](../../docs/adr/0014-manual-drop-inbox-for-unfetchable-sources.md)): a drop is *raw
   input*, and assigning its `stance` and `touches` is `scout`'s job, not the front door's.

4. **Delegate to `scout` to finish the pipeline on this drop.** Hand off to
   [`scout`](../scout/SKILL.md) and follow its canonical body — do **not** restate its
   compare/contrast, drafting, drop-clear, or PR steps here. Invoke `scout` in its **inbox-only /
   specific-drop scope** (defined in `scout`'s body) so a full Watchlist sweep does not ride along:
   scoped that way, `scout` drafts the Learnings-Log entry (its `stance` and `touches`), clears the
   processed drop from the inbox, and opens the review PR — all scoped to this one handed-over item.

5. **Honor the stance-less outcome.** If `scout` genuinely cannot state whether the item *confirms /
   challenges / extends / is orthogonal* to how this repo already works, it does **not** invent a
   stance. It leaves the drop in the inbox and reports back — **no PR** — per `scout`'s empty-sweep
   rule ([ADR 0013](../../docs/adr/0013-scheduled-intake-sweep-and-empty-sweep-policy.md)) and the
   inbox lifecycle. "One invocation → a PR" is the happy path for a deliberately-handed item, **not**
   an override of the stance discipline; that rule is referenced, not restated. Surface the report to
   the human so they can sharpen the context, drop a better link, or let it go.

*Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)):*
on a tool with sub-agents, step 4's fetch-and-draft churn may be offloaded exactly as `scout`
documents; on a tool without them, run `scout`'s body **inline**, scoped to this inbox drop. The
mechanism degrades; the URL gate, the stance discipline, and the human-disposes gate never do.

</procedure>

<quality-gate>

Before handing off — and before the run is complete: the drop carries a **real `url`** (no fabricated
link, no profile/home-page substitution — if none was available, the human was asked); the drop is
**schema-valid and stance-less**; and the delegated `scout` run was **scoped to the inbox drop**, not
a full Watchlist sweep. The output is `scout`'s **reviewable PR** proposing the drafted entry — or, for
an item that cannot earn a stance, the **reported no-PR outcome** with the drop left in the inbox —
**never a direct commit** to a protected branch. Sign any lifecycle-host comment with the footer from
[`PROJECT.md`](../../PROJECT.md) → *Attribution & Model Declaration*, using your runtime-actual model.

**The gate that never degrades:** `clip` **proposes** — it captures, gates the URL, and hands `scout`
a clean drop; a **human disposes** — on the single finding interactively when present, otherwise on the
PR. The front door never accepts a learning on its own.

</quality-gate>
