---
date: 2026-07-28
source:
  person: Thariq Shihipar (Anthropic)
  link: https://x.com/trq212/article/2080710971228918066
  medium: post
claim: >
  Anthropic removed over 80% of Claude Code's system prompt for the Claude 5 generation with no
  measurable loss on coding evals; for these models, prescriptive rules should give way to judgment,
  examples to expressive interface design, and upfront information to progressive disclosure —
  keep instruction files light and spend the tokens on gotchas.
stance: extends
touches: ADR-0004
status: noted
---

## Compare / contrast

X Article by Thariq Shihipar (member of technical staff, Anthropic), published 2026-07-24 alongside the
Claude 5 launch; mirrored on the Claude blog as
[The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models).
Manual drop (X is unfetchable by the sweep); the blog mirror supplied the full text. The headline fact:
Anthropic cut **over 80% of Claude Code's system prompt** for models like Opus 5 and Fable 5 "with no
measurable loss on our coding evaluations."

The six **then → now** pairs:

- **Rules → judgment.** Then: `"default to writing no comments. Never write multi-paragraph docstrings."`
  Now: `"Write code that reads like the surrounding code: match its comment density, naming, and idiom."`
  Rationale: "newer models have better judgement and can handle these decisions well without explicit rules."
- **Examples → interface design.** Examples "constrain them to a certain exploration space"; invest instead
  in "the design of your tools, scripts and files — what parameters does Claude have and how can they be
  more expressive?"
- **Upfront info → progressive disclosure.** Load "the right context at the right times" via skills and
  deferred tool loading.
- **Repetition → clear descriptions.** Put the instruction "in the tool descriptions rather than the
  system prompt," once.
- **Manual → automatic memory**, and **simple specs → rich references** (`@mention` files; "prefer files
  that are in code as it provides clear, high-fidelity instructions").
- **Applying it:** keep `CLAUDE.md` "lightweight… but spend most of the tokens on gotchas inside of the
  codebase"; treat skills as "lightweight guides… avoid making them overconstrained, except in highly
  important areas"; split a lengthy skill "into many files." A new `claude doctor` rightsizes skills and
  `CLAUDE.md` files.

Most of this is **first-party confirmation of the architecture already here**: two-tier progressive
context ([ADR 0004](../../../adr/0004-two-tier-rules-layer-progressive-context.md)), a canonical body
reached through thin shims with deferred deep docs ([ADR 0003](../../../adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)),
*reference-don't-restate* in `rules/skills.md`, and the combined-payload line allowance
([ADR 0022](../../../adr/0022-instruction-file-line-allowance.md)) are the same moves under different names.
"Split a lengthy skill into many files" is what `scout` and `restock` already do with sub-files.

What is genuinely **new** lands on the **Rules Layer's own convention**, which is why this `touches`
[ADR 0004](../../../adr/0004-two-tier-rules-layer-progressive-context.md) rather than any single rule
file. ADR 0004 makes an **Anti-Patterns section required** in every Tier-1 rule — `rules/skills.md`
alone ships seven `Never …` clauses, and every other Lean Core file carries its own. The article's
exception protects most of them: the strongest ones cite a real, reproduced failure (the partial-run
high-water bug, the Copilot-doesn't-follow-links loss, the fails-open default) and are exactly the
"specific, demonstrable failure mode the model can't reason its way out of" that still warrants a hard
rule. But a *required* section is a one-way ratchet — it creates supply pressure for prohibitions and
no step that retires one. A rule a Claude 5 model would have gotten right on judgment alone is never
removed, because nothing in the two-tier design asks the question. That is the gap the article extends
into: not the rules themselves, but the missing **prune with a demonstrable-failure-mode test** —
the always-resident tier is precisely where dead prescription is most expensive.

Second-order: "put the instruction in the tool description, not the system prompt" is the same
single-source discipline as *reference-don't-restate*, but applied to **placement** — an argument for
keeping guidance in the `SKILL.md` that needs it rather than lifting it into `AGENTS.md`, which the
line-allowance work (ADR 0022) already pushes toward for a different reason (Copilot's link blindness
pushes the other way — a live tension, not a settled one).

## Disposition

`noted` — candidate actions, for a human to pick: (1) revisit
[ADR 0004](../../../adr/0004-two-tier-rules-layer-progressive-context.md)'s **required** Anti-Patterns
section — either keep it required or relax it to "required when a demonstrable failure mode exists," a
decision that belongs in a superseding/amending ADR, not a rule edit; (2) add a **rightsizing / prune**
step to the rule-authoring convention (and mirror it in `rules/skills.md`): every `Never …` names the
failure it prevents, and one that cannot is deleted rather than kept "just in case"; (3) evaluate
`claude doctor` as a periodic check on the combined `AGENTS.md`/`CLAUDE.md` payload and the skill
bodies, adjacent to `restock`'s refresh cadence. Note the counter-pressure before acting: several
anti-patterns here exist because an agent *did* fail, and the article explicitly keeps those.
