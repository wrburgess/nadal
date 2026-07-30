# A harness PreToolUse hook guards destructive git ops on a dirty tree; the Lean-Core rule is its degradation floor

**Status:** accepted

## Context

An agent can silently and unrecoverably destroy uncommitted work with a single
git command: `git reset --hard`, `git checkout -- <path>` / `git checkout .` /
`git checkout <ref> -f`, `git restore <path>`, or `git clean -f`. Unlike a bad
commit, there is no reflog or `ORIG_HEAD` to recover from — the tracked edits are
gone from the working tree, and `git clean` deletes untracked files outright. This
has bitten the repo before: a `git checkout` undoing a mutation-test change
reverted an uncommitted review fix ([#114](https://github.com/wrburgess/ai-config/issues/114)),
and [#134](https://github.com/wrburgess/ai-config/issues/134) asks for a general
guard against the whole class.

The protected-branch work ([ADR 0009](0009-defense-in-depth-branch-protection-all-agents.md))
established a three-layer, defense-in-depth model — server-side rules, local
git hooks, and per-tool accelerators — and the invariant that **a Layer-3
accelerator must never be the only guard**. The obvious move is to reuse that
model here. It does not port cleanly, and that mismatch is what this ADR settles.

**Git exposes no interception point for these ops.** The protected-branch guard's
portable primary (Layer 2) is a set of git-level hooks — `pre-commit`,
`pre-push`, `pre-merge-commit`, `pre-rebase` — that fire on the real operation no
matter which agent (or human) triggers it. Git ships **no** `pre-checkout`,
`pre-reset`, or `pre-clean` hook. (Its client-side hook set is fixed:
`pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `pre-rebase`,
`post-checkout`/`post-merge` — which fire *after* the destruction —
`pre-push`, and a few others; there is no *pre*-hook for checkout, reset, or
clean.) So for this op class there is no Layer-1/Layer-2 git-level backstop to
build — only a per-tool (Layer 3) interception is available at all.

## Decision

Ship a **Layer-3-only** guard: a Claude `PreToolUse` hook,
`.claude/hooks/enforce-clean-tree.sh`, wired in `.claude/settings.json` on the
`Bash` matcher, that blocks a destructive git op **only when the working tree is
dirty in the sense that op destroys**. Its degradation floor is a **Lean-Core
self-review rule**, not another enforcement layer — and because git exposes no
lower interception point for these ops (see Context), that rule is **guidance, not a
mechanical gate**. This guard therefore does **not** satisfy ADR 0009's "a Layer-3
accelerator must never be the only guard"; it is a deliberate, documented
**Layer-3-only exception** to that invariant, with the residual risk explicitly
accepted (see Decision §2).

1. **The accelerator.** The hook mirrors the branch-creation guard's payload
   parser wholesale (read the JSON on stdin, cut heredoc bodies, split on the
   shell separators with pure parameter expansion, strip leading `ENV=val`, track
   `cd`, honor `-C` / `--git-dir`, and — critically — do **not** unwrap quotes, so
   a commit message or heredoc that merely *mentions* a destructive command stays
   data). It then classifies the subcommand into one of three destructive classes
   and applies an **op-aware** dirty test via `git status --porcelain`:
   reset-hard / checkout-discard / restore-worktree block only on a **tracked**
   change (a porcelain line not starting with `??`); `clean -f` blocks only on an
   **untracked** file (a line starting with `??`). A destroyer on a clean tree —
   or on a tree dirty only in the *other* sense — destroys nothing and is allowed.

2. **This is a documented Layer-3-ONLY exception; the "floor" is guidance, not a
   mechanical layer.** Because git exposes no pre-hook to build (see Context), there
   is **no mechanical Layer-1/Layer-2 backstop** for these ops — nothing like the
   git-level pre-commit/pre-push hooks that make the protected-branch guard
   genuinely defense-in-depth. So this guard does **not** satisfy ADR 0009's "a
   Layer-3 accelerator must never be the only guard" the way that guard does: it is
   genuinely **Layer-3-only**, a deliberate, **documented EXCEPTION** to that
   invariant, with the residual risk explicitly accepted. The Tier-1 Lean-Core
   anti-pattern in [`rules/self-review.md`](../../rules/self-review.md) — *never run
   a destructive git op on a dirty tree without first running `git status` and
   stashing/committing* — is **guidance an agent reads, not an enforcement gate**:
   every configured harness receives it, and on a harness with no `PreToolUse`
   mechanism the guard degrades to that rule alone
   ([ADR 0003](0003-skills-canonical-body-thin-shims-graceful-degradation.md)), but
   a rule a run can forget is not a mechanical floor. This hook is therefore a
   **best-effort, fail-open ACCELERATOR** that reduces the frequency of *accidental*
   destructive ops on a dirty tree — it is **NOT a security boundary** and does not
   defend against deliberate bypass (see *Residual risks / known bypasses*).

3. **Fail-open, never exit 1.** The hook's exit contract is `0` = allow, `2` =
   block, and it **never** exits 1 — any non-2 nonzero would let the tool run
   anyway. Unlike a write-blocking guard, fail-open is the *correct* direction
   here: the hook is an accelerator over the rule, so a parser miss must degrade
   to "the rule catches it", never to a false block that strands the agent. Every
   path ends in an explicit `allow`/`block`, with a trailing `allow` safety net,
   and an unparseable or non-`Bash` payload early-allows.

**Worktree isolation is a separate, deferred concern.** A sibling hazard — two
agents sharing one working tree and clobbering each other's uncommitted edits — is
captured as a Lean-Core anti-pattern in the same file, but its *mechanical*
enforcement is deferred (tracked in #110 /
[ADR 0028](0028-context-reset-boundary-resumable-stops-autonomous-listen.md)). This
ADR guards a single agent's own destructive commands, not concurrency.

## Considered options

- **A — build a git-level (Layer 2) hook, as the protected-branch guard did.**
  Rejected as impossible: git ships no `pre-checkout` / `pre-reset` / `pre-clean`
  hook, so there is no invocation-agnostic interception point for these ops. The
  protected-branch guard could be Layer 2 precisely because commit/push/merge/rebase
  *do* have pre-hooks; this op class does not.
- **B — block every invocation of these ops, dirty or clean.** Rejected: a
  false-positive storm. `git reset --hard` to re-sync a clean checkout, or `git
  clean -f` with nothing untracked, destroys nothing and is routine; blocking it
  trains agents to route around the guard.
- **C — ship only the Lean-Core rule, no hook.** Rejected as insufficient on
  Claude: guidance a body *reads* is not a gate, and a run that forgets it still
  destroys the tree. The accelerator is the pre-run block that makes the rule
  bite where a `PreToolUse` mechanism exists.
- **D — a porcelain-gated Layer-3 accelerator whose floor is the Lean-Core rule
  (chosen).** Op-aware, fail-open, best-UX on Claude, and degrading to rule-only
  elsewhere — the only shape that fits an op class with no git-level backstop.

## Consequences

- On Claude, a destructive git op on a dirty tree is blocked before it runs, with
  a message telling the agent to `git status` and stash/commit first. The hook's
  full contract is pinned by `.claude/hooks/enforce-clean-tree.test.sh` (run
  unconditionally in CI, like the branch-hook self-test); the file is in the parity
  check's `GUARDRAIL_FILES` so its absence reddens the gate, and `check_hooks_wired`
  additionally asserts it is actually **wired** into `.claude/settings.json` as a
  `PreToolUse` hook — a shipped-but-disconnected hook reddens too, closing the
  false-green where the guard would silently never run (#136).
- On any harness without a `PreToolUse` hook — and on Claude when a novel spelling
  slips the parser — the guard is the Lean-Core rule alone. That is the intended
  degradation, but note honestly (per the Decision) that the rule is **guidance, not
  a mechanical layer**: this op class has no git-level backstop, so this guard is a
  documented exception to ADR 0009's "never the only guard", not a case of it
  holding.
- **Known limit — parser, not sandbox, and fail-open by design.** A string parser
  cannot defeat a Turing-complete shell, and a fail-open accelerator is not a
  security boundary. The residual bypasses are enumerated below; each degrades
  fail-open to the rule. The trade is intentional: the cost of a miss is "the rule
  (maybe) catches it", not a false block that strands an agent mid-task.

## Residual risks / known bypasses (accepted)

This guard is a best-effort accelerator, not a sandbox. The following slip past it;
each degrades **fail-open** to the Lean-Core rule and is **accepted** — fail-open is
the correct direction for an accelerator over a rule (a miss costs "the rule maybe
catches it", never a false block):

- **Deliberate shell indirection.** A destructive op reached through `eval`,
  `bash -c '<quoted compound>'`, or command substitution `$(...)` building the
  command at runtime is not statically visible to a string parser. (A here-string
  `<<<WORD` is scanned — including any `&& ...` after it — because #136 stopped the
  heredoc cut from firing on `<<<`; only content built *inside* a `$(...)` is opaque.)
- **Explicit repo selectors the parser does not resolve.** `GIT_DIR=` /
  `GIT_WORK_TREE=` environment assignments (stripped as leading `ENV=val` and not
  applied to the repo under test) and `git --work-tree=...` point the op at a repo
  whose dirtiness the hook never checked. A **single** `-C <dir>` / `--git-dir` IS
  honored; **cumulative** `-C` is not — see the next bullet.
- **Cumulative `-C` is not chained.** Git resolves repeated `-C` options relative to
  each other, so `git -C a -C b <destructive>` operates in `a/b`. The parser instead
  resolves every `-C` against the original cwd, so it checks `b`, not `a/b` — a
  differing directory whose dirtiness it never inspected. A lone `-C` is exact; only
  the stacked form escapes.
- **A destructive op after a heredoc body.** The heredoc-body cut truncates the
  command at the first `<<` operator, so a real destructive command placed AFTER a
  heredoc body/terminator on a later line (`cat <<EOF … EOF; git reset --hard`) is
  dropped by that cut and never scanned. Multi-line heredoc commands are inspected
  only up to the first `<<`.
- **A pathspec that is also a valid ref name.** In the bare `git checkout <tok>...`
  form, each positional that `git rev-parse` resolves to a commit is treated as a ref
  switch (git self-guards) rather than a discard. So a pathspec whose name is ALSO a
  live ref (`git checkout <name-that-is-both>`) ref-resolves and is not treated as a
  discard, even when it would overwrite that path's uncommitted changes.
- **Untracked-file collisions.** The op-aware dirty test treats "only untracked =>
  reset/checkout destroys nothing" as true, but a `git reset --hard` /
  `git checkout -f` can overwrite an untracked file that collides with a same-named
  tracked file in the target ref. That specific loss is not caught, so "only
  untracked" is a heuristic, not a proof.
- **Exotic argv forms.** `git checkout --pathspec-from-file=<f>` (pathspecs read
  from a file, never on argv), unambiguous long-option abbreviations git accepts
  (e.g. `git reset --har` for `--hard`, which the classifier matches only in full),
  and combined branch-create-and-switch spellings like `-fb <name>` (the clustered
  form of the `-f -b` discard this guard blocks in separate-token form) are outside
  the classifier's recognized forms.

**This list is illustrative, not exhaustive.** A string-scanning accelerator over a
Turing-complete shell has an open-ended bypass surface by construction — which is
precisely why it is fail-open and paired with the Lean-Core rule. None of these is a
defense against a determined bypass; the hook's job is to catch the *accidental*
dirty-tree destruction that has actually bitten this repo
([#114](https://github.com/wrburgess/ai-config/issues/114),
[#134](https://github.com/wrburgess/ai-config/issues/134)), and to hand every other
case to the rule.
