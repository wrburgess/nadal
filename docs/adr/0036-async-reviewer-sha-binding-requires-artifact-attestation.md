# Asynchronous reviewer SHA binding requires artifact attestation

**Status:** accepted

Narrowly supersedes [ADR 0035](0035-codex-summons-is-the-local-cli-runtime.md) decision 4's
"artifact-derived reviewed SHA for **asynchronous** entries" carve-out — deriving the reviewed SHA
from the artifact now requires the artifact to **explicitly attest** it, with no permissive reading
left when it does not. Everything else stands unmodified: the synchronous
binds-by-construction route and its relay/once-retry conventions (ADR 0035 decisions 1–3), the
non-configurable `stop-and-ask` floor
([ADR 0026](0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md) decision 3),
[`verify`](../../skills/verify/SKILL.md)'s sole ownership of the PR-gate summons (ADR 0026
decision 2), and the *Invocation paths* membership rule
([ADR 0027](0027-reviewer-chain-validated-against-invocation-paths.md)). ADRs are immutable here
([ADR 0024](0024-harness-model-naming-convention.md)), so ADR 0035 is **not edited** — its decision 4
remains an accurate statement of the carve-out as it stood.

## Context

The reviewed-SHA chain hardened on [PR #140](https://github.com/wrburgess/ace/pull/140) closed the
synchronous route: the local CLI reviewer runs against the checked-out PR head, so the summon-captured
SHA binds by construction, and `final` gates on the reviewed SHA equalling the delivered head. The
**asynchronous** half stayed looser ([#141](https://github.com/wrburgess/ace/issues/141)):
[`verify`](../../skills/verify/SKILL.md) told the summoner to "take the reviewed SHA from the review
artifact itself", which reads as a *lookup* — go find the commit — rather than an *acceptance
condition* the artifact must meet. A platform whose artifact pins no commit invited the summoner to
fill the gap with the summon-time head, exactly the assumption the async branch exists to forbid: the
head may advance between summons and fetch, so an unattested artifact proves a review happened
without proving *of what*. Two adjacent gaps rode along: nothing said what to do when the attested
commit turns out stale *at acceptance* (rather than being discovered at delivery by `final`'s gate),
and response attribution leaned purely on "new since the snapshot" even when the mechanism had handed
back a request identity that could attribute exactly.

## Decision

1. **Asynchronous acceptance requires attestation.** An asynchronous response is accepted only when
   its review artifact **explicitly attests the reviewed commit** it covers; that artifact-attested
   commit *is* the reviewed SHA. An artifact that attests no commit — including a platform that
   cannot attest one — is **unverified**, and the review is never assumed to cover the summon-time
   head.

2. **The attested SHA must equal the head, enforced at both ends.** `verify` enforces it at
   acceptance: an attested SHA that differs from the current PR head means the response covered a
   stale commit, and the move is to re-summon on the current head — the same re-enter-the-chain move
   [`final`](../../skills/final/SKILL.md)'s existing hard gate ("the reviewed SHA must equal the PR
   head at delivery", PR #140) forces at delivery. A known-stale reviewed SHA is never carried
   forward as if it covered the head.

3. **Cannot-attest degrades to the floor.** An unattested asynchronous review resolves to
   `stop-and-ask` — a deliberate widening of the floor that **fails closed** on platforms whose
   artifacts cannot attest a commit. This repo's own runs are unaffected: its shipped primary is the
   synchronous CLI route, where the SHA binds by construction and no attestation is needed.

4. **The summons records the request identity when the mechanism returns one.** Response attribution
   is then **by identity** when available and **temporal** (new-since-snapshot) otherwise — the
   snapshot baseline remains the floor, not the ceiling, of attribution.

5. **Platform field names stay in the Project Config.** Which artifact field carries the attestation
   (e.g. a GitHub review's `commit_id`) is host territory: it is named in a `PROJECT.md` →
   *Invocation paths* row and never in a skill body, preserving the neutrality boundary of
   [ADR 0018](0018-neutrality-pass-scope-tooling-and-enforcement.md).

## Considered options

- **A — keep "take the reviewed SHA from the artifact" as authored.** Rejected: a lookup phrasing
  fails open — the summoner who finds no commit in the artifact is left to improvise, and the natural
  improvisation (assume the summon-time head) is precisely the unsound one.
- **B — accept an unattested review with a caveat recorded in the SOW.** Rejected: a caveat is
  delivering unreviewed with a footnote, which the floor exists to forbid (ADR 0026 decision 3); the
  SOW records dispositions, it does not launder them.
- **C — require attestation, enforce head-equality at acceptance, record the request identity, keep
  field names in `PROJECT.md` (chosen).** The async branch becomes an acceptance condition with a
  fail-closed floor, symmetric with the synchronous branch's binds-by-construction guarantee, and a
  four-file drift guard pins the attestation contract.

## Consequences

- **The async branch fails closed.** A platform that cannot attest the reviewed commit can no longer
  satisfy the backstop silently; it surfaces as the floor, where the HC decides.
- **New drift guards** in `test/reviewer_test.rb`: the attestation phrase is pinned verbatim across
  the four governing files (`PROJECT.md`, `skills/verify/SKILL.md`, `skills/final/SKILL.md`,
  `docs/standards/development-lifecycle.md`); `final`'s reviewed-SHA-equals-head hard gate is pinned;
  and the request-identity capture is pinned in `verify`.
- **Hosts adding async rows get one instruction, not a rewrite:** name the artifact's
  commit-attestation field in the row. The shipped Copilot row models it — its Summons cell names a
  GitHub review's `commit_id` — and a row-anchored drift guard pins that declaration (Codex review,
  PR #153).
- **Known limit — attestation is read, not verified.** The procedure trusts the platform's artifact
  to name the commit truthfully; nothing machine-checks the artifact against the diff it reviewed.
  That sits on the same structural boundary as the relay convention
  ([ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md), ADR 0035's known limit).
