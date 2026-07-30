---
date: 2026-07-07
source:
  person: Andrej Karpathy
  link: https://karpathy.bearblog.dev/sequoia-ascent-2026/
  medium: blog
claim: >
  In the "Software 3.0" shift, agent-native infrastructure — machine-readable schemas, CLIs, and
  structured logs rather than GUI instructions — is the missing piece, and LLMs automate what you can
  verify, not merely what you can specify.
stance: confirms
touches: ADR-0002
status: noted
---

## Compare / contrast

Karpathy's Sequoia Ascent talk frames LLMs as a new programmable layer ("Software 3.0") and argues the
missing piece is **agent-native infrastructure**: "products must expose APIs, CLIs, structured logs,
and machine-readable schemas rather than GUI instructions." He also draws a sharp line — traditional
software automates what you can *specify*; LLMs automate what you can **verify** — and stresses that
agentic engineering still needs human oversight of taste and specs (detailed specs, code review,
security hardening, catching subtle failures).

This **confirms** two foundational bets of this bundle:

- **Agent-native, machine-readable instructions** — [ADR 0002](../../../adr/0002-agents-md-canonical-pointer-projection.md)
  makes `AGENTS.md` the single canonical, machine-readable instruction surface every tool resolves to
  (import-expansion or native discovery), rather than tool-specific, GUI-shaped config. That *is* the
  "expose a machine-readable schema, not GUI instructions" principle applied to agent instructions.
- **Automate what you can verify** — the bundle's quality gate is the structural parity check and the
  `verify` skill's adversarial pass, and its lifecycle keeps humans on specs/plan-approval and review.
  "Automate what you can verify, keep the human on judgment" is exactly that design.

**Related in the log.** Sits alongside the agent-orchestration/verification cluster (e.g.
[Willison — AI review caught bugs](2026-07-07-willison-ai-review-caught-bugs.md),
[Lilian Weng — harness engineering](2026-07-07-lilian-weng-harness-engineering.md)) but is the only
entry on the *machine-readable-instructions* premise (`ADR-0002`).

## Disposition

`noted` — external corroboration of the repo's premise (ADR 0002 and the verify-gated lifecycle), no
change proposed. Logged so a future debate about whether instructions should be machine-canonical or
tool-shaped has this evidence to cite. This is a **human drop** (not a feed sweep), so the incremental
window does not gate it.
