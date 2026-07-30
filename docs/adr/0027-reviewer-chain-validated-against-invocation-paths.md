# The reviewer chain is validated against Invocation paths, and the precondition check is host-supplied

**Status:** accepted

Narrowly supersedes [ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md)
decision 4 (below, decision 4), and **amends ADR 0026 decision 1 in two named places** (decision 7).
Decisions 2, 3, 5, 6 and 7 of ADR 0026 stand unmodified.

## Context

[ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md) made the Reviewer a
Project Config value and gave it a parser. An independent review of the implementing PR found three
holes in what that parser actually guarantees, all reproduced before being recorded
([#118](https://github.com/wrburgess/ai-config/issues/118)):

1. **A preserved Host App re-syncs to a green but unusable chain.** `PROJECT.md` is preserved across a
   re-sync, so a host vendored before the section existed gets the reviewer-aware skill bodies —
   which require an *Invocation paths* table — and no such table. `Reviewer::DEFAULTS` supplies the
   four field values, but there is **no default for the invocation mechanism**, and nothing in the
   guides told the host to add one. The parity check passed.
2. **Chain membership was unvalidated.** `primary: Not A Configured Harness` with
   `fallback_order: none, , Nope` returned `{}` from `Reviewer.invalid`. A typo, an empty element, or
   a harness with no summons mechanism all read as a valid chain.
3. **The shipped precondition checks do not implement "check before summon."** The Codex check needs
   GitHub App authentication an AC's normal token does not have (401/403), and the Copilot check *is*
   the summons, so it cannot precede one without a side effect. ADR 0026 decision 4 recorded the
   requirement **and** named this shortfall, so the ADR did not overclaim — but the procedure in
   `verify` and the preamble in `PROJECT.md` both still asserted an unconditional check the baseline
   does not ship.

Underneath all three is one question ADR 0026 left open: **what makes a chain entry real?** Naming a
harness is not the same as being able to reach one.

## Decision

1. **The *Invocation paths* table is the chain's membership list.** A `primary` or `fallback_order`
   entry with no row there has no summons mechanism, so it is **unreachable**. `scripts/reviewer.rb`
   gains `invocation_paths` and `unsummonable`; `scripts/parity_check.rb` reports each unreachable
   entry.

   Membership is validated against *Invocation paths* rather than against *Attribution & Model
   Declaration* for two reasons. It needs **no cross-section coupling** — the reviewer extractor stays
   within its own H2 and never learns to parse another section's table, which is what kept this
   answerable without first settling "what is the canonical harness list". And it tests **the property
   that actually matters**: a harness listed under *Attribution* is one this repo signs commits as,
   which says nothing about whether an AC can summon it. The reachable set is the one the procedure
   depends on.

   "Stays within its own H2" is an **enforced** property, not a description of intent.
   `invocation_paths` locates `## Reviewer` first and searches for its `### Invocation paths` H3
   *inside* that section, ending at the next heading of any level. Shipped first as a file-global
   search for the H3, it read whichever heading of that name came first anywhere in `PROJECT.md` —
   so a host with no sub-table under `## Reviewer` passed green off an unrelated decoy, which is the
   #118 state this decision exists to close, and the converse decoy reported a declared chain
   unreachable. Scoping is what makes the sentence above true of the code.

2. **The chain's SHAPE is validated, each fault under its own key.** `Reviewer.invalid` gains
   `:primary_blank`, `:fallback_order_blank_element`, `:fallback_order_none_mixed`, and
   `:fallback_order_self_reference`. Distinct keys are load-bearing rather than tidy: the repro
   `none, , Nope` satisfies two predicates at once, so a single shared key would let either branch be
   deleted with the other still setting it — two defects, both unprovable by test. `rules/testing.md`
   names that trap; this ADR records that the key layout is the countermeasure.

3. **Independence is procedural and self-reported, and only its same-harness shadow is checkable.**
   The lifecycle standard requires the Reviewer be *a different model from the AC*. Nothing in a
   static check can know which model is executing: the AC states its own runtime identity, and a
   parser reading `PROJECT.md` cannot audit that claim. This sits outside
   [ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)'s structural boundary, and adding
   a model-in-the-loop check to cross it is the thing that ADR rejects.

   Two consequences are accepted deliberately. `verify` performs a **harness**-level check at runtime
   — if a chain entry names the harness it is running as, it treats the entry as unreachable and falls
   back — which catches the same-harness case and **not** two different harnesses serving the same
   model. And the static check is narrower still: `:fallback_order_self_reference` catches only a
   primary repeated verbatim in its own fallback. Recording the gap is the point; a check that
   *appears* to enforce independence would be worse than a documented absence.

4. **The precondition *Check* is optional and host-supplied — this narrowly supersedes ADR 0026
   decision 4.** Declared → run it before summoning, and an unmet one falls back immediately. Absent →
   **the summons is the probe**, and the outcome is carried forward as
   `unreachable (precondition unverified)`, never as a clean timeout.

   ADR 0026 decision 4 required an unconditional pre-check and honestly named that the shipped rows do
   not satisfy it. That honesty fixed the ADR but not the procedure: `verify` and `PROJECT.md` both
   went on instructing an AC to run a check that does not exist, and neither `parity_check.rb` nor any
   test reads prose, so the contradiction shipped green. The requirement is therefore relaxed to what
   the baseline can actually deliver, with the unverified outcome named so the information is not
   silently laundered into a timeout.

5. **A missing `## Reviewer` section stays silently defaulted, and resolves at RUNTIME to the floor.**
   It is not a parity error. The alternative — parity flagging "reviewer-aware skills present, no
   section" — would redden every already-vendored host the moment it re-syncs, which is precisely the
   compatibility contract the section was kept out of `REQUIRED_PROJECT_SECTIONS` to honor.

   The gap is closed where it belongs instead: `verify` treats an entry with no *Invocation paths* row
   as unreachable, so a preserved host's chain is unreachable end to end and the run lands on
   `stop-and-ask` — visibly, at the gate, rather than by appearing to be reviewed. `docs/guides/usage.md`
   documents both the section and the re-sync hazard, since a preserved `PROJECT.md` may predate any
   additive section.

6. **The plan gate has no summons MECHANISM, which is a second hole beside the one already recorded.**
   ADR 0026 decision 2 records the plan-gate summons **owner** as deliberately unsettled, pending
   [#115](https://github.com/wrburgess/ai-config/issues/115) and
   [#116](https://github.com/wrburgess/ai-config/issues/116). Auditing *Invocation paths* for this ADR
   surfaced that ownership is not the only thing missing: **both shipped mechanisms are PR-gate-only**
   ("mention `@codex review` on the PR", "request a PR review via the host platform's API"). At the
   plan gate there is no mechanism to invoke *regardless of who owns the summons*.

   These are two separate holes, and recording only the first is how the second stayed invisible — an
   owner could be assigned tomorrow and the plan gate would still have nothing to call. This ADR
   **records** the mechanism gap and deliberately does not fix it; it belongs with #115, alongside the
   ownership question. `PROJECT.md` → *Invocation paths* states it at the point of authorship, where a
   host adding its own rows will meet it.

7. **Two consequential amendments to ADR 0026 decision 1, named here rather than made silently.**
   Decision 1 specified what the `## Reviewer` section declares. Implementing decisions 1 and 4 above
   changed that specification twice, and both changes are visible in the shipped `PROJECT.md`:

   - **`Primary` names a HARNESS ONLY, not "harness + model."** ADR 0026 decision 1 says the section
     declares "the primary reviewer (harness + model per [ADR 0024](0024-harness-model-naming-convention.md))",
     and the file shipped `Codex (GPT - host sets model)`. That reading is backwards: ADR 0024's
     convention exists to keep the two APART, and a harness+model compound in a harness-named field is
     the conflation it forbids. It also breaks decision 1 above — membership is checked against
     *Invocation paths*, whose rows are harnesses — so a model-qualified primary was resolving to its
     harness row only by `unsummonable`'s prefix match, which was a documented limitation, not a
     contract to build on. Decision 8 has since removed that prefix match, so a model-qualified entry
     no longer resolves at all; this amendment is what makes that the correct outcome rather than a
     regression. The shipped value is now bare `Codex`, and the allowed-values cell reads
     "any harness with a row in *Invocation paths*" rather than "any harness in *Attribution & Model
     Declaration*".
   - **The invocation table's *Check* column is optional, so decision 1's "*and its
     precondition-check command*" no longer holds as a requirement of the table.** This is the
     table-shape half of decision 4 above; both shipped *Check* cells now read host-supplied. Decision
     4 relaxes the procedure, and this relaxes the declaration the procedure reads.

8. **Membership is matched EXACTLY on the normalized harness name, and the sub-table is parsed as
   markdown rather than as lines that look like markdown.** Decisions 1-7 were implemented against a
   scan that a second-model review then broke three ways; each is closed here, and each was an
   input-partition error a branch-coverage sweep could not have reached.

   - **Exact matching replaces prefix matching.** `entry.start_with?(harness)` was borrowed from
     `labelled?` and pinned as a known limitation. It was not survivable: a lone `Codex` row satisfied
     a `Codex Cloud` fallback, which is broken under *both* readings — distinct harnesses means the
     fallback has no mechanism, the same harness means the chain falls back to itself — and neither
     `unsummonable` nor `invalid`'s self-reference check reported it. `labelled?` is deliberately left
     alone in both readers: a descriptive setting-row LABEL and a harness IDENTITY are different
     grammars, and a prefix rule that is the point in the first is a collision in the second.
   - **A fenced code block is never data.** A ```` ```markdown ```` example showing a host how to
     author the sub-table was parsed as the live declaration — and when the fence sat above the
     settings table, the scan bound the fenced heading and ran on to return the settings rows as
     harnesses. Documentation could declare a reviewer.
   - **Headings and rows honour CommonMark's 0-3 space indent.** A legal `  #### Notes` did not
     terminate the scan, so a harness-shaped table beneath it joined the membership list. Four or more
     spaces is an indented code block and now declares nothing, which keeps the fence rule from being
     trivially bypassed.
   - **An escaped `\|` is cell content.** Splitting on it shifted every later cell one position left,
     so a row's real em-dash *Summons* cell went unread and a placeholder harness reported as
     reachable. This needed a reviewer-only cell splitter: `table_cells` is contract-identical with
     `scripts/human_gates.rb` and could not move.

   Recorded as its own decision because a scope statement claiming "every other decision in ADR 0026
   stands unmodified" was *false about this ADR's own diff* — exactly the documented-vs-shipped split
   the rest of this ADR exists to close.

## Considered options

- **A — a resident fallback for the whole declaration, invocation paths included.** Rejected: the
  baseline cannot know any host's real summons command, so the "default" would be an invented
  mechanism that fails at runtime — the #99 silent-failure shape, re-created inside the fix for it.
- **B — parity flags a preserved host as needing migration** ("reviewer-aware skills present, no
  `## Reviewer` section"). Rejected: it reddens every vendored host on re-sync, breaking the additive
  contract. The section-migration problem is real but general — it applies to all four additive
  sections — and deserves its own issue rather than a Reviewer-shaped special case.
- **C — validate membership against *Attribution & Model Declaration*.** Rejected: it couples two
  Project Config sections, needs the unsettled "canonical harness list" decision first, and checks a
  weaker property — being a harness this repo signs as, not one the AC can summon.
- **D — validate against *Invocation paths*, keep the missing section silent, make the precondition
  host-supplied (chosen).** Closes the reachability hole at the layer that owns it, adds no
  cross-section coupling, and keeps the vendored-host guarantee intact.
- **E — declare the shipped checks executable and supply credentials.** Rejected: the Generic Baseline
  cannot assume GitHub App authentication, and the Copilot check is inseparable from the summons. This
  is the option ADR 0026 decision 4 was already unable to take.

## Consequences

- **A chain is now provably reachable, not merely well-spelled.** The parity check reports an entry
  with no summons mechanism, so the #118 repro reddens instead of shipping.
- **A preserved Host App still passes parity and now degrades honestly.** It resolves to
  `stop-and-ask` at the PR gate rather than appearing reviewed. The re-sync hazard is documented, but
  it is documentation, not enforcement — a host that skips the guide still gets an unreviewed-but-
  stopped run, which is the safe direction.
- **Independence remains unenforced at the model level.** This is now written down with its reasoning
  rather than implied by silence. A future host wanting real enforcement needs runtime identity it can
  audit, which the config layer does not have.
- **`unsummonable` matches EXACTLY on the normalized name** (emphasis and backticks stripped, trimmed,
  casefolded). Emphasis and case are authoring noise; anything else is a different harness. The cost is
  that a model-qualified entry such as `Codex (GPT-5)` no longer resolves to its bare `Codex` row — it
  is reported, and the report names the fix. That is the reading decision 7 already committed to when
  it made *Primary* a harness-only field, so the two are now consistent instead of one leaning on a
  limitation of the other.
- **The parse is markdown-aware within the section, not line-shaped.** Fenced blocks, CommonMark's 0-3
  space heading indent, and escaped pipes are all handled (decision 8), so a documentation example
  cannot declare a harness and a legal heading cannot fail to end the scan.
- **Two weaknesses are SHARED with `scripts/human_gates.rb` and deliberately not fixed here.**
  `table_cells` splits on escaped pipes, and both readers locate `## Reviewer` with a scan that a fence
  opened earlier in the file would fool. Both live in the contract-identical helpers the two files hold
  byte-for-byte in common, so changing either belongs in one change touching both readers and both test
  suites — not inside a Reviewer-only fix.
- **The plan gate is now known to be doubly blocked** — no owner and no mechanism — instead of singly.
  #115 inherits both.
