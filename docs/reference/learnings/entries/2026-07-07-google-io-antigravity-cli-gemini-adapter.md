---
date: 2026-07-07
source:
  person: Logan Kilpatrick (Google)
  link: https://blog.google/innovation-and-ai/technology/developers-tools/google-io-2026-developer-highlights/
  medium: blog
claim: >
  Google is transitioning Gemini CLI users to a new "Antigravity CLI" and introducing Managed Agents
  in the Gemini API.
stance: challenges
touches: docs/research/tool-config-discovery.md
status: actioned
status_detail: >
  → #56: re-verify the Gemini adapter (GEMINI.md → @AGENTS.md discovery) against Antigravity CLI and
  update docs/research/tool-config-discovery.md + the AGENTS.md Gemini row if the discovery path changed.
---

## Compare / contrast

Published 2026-05-19 (backfill window). Google's I/O 2026 developer highlights say Gemini CLI users
are being transitioned to a new **Antigravity CLI** (terminal agent creation), alongside Managed
Agents in the Gemini API.

This **challenges** the currency of the repo's **Gemini adapter**. `AGENTS.md` → *How each tool
consumes this file* and `docs/research/tool-config-discovery.md` (`ADR-0002`) assert that Gemini reads
`GEMINI.md`, which imports `@AGENTS.md`. If Gemini CLI is being superseded by Antigravity CLI, that
per-tool discovery claim needs **re-verification**: does Antigravity CLI honor `GEMINI.md` / `AGENTS.md`
at all, or does the adapter (and the parity check's Gemini expectations) need updating?

## Disposition

`noted` — the most action-worthy finding of this sweep. **Recommend a follow-up issue** to re-verify
the Gemini adapter against Antigravity CLI before the next release, updating
`docs/research/tool-config-discovery.md` and the `AGENTS.md` Gemini row if the discovery path changed.
A stale adapter silently breaks the single-sourcing guarantee for one tool.

**Resolution (#56, 2026-07-07):** re-verified against primary sources — the transition is real
(consumer Gemini CLI retired 2026-06-18), **but Antigravity CLI preserves `GEMINI.md`/`AGENTS.md`
discovery and the `@`-import** (it even added native `AGENTS.md` in v1.20.3), so the adapter and the
structural parity check were *not* broken. Docs refreshed for currency (`AGENTS.md` Gemini row + stamp,
`docs/research/tool-config-discovery.md`, this entry); no *corrective* `scripts/parity_check.rb` change
was required, though the PR additionally hardens the check to accept native `AGENTS.md` discovery and
records the citation-integrity lesson in `rules/self-review.md`.
