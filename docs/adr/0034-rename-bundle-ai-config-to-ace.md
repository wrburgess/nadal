# Rename the bundle `ai-config` → `ace`

**Status:** accepted

## Context

The bundle has outgrown its working name. The HC decision of 2026-07-28 on
[#148](https://github.com/wrburgess/ace/issues/148) renames the repository
`wrburgess/ai-config` → `wrburgess/ace` **ahead of the hub roles** the roadmap assigns it: the
vendoring **receipt** and **release dispatcher** under the distribution epic
([#149](https://github.com/wrburgess/ace/issues/149)), and the org-overlay consumers that will vendor
from it. Renaming now, before those roles ship, means every new artifact is **born with its final
name** — `bin/ace-sync`, the `ace-rails` Stack Overlay
([#63](https://github.com/wrburgess/ace/issues/63)), the detachable `ace-intake` pipeline
([#108](https://github.com/wrburgess/ace/issues/108)) — instead of accumulating a second generation
of old-name references for a later, larger sweep.

The GitHub-side rename is already done and redirects are active. What this ADR settles is the
**in-repo policy**: which old-name references are *live* (renamed) and which are *history* (kept).

## Decision

1. **The bundle is named `ace`.** Every live surface renames with it: the installer becomes
   `bin/ace-sync` (class `AceSync`), its self-test `test/ace_sync_test.rb`, the overlay seed
   [`docs/overlays/ace-rails.md`](../overlays/ace-rails.md), and every live reference in the README,
   guides, rules, workflow, and checker — including issue links, which now point at
   `github.com/wrburgess/ace`.

2. **Shipped decision prose is immutable history.** ADRs 0001–0033 and
   [`docs/research/tool-config-discovery.md`](../research/tool-config-discovery.md) keep their
   old-name mentions and old-repo issue URLs untouched — they are deliberate point-in-time records
   (the same immutability stance [ADR 0033](0033-verification-stays-in-main-agent-loop.md) applies
   when amending [ADR 0005](0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)), and
   GitHub's redirect keeps every historical URL resolving.

3. **Named, deliberate stalenesses** — recorded here so no future sweep "fixes" them:
   - [ADR 0017](0017-stack-neutral-baseline-with-stack-overlays.md)'s literal path citation of
     `docs/overlays/ai-config-rails.md` goes stale by design; the overlay file is now
     `docs/overlays/ace-rails.md`.
   - The sole word-bounded `AIC` in [ADR 0023](0023-tool-roster-facts-tracker-sibling-to-intake.md)
     is an unrelated acronym, untouched.
   - Open-issue prose may keep the old name; the redirect covers it, and issues are conversation,
     not shipped config.

## Consequences

- **Never recreate `wrburgess/ai-config`.** GitHub's rename redirects persist only until the old
  name is reused — recreating it (even as a placeholder) would sever every historical URL that
  ADRs 0001–0033 and the research doc deliberately keep.
- **`bryce`'s vendored links heal downstream, not here.** The existing Host App copy still carries
  old-name links; they resolve via the redirect today and are replaced wholesale by the first
  receipt-based sync under [#149](https://github.com/wrburgess/ace/issues/149) — no manual host
  sweep.
- **A tree-wide "no live old-name" checker was considered and deferred.** The parity check's scope
  stays deliberately narrow ([ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)):
  the live/history boundary above is a judgment call per file, exactly the kind of content decision
  ADR 0008 keeps out of the checker. The implementing PR's leak audit
  (`git grep` plus an eyeball pass) is the enforcement, backed by the renamed strings now asserted
  in `test/ace_sync_test.rb`.
