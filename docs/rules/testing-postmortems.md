# Testing — Postmortems (Tier 2)

Deferred deep doc for the Tier-1 rule [`rules/testing.md`](../../rules/testing.md). Heavy,
subsystem-specific case studies for the test suite — **not** auto-loaded; read on demand when the
trigger in [`docs/rules/README.md`](README.md) fires (working in tests). Each entry ends with a
`(Reference: #NNNN)` pointer to the issue/PR that produced it.

## A clean mutation sweep proves the branches, never the input partition (Reference: #103)

**The case.** Issue #103 replaced a regex-based frontmatter assertion with a real parse, because the
regex proved the text *looked* parseable while every consumer needed it to *be* parseable. The change
shipped a five-state helper, a rule per surface, and a large sad-path suite.

To prove the suite was load-bearing rather than decorative, the verify pass **mutation-tested** it:
every error branch was neutered in turn — an early `return` injected for that state — and the suite
re-run. The technique worked. It found a real defect nothing else had: one branch could be deleted with
all tests still green, because an implementation deviation from the plan's named fixture had silently
dropped its coverage. That branch got a regression test, the sweep was re-run, and the final result was
reported with confidence: **zero survivors across every error branch.**

**What shipped anyway.** A Reviewer then found a genuine High that the sweep could not have caught. The
frontmatter fences were located with `l.strip == "---"`, which discards indentation — so an indented
`---`, which is legal *content* inside a YAML block scalar, was mistaken for the closing fence. Input
after it was truncated **before reaching any branch at all**:

```yaml
---
name: distill
description: Valid description.
extra: |
  ---
broken: Stage 3: this is invalid YAML
---
```

The helper returned `[:ok, …]`; the complete block fails to parse. Green CI, unreadable frontmatter
downstream — the exact bug class the change existed to close, wearing a different disguise.

Mutation testing was structurally blind to it. Every mutant died precisely *because* every branch was
tested; the defect lived in **which input reached which branch**, one level above the branches the
sweep perturbs. A sweep answers "is this branch exercised?" It cannot answer "is the input space
partitioned the way the grammar actually works?"

**The rule it yields.** Treat a clean sweep as a *floor*, not a verdict. It licenses the claim "every
branch is exercised" and nothing wider — in particular it never licenses "the tests are sufficient."
Pair it with a second, different question: *what input reaches this code, and where does my parsing of
it disagree with the real grammar?* For anything that consumes a structured format, that means testing
the format's legal-but-awkward constructs — nesting, escaping, embedded delimiters, encodings — rather
than only the malformed inputs you already thought to reject.

## Grade a surprising code path by its mechanism, not by one fixture's symptom (Reference: #103)

**The case.** The same PR, the same defect — but this entry is about why it survived a self-review that
was otherwise thorough.

During the adversarial pass the indented-fence input **was** probed. It was one of six hostile fixtures
fed to the helper, and it behaved oddly: the block truncated and the `description:` came back empty.
Because that particular fixture still produced an error — a valid file wrongly reddened — the anomaly
was triaged as cosmetic, attributed to a pre-existing convention shared with the code being replaced,
and explicitly recorded as "not a finding."

**What that missed.** The truncation was graded on the *direction one fixture happened to fail in*. The
fixture on hand made the flaw fail **loudly** (a false red on a valid file). A neighbouring input — the
Reviewer's, with malformed YAML after the indented line — made the identical flaw fail **silently** (a
false green hiding a broken file). Same mechanism, opposite and far more serious consequence. Grading
the symptom instead of the mechanism inverted the severity from "High, must fix" to "cosmetic, ignore."

The dismissal was also self-reinforcing: "pre-existing, therefore out of scope" is an argument about
*provenance*, not about *severity*, and it retires an anomaly without ever costing the effort of
constructing the adjacent input.

**The rule it yields.** When a code path does something surprising, the finding is the **mechanism**,
not the fixture. Before dismissing it, spend one input: ask what this mechanism does to a *hostile*
neighbour of the case in hand — the same shape with the failure moved, hidden, or inverted — and grade
the worst reachable outcome, not the observed one. "It still errored" is evidence about your fixture;
it is not evidence about the code. Treat "pre-existing" as a scheduling note, never as a severity.
