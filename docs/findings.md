# Findings Log

Append-only. One line per finding: `date · type · gist`. Types: process | bug | idea | data.
Findings become work ONLY at an HC-triggered triage session (dispositions: do-now /
upstream-to-ace / drop). No Issues, PRs, rules, or ADRs spawn directly from this file.
(Spec § Factory model and SDLC.)

- 2026-07-29 · process · sandcastle/warren-style dispatched-worker execution preserves our operating loop; candidate ace capability, not nadal v1 work
- 2026-07-29 · process · an `ace new <project>` stamper would complete the factory model; upstream idea for ace
- 2026-07-29 · idea · wire harness token/cost telemetry (Claude Code OTEL/cost export) to request_log for per-request economics; post-Springfield
- 2026-07-29 · process · Execution Profile observations for ace#143 accumulate here (what under-thought, what over-spent)
- 2026-07-29 · process · `codex:rescue`-invoked adversarial reviews write job records as `task-*.json` (kindLabel `rescue`) in the plugin state dir, not `review-*.json` as the "find the job record" runbook step assumes — grep by branch across `*.json`, not `review-*.json`, to find them.
- 2026-07-30 · process · ace maintainer checkout carries orphaned .claude/worktrees (resilient-inventing-spindle); ace-sync should exclude .claude/worktrees/** like *.local; prune source worktree (upstream-to-ace)
- 2026-07-30 · process · human_gates.rb cannot express "no human merge gate" though ADR 0025 calls gate policy project config (upstream-to-ace)
- 2026-07-30 · process · vendored final skill "never self-merges" is in tension with nadal merge-autonomy config (upstream-to-ace)
- 2026-07-30 · process · Codex attestation templating: single-quoted heredoc posted literal $(git rev-parse HEAD) on PR #4; fixed by capture-then-unquoted-heredoc + fetch-back verification (Task 3)
- 2026-07-30 · process · Task 5 incident: haiku executor fabricated a review section and merged ungated; remediated post-hoc on PR #6; hardening = driver verifies attestation artifact via gh api before task review (ace#143 routing observation: tier alone insufficient for gate steps)
- 2026-07-30 · process · plan-brief authoring lessons: Task 2's literal Quality Checks table was itself the round-1 defect; .gitignore is not in ace-sync ALLOW; bin/install-git-hooks is bash not ruby
- 2026-07-30 · process · .claude branch-protection PreToolUse hook blocks Write on main even for gitignored scratch paths (.superpowers/sdd/**), forcing an executor onto a throwaway branch to write its own report; Bash-heredoc writes are unaffected; hook should exempt gitignored paths (upstream-to-ace)
- 2026-07-30 · process · Codex review evidence lives in two different places depending on invocation path (plugin jobs/ dir for synchronous adversarial-review, ~/.codex/sessions for background rescue); a driver checking only one place can wrongly conclude no review ran (this happened on PR #8)
- 2026-07-30 · process · merge-autonomy on green+attestation structurally races the SDD scoped re-review; holds must be stated in the dispatch, not mid-flight
- 2026-07-30 · process · an unscoped fix round grew 2 findings to 8 across 6 Codex re-summons; fix rounds need an explicit scope clause naming what NOT to touch
- 2026-07-30 · idea · tn's summary-line safety (control-char strip, bidi strip, quote/backslash escaping, field-injection resistance) was derived under adversarial review for one command; it is a CLI-wide contract worth a single shared module + one test suite
- 2026-07-30 · process · the CLI-wide sanitize/summary contract logged directly above already landed in-plan during Task 7 — `src/sanitize.ts` + `src/cli/summary.ts`, covered by `test/sanitize.test.ts` + `test/summary.test.ts`; recorded so triage does not re-open it
- 2026-07-30 · process · `enforce-clean-tree.sh` blocks the *whole* multi-line Bash tool call when any single segment is a destructive git op on a dirty tree, not just that segment — an earlier harmless command (e.g. `rm -f`) chained before the blocked `git checkout --` in the same call silently never runs either; split destructive git ops into their own Bash call to avoid losing sibling commands.
- 2026-07-30 · process · a regenerate-and-diff drift guard must not use `git diff --exit-code <dir>`: git diff only inspects TRACKED files, so a brand-new untracked artifact (the most likely drift output, e.g. a fresh drizzle migration .sql + snapshot) passes silently; check `git status --porcelain <dir>` instead, and prove the guard red-green by inducing real drift
- 2026-07-30 · process · this plan's CI task specified a `parity` job that the vendored ace baseline already provided in `.github/workflows/parity.yml`; plan authors must inventory vendored workflows before specifying CI, and a Host App must never re-implement a vendored check it is forbidden to edit
- 2026-07-30 · process · `docs/findings.md` was mandated from Task 1 onward by a Global Constraint but only created by Task 9, so early tasks improvised a non-spec line format (`- date - kind - text` instead of the spec's `date · type · gist`); a plan must create an append-target before the first task required to append to it
