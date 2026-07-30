# The merge gate accepts `attested`, and a rule PROJECT.md cannot enforce is an error

**Status:** accepted

Narrowly supersedes [ADR 0025](0025-human-gate-policy-is-a-project-config-value.md) decision 3's
"`merge` accepts `required` and nothing else". `merge` now accepts a second value, **`attested`**, under
which the AC merges the delivered PR only against an independent external-model adversarial review bound
to the SHA being merged. Everything else in ADR 0025 stands unmodified: the section's parse contract and
fail-safe defaults (decisions 1, 4), `plan-approval`'s two values (decision 2), the gate-as-session-
boundary split (decision 5), the out-of-scope enumeration (decision 6 — the intake/authoring "a human
disposes" gates are **explicitly unchanged**), and the exploratory-path election (decision 7). ADRs are
immutable here ([ADR 0024](0024-harness-model-naming-convention.md)), so ADR 0025 is **not edited** — its
decision 3 remains an accurate statement of the policy as it stood.

## Context

ADR 0025 decision 3 made `merge` non-configurable on a specific and correct worry: **no Host App may
express self-merge**, because a host that certifies its own work has no backstop. `scripts/parity_check.rb`
hard-failed any other value with its own accusatory message, deliberately separate from the generic
bad-value message — a policy boundary, not a typo.

That worry has since been answered by a different mechanism. **§ Reviewer**
([ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)) established two
invariants the merge gate never learned to read:

1. **The acting harness is filtered out of its own review chain** before any summons
   (`scripts/reviewer.rb` → `independent_chain`) — "an AC is never its own independent backstop."
2. **The degradation floor is `stop-and-ask` and is not configurable** (ADR 0026 decision 3) — "a run
   that cannot obtain an independent review must not be able to certify itself."

And [ADR 0035](0035-codex-summons-is-the-local-cli-runtime.md) /
[ADR 0036](0036-async-reviewer-sha-binding-requires-artifact-attestation.md) closed the last gap in
*what* was reviewed: the reviewed SHA must be attested, not inferred, so a review proves not merely that
it happened but **of which commit**.

Taken together, the repo already machine-enforces the precondition "an independent external model
adversarially reviewed *this exact commit*." What it did not have was any way to let that evidence
authorize a merge. The result was a host — `nadal` — whose stated operating rule was "AC merges after
green checks + SHA-bound adversarial review" but whose config could not express it.

**How that failed is the more important half of this ADR.** The delta was written down in the only place
that binds nothing: a `PROJECT.md` subsection headed *"nadal merge-autonomy intent (recorded, not
machine-enforced)"*, which honestly described itself as inert. Every other surface — the table row,
`human_gates.rb`, `parity_check.rb`, `AGENTS.md`, `skills/final`, `skills/ship` — kept asserting "a human
always merges". Agents read the binding surfaces and behaved accordingly; the parity check read only the
value and stayed green; ten PRs merged against the written rule without a single check going red. The
prose looked like governance and functioned as a comment.

This is the same defect class the grammar ratchet exists to prevent — a document asserting what the code
contradicts — one level up, at the config layer, where nothing was watching.

## Decision

1. **`merge` accepts `required` (shipped default) and `attested`.** `HumanGates::ALLOWED[:merge]` gains
   the second value. The shipped baseline does **not** change: a host that says nothing, or whose
   `PROJECT.md` predates this ADR, still parses to `required` through the fail-safe default. Autonomy is
   opt-in, never inherited.

2. **`auto` remains forbidden, and keeps its own message.** `SELF_MERGE_VALUE` stays `auto` and still
   hard-fails as a policy boundary. The distinction is the whole point: `auto` is a claim of *unconditional*
   self-merge, which ADR 0025 refused and this ADR does not restore. `attested` is merge on **evidence**,
   which is its opposite. A capitalization slip like `Required` still takes the generic allowed-values
   message and must never be reported as a self-merge claim.

3. **`attested` merges only against four conditions, verified by `final` itself and never read from a
   report:** every *Quality Checks* row green and required checks green **at the delivered head**; no open
   must-fix findings; an independent external-model adversarial review on record; and that review **bound
   to a literal SHA equal to the PR head**. Any one failing means no merge — post the SOW, name the failed
   condition, stop. An attestation naming a different SHA is not evidence about this code.

4. **`attested` does not reach the intake and authoring PRs.** ADR 0025 decision 6's enumeration is
   preserved verbatim: `scout` / `clip` / `follow` / `restock` / `create-skill` still end with a human
   disposing on the PR. Those gates exist for *content judgment*, and an adversarial **code** review is
   not evidence about a finding's disposition.

5. **A `PROJECT.md` heading that markets itself as unenforced is a parity-check ERROR.**
   `check_unenforced_headings` fails on any heading matching *"not machine-enforced"*, *"recorded, not
   enforced"*, or *"non-binding"*. Express the rule as a value the checker parses, or track it as an issue
   — never as a section that reads as authoritative to every agent and binds nothing. This is the ratchet
   that makes the failure above non-repeatable: the escape hatch itself is now the error, so it cannot be
   used quietly again by an author who believes they are being scrupulous by labelling it.

## Consequences

**Good.** A host can state its real merge policy and have it enforced instead of documented. The
autonomy is bounded by evidence that already exists and is already non-bypassable, so it adds a gate
rather than removing one. Decision 5 converts a whole class of silent config drift into a red build, and
it costs one regex.

**Costs and risks.** `final` now has a branch that mutates the repository, so its verification is
load-bearing in a way it was not when a human always stood between it and `main`; decision 3's
"verified here, never read from a report" exists specifically for that, and it is the line most likely to
erode under time pressure. The interaction with `autonomous-fold` is real and deliberate: a fold pushed
*after* the attestation moves the head off the attested SHA and condition 4 refuses the merge — correct,
but it means fold-then-summon is now an ordering requirement rather than a preference, and `skills/final`
says so.

**Not addressed.** Whether the *harness* permits the merge command is a separate layer entirely and no
config value reaches it — a host may set `attested`, satisfy all four conditions, and still be unable to
merge because its agent runtime denies the action. That is a runtime permission concern, out of scope
here, and worth stating plainly so the two layers are never conflated again.
