# Learnings Log — index

Chronological (most recent first) index of intake findings. Each row links an entry under
[`entries/`](entries/); the schema and the one hard rule (a `stance`-less entry is invalid) live in
[`README.md`](README.md).

> **ILLUSTRATIVE REFERENCE — not part of the [Generic Baseline](../../../CONTEXT.md) guarantee.** The
> entries below are worked examples seeding the shape (issue #30); a Host App replaces or extends
> them. Placement: [ADR 0012](../../adr/0012-intake-pipeline-placement.md).

**Last swept:** 2026-07-07 _(three passes on 2026-07-07: (1) forward sweep, window 2026-06-23 →
2026-07-07, 13 entries; (2) three human drops via `/drop`; (3) backfill sweep, window 2026-04-23 →
2026-06-22, 11 entries (12 drafted, 1 dropped in sequential review). The marker tracks the forward
frontier and only advances inside a merged `scout` sweep PR; a backfill fills in older content without
moving the frontier. Scheduling the sweep
is covered in the [intake-sweep scheduling guide](../../guides/intake-sweep-scheduling.md).)_

| Date | Source | Claim | Stance | Touches | Status |
|------|--------|-------|--------|---------|--------|
| [2026-07-28](entries/2026-07-28-thariq-context-engineering-claude-5.md) | Thariq Shihipar (Anthropic) | >80% of Claude Code's system prompt removed for Claude 5 models with no eval loss; rules → judgment, examples → interface design, upfront info → progressive disclosure | extends | `ADR-0004` | noted |
| [2026-07-08](entries/2026-07-08-pocock-wayfinder-blocking-tickets.md) | Matt Pocock (AI Hero) | /wayfinder maps an oversized plan to session-sized GitHub issues with blocking edges; /to-tickets emits vertical-slice tickets with blocking edges (local file or native tracker) | extends | `docs/standards/development-lifecycle.md` | noted |
| [2026-07-08](entries/2026-07-08-pocock-grilling-fixes-backport.md) | Matt Pocock (AI Hero) | Grilling fixes to backport: confirmation gate before implementation, Facts-vs-Decisions leading words to stop self-grilling, sharper one-question-at-a-time rationale | extends | `skills/grill-with-docs` | noted |
| [2026-07-08](entries/2026-07-08-pocock-code-review-fowler-smells.md) | Matt Pocock (AI Hero) | /code-review names Martin Fowler's refactoring smells (cheap, leverages model priors) + two-axis (standards/spec) sub-agents; refactor moved out of the TDD loop into review | extends | `rules/self-review.md` | noted |
| [2026-07-07](entries/2026-07-07-karpathy-software-3-agent-native.md) | Andrej Karpathy | Agent-native infra (machine-readable schemas, CLIs) is the missing piece; automate what you can verify | confirms | `ADR-0002` | noted |
| [2026-07-07](entries/2026-07-07-eugene-yan-eval-design-pattern.md) | Eugene Yan | Agent evals share a four-primitive design + partial credit via subtasks | extends | `rules/testing.md` | noted |
| [2026-07-07](entries/2026-07-07-pocock-agent-read-authoring.md) | Matt Pocock (@mattpocockuk) | structure + leading words + pruning helps any agent-read text, not just writing | extends | `rules/skills.md` | noted |
| [2026-07-07](entries/2026-07-07-pocock-kill-context-bloat.md) | Matt Pocock | Measure unused tools via a logging proxy, then disable them to cut context bloat | extends | `ADR-0004` | noted |
| [2026-07-07](entries/2026-07-07-pocock-grill-with-docs.md) | Matt Pocock | Repo's `grill-with-docs` is copied from Pocock's upstream original — currently uncredited (attribution gap) | challenges | `skills/grill-with-docs` | actioned (#51) |
| [2026-07-07](entries/2026-07-07-pocock-skills-as-markdown-catalog.md) | Matt Pocock | Skills as focused markdown files (instructions + inputs + outputs) mapped to engineering moments | confirms | `rules/skills.md` | noted |
| [2026-07-07](entries/2026-07-07-willison-ai-review-caught-bugs.md) | Simon Willison | An AI-run code review caught critical bugs before a release shipped | confirms | `skills/verify` | noted |
| [2026-07-07](entries/2026-07-07-willison-better-models-worse-tools.md) | Simon Willison | Newer models are worse at custom third-party tools — tool-specific mechanisms are fragile across versions | confirms | `ADR-0003` | noted |
| [2026-07-07](entries/2026-07-07-thorsten-ball-agents-in-orbs.md) | Thorsten Ball | Ephemeral sandboxed agents reframed as async functions you queue and run in parallel | extends | `skills/ship` | noted |
| [2026-07-07](entries/2026-07-07-lilian-weng-harness-engineering.md) | Lilian Weng | The harness (orchestration layer around a model) is as important as raw model intelligence | confirms | `skills/ship` | noted |
| [2026-07-07](entries/2026-07-07-willison-fable-judgement-delegation.md) | Simon Willison | Delegate routine implementation to cheaper subagents; keep judgment in the premium main loop | confirms | `skills/ship` | noted |
| [2026-07-07](entries/2026-07-07-willison-dspy-agent-prompt-evals.md) | Simon Willison | Use DSPy with auto-generated gold datasets to evaluate and optimize agent system prompts | extends | `rules/testing.md` | noted |
| [2026-07-07](entries/2026-07-07-latent-space-against-one-shot-design.md) | Paul Bakaus (Latent Space) | Reject one-shot design; the agent does ~80%, the human applies taste for the final 20% | confirms | `rules/self-review.md` | noted |
| [2026-07-07](entries/2026-07-07-hamel-hard-to-eval-product-smell.md) | Hamel Husain | Hard-to-eval output is a product-design smell — redesign for verifiability | extends | `rules/testing.md` | noted |
| [2026-07-07](entries/2026-07-07-jason-liu-scheduled-work-kinds.md) | Jason Liu | Scheduled Tasks (fresh context each run) vs Scheduled Messages (persistent thread) | extends | `skills/scout` | noted |
| [2026-07-07](entries/2026-07-07-andrew-ng-loop-engineering.md) | Andrew Ng | "Loop engineering": three nested feedback loops with humans owning the higher-level ones | confirms | `docs/standards/development-lifecycle.md` | noted |
| [2026-07-07](entries/2026-07-07-anthropic-steering-claude-code.md) | Anthropic | First-party breakdown of Claude Code primitives (rules, skills, subagents, hooks) — the exact set the repo builds on | confirms | `rules/skills.md` | noted |
| [2026-07-07](entries/2026-07-07-pocock-progressive-disclosure-skills.md) | Matt Pocock | Progressive disclosure (summary resident, body on invoke) cuts session tokens ~63% | confirms | `ADR-0003` | noted |
| [2026-07-07](entries/2026-07-07-thorsten-ball-building-software-is-learning.md) | Thorsten Ball | Ship-to-learn with fast feedback beats a heavy up-front plan — presses on the plan-approval gate | challenges | `docs/standards/development-lifecycle.md` | actioned (#58) |
| [2026-07-07](entries/2026-07-07-eugene-yan-llm-secure-source-code.md) | Eugene Yan | Staged agent security review: threat-model, parallel discovery, independent verifier, human triage | extends | `rules/security.md` | noted |
| [2026-07-07](entries/2026-07-07-pocock-grill-with-docs-anti-patterns.md) | Matt Pocock | Grilling failure modes (over-broad scope, no handoff, passive steering, discarded output) | extends | `skills/grill-with-docs` | noted |
| [2026-07-07](entries/2026-07-07-google-io-antigravity-cli-gemini-adapter.md) | Logan Kilpatrick (Google) | Gemini CLI being superseded by Antigravity CLI — repo's Gemini adapter discovery needs re-verification | challenges | `docs/research/tool-config-discovery.md` | actioned (#56) |
| [2026-07-07](entries/2026-07-07-openai-cookbook-agent-improvement-loop.md) | OpenAI Cookbook | Traces + feedback become reusable evals; a human approves the diff before merge | confirms | `docs/standards/development-lifecycle.md` | noted |
| [2026-07-07](entries/2026-07-07-openai-cookbook-iterative-repair-loops.md) | OpenAI Cookbook | Bounded Review→Repair→Validate loop with explicit stop conditions (incl. "human review needed") | extends | `skills/verify` | noted |
| [2026-07-07](entries/2026-07-07-willison-vibe-coding-agentic-converging.md) | Simon Willison | Reliable agents make rigorous engineering drift into unreviewed vibe coding; value moves to plan + verify | confirms | `docs/standards/development-lifecycle.md` | noted |
| [2026-07-07](entries/2026-07-07-eugene-yan-compound-with-ai.md) | Eugene Yan | AI compounds when you encode prefs in config files and mine sessions to refine them | confirms | `skills/scout` | noted |
| [2026-07-07](entries/2026-07-07-andrew-ng-coding-agent-domain-acceleration.md) | Andrew Ng | Agent acceleration ranks frontend > backend > infra > research — weight guardrails by domain | extends | `rules/backend.md` | noted |
| [2026-07-06](entries/2026-07-06-building-effective-agents-simplicity.md) | Erik Schluntz & Barry Zhang (Anthropic) | Prefer simple, composable patterns; add agentic complexity only when it measurably helps | confirms | `ADR-0003` | noted |
| [2026-07-06](entries/2026-07-06-hamel-evals-first-class-tests.md) | Hamel Husain | An AI product needs task-specific evals as first-class tests | extends | `rules/testing.md` | actioned |
