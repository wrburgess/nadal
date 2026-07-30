# AI Software Engineering — People Worth Leaning On

A curated reference of balanced, high-signal contributors to AI-assisted software engineering:
practitioners who ship, document real experiments, and favor best-practices over hype. Not clickbait
artists.

**Compiled July 2026** · additions folded in **2026-07-06**, **2026-07-07**. Links were verified at time of writing;
**handles and channels drift, so re-check before relying on any single URL.** Where a handle could not
be verified it is **omitted intentionally** (noted inline) rather than guessed.

> **ILLUSTRATIVE REFERENCE — not part of the [Generic Baseline](../../CONTEXT.md) guarantee.** This
> roster is example reference content a Host App is expected to replace or extend during
> Customization. Reference material may name specific external field sources (it is *reference about
> the practice of AI-assisted engineering*, not host-business-domain content); the distinction is
> recorded in [ADR 0012](../adr/0012-intake-pipeline-placement.md). See
> [`README.md`](README.md) for the label rationale.

**Reader's note (stack context):** These voices are largely Python- and TypeScript-native. The
*methodology* — evals, context engineering, TDD-with-agents, disciplined workflows — ports cleanly to
a Rails + Hotwire/Stimulus + Bootstrap setup, but expect examples in other languages. None of them are
Ruby/Rails-specific.

## Maintenance & relationship to `voices.yml`

This doc is the **human-readable** roster. Its machine-readable sibling is
[`voices.yml`](voices.yml) — the Watchlist the [`scout`](../../skills/scout/SKILL.md) intake sweep
polls (issue #28). The two describe the same people; to keep them from drifting, they divide the work:

- **`voices.yml` owns the machine fields** the sweep needs — `feeds`, `cadence`, `verified`
  (last-checked date), and `status` (`active` | `in-flux` | `dormant`). When a handle or feed is
  re-verified, update `voices.yml` (and its `verified` date) first.
- **This prose doc owns the narrative** — the per-person **Focus**, the tier rationale, and the
  non-person sections (the *For balance* primary-source documents and the *Master resource*) that
  don't fit the person-sweep schema and so live only here.
- **Re-verification convention:** the space churns. Before citing anyone, re-check the handle; entries
  carrying a `_(verify)_` or ⚠ note below are known-uncertain and flagged in `voices.yml` too (e.g.
  `status: in-flux`). An unverified handle stays omitted, never invented.

The tiers below match `voices.yml`'s `tier` buckets: **core** (Tier 1) · **trend** (Tier 2) ·
**frontier-lab** / **org** (Tier 3) · **balance** · **community** · plus the *Master resource*.

## Tier 1 — Core practical voices (start here)

### Simon Willison
- **Focus:** The reference point for applied LLM/agent work. Django co-creator; builds the `llm` CLI
  and Datasette. Documents daily how models actually behave, changes his mind in public, refuses to
  publish AI-generated writing under his name. His *Agentic Engineering Patterns* guide is the closest
  thing to a living best-practices text.
- **Site:** https://simonwillison.net/
- **X:** https://x.com/simonw
- **Bluesky:** https://bsky.app/profile/simonwillison.net (active daily — swept via its RSS feed)
- **YouTube:** No dedicated channel (talks appear on event/conference channels)

### Thorsten Ball
- **Focus:** Fundamentals and clarity. "How to build an agent" — a working coding agent in ~400 lines,
  the clearest "agents aren't magic" walkthrough. Writes the *Register Spill* newsletter; works on the
  Amp coding agent.
- **Site:** https://registerspill.thorstenball.com/  ·  https://thorstenball.com/
- **X:** _(unverified — omitted intentionally)_
- **YouTube:** No dedicated channel

### Matt Pocock
- **Focus:** Workflow and discipline. TypeScript educator (Total TypeScript, AI Hero) turned sharp
  voice on constrained AI engineering. Thesis: agents are only as good as the engineering constraints
  you give them. Ships the widely-used `mattpocock/skills` repo (grill-me, TDD, diagnose, architecture
  skills) and the `Sand Castle` multi-agent parallelization framework. Coined "Skill Hell" and
  proposed a rubric for judging skills. Directly relevant to multi-agent worktree workflows.
- **Site:** https://www.aihero.dev/
- **X:** https://x.com/mattpocockuk
- **YouTube:** https://www.youtube.com/@aihero-dev (AI Hero)

### Hamel Husain
- **Focus:** Evals and LLM observability — the antidote to vibes-based "it seems better" claims. "Your
  AI Product Needs Evals" is the most-cited essay on the topic. Essential once anything goes to
  production.
- **Site:** https://hamel.dev/
- **X:** https://x.com/HamelHusain
- **YouTube:** Fine-tuning / evals workshops on his channel (search "Hamel Husain")

### Jason Liu
- **Focus:** Structured outputs and RAG. Creator of Instructor; very practitioner-focused, systematic
  approach to improving RAG applications.
- **Site:** https://jxnl.co/
- **X:** https://x.com/jxnlco
- **YouTube:** Talks on the AI Engineer channel (no primary personal channel)

### Eugene Yan
- **Focus:** Patterns for building LLM systems and products; task-specific eval techniques.
  Systematic, eval-heavy, no hype. Co-author of "What We Learned from a Year of Building with LLMs."
- **Site:** https://eugeneyan.com/
- **X:** https://x.com/eugeneyan
- **YouTube:** No dedicated channel

### Chip Huyen
- **Focus:** The end-to-end textbook author — *AI Engineering* (O'Reilly, 2025) for building LLM
  applications. Strong on bringing engineering/DevOps best practices to ML in production.
- **Site:** https://huyenchip.com/
- **X:** https://x.com/chipro
- **YouTube:** No dedicated channel

### Shreya Shankar
- **Focus:** Evals for real LLM pipelines — the on-theme complement to Hamel Husain (they co-teach the
  *AI Evals for Engineers & PMs* course and are co-authoring O'Reilly's *Evals for AI Engineers*).
  Built DocETL; "Who Validates the Validators?" was Most-Cited at UIST 2024. UC Berkeley EECS PhD.
- **Site:** https://www.sh-reya.com/  ·  https://evals.info/
- **X:** https://x.com/sh_reya
- **YouTube:** Course/talk material via Parlance Labs (no primary personal channel)

### Lilian Weng
- **Focus:** Systematic agent/LLM design writing. Her "LLM-Powered Autonomous Agents" (Lil'Log) is
  canonical agent-architecture reading; deep, no hype. Ex-OpenAI VP of AI Safety; co-founder, Thinking
  Machines Lab.
- **Site:** https://lilianweng.github.io/ (Lil'Log)
- **X:** https://x.com/lilianweng
- **YouTube:** No dedicated channel

### Addy Osmani
- **Focus:** AI-assisted engineering, balanced and hype-free. "The 70% Problem" is a widely-cited
  hard-truths take on AI coding; the *Elevate* newsletter (600k+ readers) runs hands-on deep-dives on
  agentic workflows, code review, and autonomy levels. Director at Google Cloud AI; 25+ years in
  developer tooling.
- **Site:** https://addyosmani.com/  ·  Newsletter: https://addyo.substack.com/ (Elevate)
- **X:** https://x.com/addyosmani
- **YouTube:** No dedicated channel (appears on podcasts)

### Jesse Vincent
- **Focus:** Skills-as-methodology, from a toolmaker who ships. Creator of **Superpowers**, the
  most-used Claude Code plugin — an agentic skills framework and software-development methodology
  (TDD-with-agents, systematic debugging, subagent-driven development with built-in review, and
  skill-authoring itself). Directly parallel to this repo's own Skills + lifecycle model, so a
  high-signal external check on how skill bodies and agent workflows are converging. Long track record
  as a toolmaker (Request Tracker, K-9 Mail, Keyboardio); now Founder/CEO, Prime Radiant.
- **Site:** https://blog.fsck.com/ (Massively Parallel Procrastination) · Skills framework:
  https://github.com/obra/superpowers
- **X:** none active — abandoned [@obra](https://x.com/obra) ("I don't post here anymore"); posts on
  Bluesky ([@s.ly](https://bsky.app/profile/s.ly)) instead. Swept via the blog's Atom feed.
- **GitHub:** https://github.com/obra

## Tier 2 — Bigger-picture / trend voices

### Andrej Karpathy
- **Focus:** Foundational explainers; coined "vibe coding" (and is careful about what it does and
  doesn't mean). "Neural Networks: Zero to Hero" is mandatory viewing. Founded Eureka Labs; joined
  Anthropic's pretraining team in 2026.
- **Site:** https://karpathy.ai/
- **X:** https://x.com/karpathy
- **YouTube:** https://www.youtube.com/@AndrejKarpathy

### Steve Yegge
- **Focus:** How the developer role is shifting. "Revenge of the junior developer" and "The death of
  the stubborn developer." Opinionated but substantive; at Sourcegraph.
- **Site:** _(writes via Sourcegraph blog / Medium — search by title)_
- **X:** https://x.com/steve_yegge
- **YouTube:** No dedicated channel

### Andrew Ng
- **Focus:** *The Batch* — a reliable weekly AI-engineering digest. Broad, steady, low-noise.
- **Site:** https://www.deeplearning.ai/the-batch/
- **X:** https://x.com/AndrewYNg
- **YouTube:** https://www.youtube.com/@Deeplearningai (DeepLearningAI)

### Every
- **Focus:** Practitioner essays on building with AI and its effect on knowledge work; Dan Shipper's "Chain of Thought"; the *AI & I* podcast.
- **Site:** https://every.to/
- **X:** https://x.com/every

## Tier 3 — Frontier-lab voices (Anthropic / OpenAI / Google)

The humans and org channels behind the primary-source docs cited under *For balance*. Worth following
directly since primary-source practice ships here first.

### Anthropic
- **Boris Cherny** — Creator & Head of Claude Code; primary voice on agentic-coding practice at scale.
  X: https://x.com/bcherny _(verify)_
- **Erik Schluntz & Barry Zhang** — authors of "Building Effective Agents" (Anthropic Engineering) —
  the canonical simple-composable-patterns piece.
- **Alex Albert** — Head of Claude Relations. Site: https://alexalbert.me/ · X: https://x.com/alexalbert__
- **Cat Wu** — Claude Code PM / founding engineer. X: https://x.com/_catwu _(verify)_
- **Thariq Shihipar** — Claude Code engineer; built the AskUserQuestion tool, documents prompt-caching
  internals and the "HTML is the new Markdown" planning workflow. Site: https://www.thariq.io/ ·
  X: https://x.com/trq212
- **Org:** Anthropic Engineering — https://www.anthropic.com/engineering
- **Channel:** ClaudeDevs — the official Anthropic channel for Claude Code + platform updates
  (changelogs, API releases, community updates, deep dives); launched 2026. X: https://x.com/ClaudeDevs

### OpenAI
- **Romain Huet** — Head of Developer Experience. X: https://x.com/romainhuet
- **Org / primary sources:** OpenAI Cookbook (https://cookbook.openai.com/); the Codex team + the
  **AGENTS.md** standard (also cited under *For balance*).

### Google / Gemini
- **Logan Kilpatrick** — led Google AI Studio + Gemini API DevRel. ⚠ Reportedly stepping away from the
  AI Studio role as of mid-2026 — verify current title before citing. X: https://x.com/OfficialLoganK
- **Philipp Schmid** — Staff DevRel/DevX, Google DeepMind (ex-Hugging Face); very hands-on
  agentic-Gemini guides. Site: https://www.philschmid.de/ · GitHub: https://github.com/philschmid
- **Paige Bailey** — AI DevRel Engineering Lead, Google DeepMind (ex-GitHub/Copilot). GitHub/handle:
  `dynamicwebpaige` (https://github.com/dynamicwebpaige) · Bluesky:
  https://bsky.app/profile/dynamicwebpaige.bsky.social (active — swept via its RSS feed)
- **Org:** Google AI for Developers — https://ai.google.dev/ (+ the Gemini CLI project)

## For balance (contrarian / primary sources)

Worth reading alongside the enthusiasts.

**People:**

- **Sara Hooker** — Contrarian on the scaling race; ex-VP Research at Cohere (led Cohere Labs / Cohere
  For AI), now founder of **Adaption Labs** (a bet on smaller, continuously-adapting models). Read as a
  counterweight to "bigger model = better." Site: https://www.sarahooker.me/ · X: https://x.com/sarahookr
- **Rachel Thomas** — Data ethics and a skeptical lens on AI hype; co-founder of fast.ai, now R&D at
  Answer.AI. Site: https://rachel.fast.ai/
- **Emily Bender** — The critical-linguistics counterweight ("stochastic parrots"; *The AI Con*). Read
  to pressure-test enthusiast claims. Active on Bluesky, not X:
  https://bsky.app/profile/emilymbender.bsky.social (swept via its RSS feed).

**Primary-source documents** (tracked here as documents, not people — kept out of the person-sweep):

- **"Don't build multi-agents" — Cognition.** Counterpoint to multi-agent maximalism.
- **"How we built our multi-agent research system" — Anthropic.** The other side of that debate.
- **"Claude Code: best practices for agentic coding" — Anthropic.** Primary source on `CLAUDE.md`,
  tools, slash commands, headless mode.
- **"Twelve-factor agents" — HumanLayer.** The "12-factor app" equivalent for agent apps.
- **AGENTS.md** — community standard for per-repo agent instructions.

## Community aggregator (high-leverage single subscription)

- **Latent Space — The AI Engineer Podcast** (swyx / Shawn Wang + Alessio Fanelli) — named the "AI
  Engineer" movement; the connective tissue that surfaces most voices above in one feed.
  Site: https://www.latent.space/ · swyx X: https://x.com/swyx
- **Seth Hobson** (`wshobson/agents`) — maintainer of a large (~38k-star) multi-harness agentic
  plugin/agent marketplace: specialist agent prompts (frontend, backend, security, debugger) for Claude
  Code, Codex, Cursor, Copilot, and Gemini CLI. Agent *definitions* rather than skills proper, but an
  adjacent primary source for how the ecosystem structures agents. Swept via the repo's commit feed.
  GitHub: https://github.com/wshobson/agents

## Master resource

Ecosystem maps — curators, not authors — kept here as reference and **out of the person-sweep**
(they map the landscape rather than produce field output). Anyone who wants live updates can subscribe
to each repo's commit feed directly.

**EthicalML/awesome-agentic-engineering-resources** — curates most of the above with quality tiers and
free/paid tags. The best single map of the landscape.
- https://github.com/EthicalML/awesome-agentic-engineering-resources

**hesreallyhim/awesome-claude-code** — a large (~50k-star) hand-picked index of the Claude Code
ecosystem (skills, agents, plugins, tooling). Curator/map, not original authorship; its commit feed is
mostly automated ticker/SVG updates, so it's tracked here rather than swept.
- https://github.com/hesreallyhim/awesome-claude-code
  (feed: https://github.com/hesreallyhim/awesome-claude-code/commits.atom)

**ComposioHQ/awesome-claude-skills** — a curated index of 1000+ Claude Skills/plugins (Composio).
Another ecosystem map rather than an author; slower-moving feed, tracked here as reference.
- https://github.com/ComposioHQ/awesome-claude-skills
  (feed: https://github.com/ComposioHQ/awesome-claude-skills/commits.atom)

## Diversity note

With the 2026-07-06 additions, the roster's women span evals (Chip Huyen, Shreya Shankar), agent
design (Lilian Weng), DevRel (Paige Bailey), research leadership / contrarian (Sara Hooker), and ethics
(Rachel Thomas, Emily Bender) — a real improvement over the single entry in the compiled July 2026
source. Still worth continuing to broaden as the `scout` sweep (#28) surfaces new voices.
