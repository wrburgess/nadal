---
date: 2026-08-11
source: the Direction gate on #146, where Option A' was chosen; the five rows are the four PROJECT.md Quality Checks rows plus the seeded tools' node:test suites, which no runner reached before this issue
checks:
  - name: typecheck
    command: npm run typecheck
    requires: node_modules/.bin/tsc
  - name: lint
    command: npm run lint
    requires: node_modules/.bin/eslint
  - name: schema-drift
    command: npm run check:drizzle
    requires: node_modules/.bin/drizzle-kit
  - name: tools-tests
    command: npm run test:tools
  - name: tests
    command: npm run test:coverage
    requires: node_modules/.bin/vitest
---

# The quality gate

What nadal runs before work is declared done, and in what order. The rules these values instantiate
are deuce's, at [Chapter 3](https://github.com/wrburgess/deuce/blob/main/sds/03-quality-gate-and-tooling.md) → *The quality gate*, and
are not restated here; this is adaptive configuration under
[Chapter 1](https://github.com/wrburgess/deuce/blob/main/sds/01-lifecycle-and-skills.md) → *The adaptive layer's home*.

## Declaration

- **The gate is `npm run gate`.** The frontmatter above is its only contents.
  [`tools/gate/run.ts`](../tools/gate/run.ts) executes what is declared there and nothing else, in
  the order declared, so the list a reader sees and the list that runs are the same list rather than
  two that agree by convention.
- **A check joins the gate by being added above.** `PROJECT.md` used to carry a second copy of this
  table and `.github/workflows/ci.yml` a third; both are now pointers, and CI runs `npm run gate`.
  That is the whole of *one definition* — three hand-maintained lists agreeing by convention is
  drift waiting to happen, and this repository has the receipts for it.
- **Ordering is deliberate.** `typecheck` first, because a type error makes every later run's output
  noise rather than signal. `tests` last, because it is by far the slowest and there is no reason to
  pay for it before the cheap checks have spoken.

## Fields

| Field | Meaning |
|---|---|
| `name` | What the check is called in the gate's report |
| `command` | Executed as tokens, never through a shell — a command carrying a shell metacharacter is refused before anything runs |
| `requires` | The path the check actually needs — the executable itself, never a directory that usually contains it. Absent means the check needs nothing but the repository |

## Why every command is an `npm run` form

Not house style — a constraint. `argvFromCommand`
([`tools/review/dispatch.ts`](../tools/review/dispatch.ts)) admits only
`/^[A-Za-z0-9._/:=-]+$/` per token and refuses anything else before a single check runs, because
configuration is data and data never reaches an interpreter here. `*` is not in that set, so a
declared command carrying a glob is refused. `test:tools` needs one — `tools/**/*.test.ts` — so the
glob lives inside the npm script, where npm's own shell expands it, and the declared command stays
three safe tokens.

## Why the runner is bare `node`, and why `tools-tests` declares no prerequisite

`npm run gate` is `node tools/gate/run.ts` — Node's own type stripping, no loader. The obvious
alternative was `tsx`, which this repository already depends on for `bin/tn`, and it was wired that
way first. **Measured, and it was wrong:** with `node_modules` moved aside, `tsx` is not on `PATH`,
so `npm run gate` dies with *command not found* before `run.ts` is reached — and the missing
toolchain is precisely the state `requires` exists to report. A gate whose launcher is a
`node_modules` dependency cannot report that `node_modules` is absent. Bare `node` needs nothing
installed, so the STOP path works on a fresh clone. That is why `engines.node` is `>=22.18`: type
stripping is unflagged from that version.

`tools-tests` carries no `requires` for the same reason and it is not an oversight — the seeded
suites import only `node:` builtins and each other, so `node --test` runs them with no toolchain at
all. Every other row shells out to a binary that arrives with `npm install`, and names it.

## What each row covers

| Row | Covers |
|---|---|
| `typecheck` | `tsc --noEmit` over `src`, `test` and `tools` — including `tools/gate` and `tools/review`, whose `exclude` carve-out this issue lifted |
| `lint` | `eslint .`, likewise no longer ignoring the two seeded tool directories |
| `schema-drift` | `drizzle-kit generate` followed by `git status --porcelain drizzle/`, so a schema change with no committed migration fails. `git diff --exit-code` alone would not do: it inspects only *tracked* files, and a brand-new untracked migration is the likeliest drift artifact |
| `tools-tests` | The seeded `tools/gate/` and `tools/review/` suites. They are `node:test` suites, which vitest never discovers — before this issue no runner executed them at all |
| `tests` | The whole vitest suite, including `test/cli-grammar-parity.test.ts`, plus the coverage floor |

**The CLI grammar parity check has no row of its own on purpose.** It is a file in the vitest suite
that `tests` already runs whole; a second explicit invocation would double-run the suite for no new
signal.

## The coverage floor, and what it stopped asserting

The floor is 75% lines / 75% functions, enforced by `vitest.config.ts` thresholds over every file
under `src/` and `tools/`.

Lifting the `tools/gate` + `tools/review` coverage carve-out moved the measured total from **96.83%
to 89.46%** lines: roughly 1,400 lines of seeded source now report 0% under vitest, because their
real tests run under a different runner. **The floor is therefore green while asserting less about
those two directories than the number suggests**, and the only thing that makes it honest is
`tools-tests` above being a gate row and a CI step. Remove that row and the coverage number becomes
a claim about code nothing executes.

## Why `requires` reports rather than repairs

`node_modules` is gitignored, so a fresh clone — and **every new git worktree**, which is how work is
done here — has no toolchain. That state is reported by name, with `bash bin/setup` as the fix, and
**the gate never installs it**. A gate that repairs the tree it is measuring is measuring something
else.

Each row names the executable rather than the directory. The directory is a proxy for the toolchain
and not the toolchain: with `node_modules` present and one binary missing, a directory probe passes,
the command exits 127, and the gate reports *a check failed* when the truth is that it could not run.

## What the prerequisite probe does not reach

`requires` is checked by [`tools/gate/executable.ts`](../tools/gate/executable.ts), which declares
its own blind spot:

| Reached | Not reached |
|---|---|
| Missing path · dangling symlink · directory · present file without execute permission | A file that is executable and still cannot run — wrong binary format, or a shebang naming an absent interpreter |

Nothing short of executing a file decides the second column, so no probe closes it and a deeper one
would only move the proxy. The residue is not misclassified: such a prerequisite passes resolution,
the spawn fails, and the gate records that check `could-not-run`, the rest `not-attempted`, exit 2.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every declared check passed |
| 1 | A check ran and failed |
| 2 | The gate could not run — a missing prerequisite, an unreadable declaration, or a check never reached |

1 and 2 are deliberately distinct: *your code is wrong* and *I could not tell you anything* call for
different responses, and a caller cannot separate them from a bare non-zero.
[`docs/runbooks/quality-gate.md`](../docs/runbooks/quality-gate.md) is the operator's copy.

## What is not here yet

deuce's configuration lint ([Chapter 3](https://github.com/wrburgess/deuce/blob/main/sds/03-quality-gate-and-tooling.md) → *The
configuration lint*) owes a set of checks over this repository's own `config/` and work items —
among them *every `config/` declaration carries a date and a source*, which would read this file's
own frontmatter. None is built here. This list growing is the intended mechanism, not evidence it
was declared too small.
