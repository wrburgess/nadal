# Runbook: run the quality gate

## When to use this

Before declaring any work done, and any time you want to know whether this checkout is green.
**One command: `npm run gate`.** It runs what [`config/checks.md`](../../config/checks.md) declares,
in the order declared, and nothing else. CI runs the same command on every pull request and every
push to `main`, so a green gate locally and a green build mean the same thing (#146).

Unlike most runbooks here, this one needs no database, no `TN_DB_PATH`, and no `tn` on your `PATH`
— it is about the repository, not the data.

## Before you start

- `npm install` has been run **in this checkout**. Every git worktree is its own checkout with its
  own (gitignored) `node_modules`, so a fresh worktree has no toolchain until you install one. The
  gate detects that state and names it rather than failing confusingly — see *Reading the output*.
- Nothing else. `bash bin/setup` is the one-step version if you also want the git hooks active.

## Steps

### 1. Run it

```sh
npm run gate
```

Expect, on a green tree:

```
pass  typecheck  (npm run typecheck)
pass  lint  (npm run lint)
pass  schema-drift  (npm run check:drizzle)
pass  tools-tests  (npm run test:tools)
pass  tests  (npm run test:coverage)
gate green — 5 checks, declared in config/checks.md
```

**Every declared check gets a line, always**, whatever became of it — including the ones that never
ran. A report that listed only what executed would let a short run read as a whole one.

### 2. Read the exit code, not just the output

The distinction between 1 and 2 is the whole point, and a bare "non-zero" loses it:

| Exit | Line prefix | Meaning | What to do |
|---|---|---|---|
| 0 | `pass` | Every declared check passed | Nothing |
| 1 | `FAIL` | A check ran and failed | Read that check's own output above the summary; fix the code |
| 2 | `STOP` | This check could not be executed | Fix the environment, not the code |
| 2 | `skip` | This check was never reached | Nothing directly — something before it stopped the run |

`STOP` and `skip` are deliberately different states. *Could not run* and *never got the chance* have
different fixes, and collapsing them is the defect the gate's result representation was rebuilt to
remove.

```sh
npm run gate; echo "exit=$?"
```

### 3. When it says `STOP`

`STOP` means the gate is reporting its own unreadiness. The commonest cause is a checkout with no
`node_modules` — a fresh clone, or a new worktree. Every prerequisite is resolved **before anything
executes**, so you get the whole list at once rather than one failure at a time:

```
STOP  typecheck  (npm run typecheck) — requires 'node_modules/.bin/tsc', which is missing — run `bash bin/setup`. …
STOP  lint  (npm run lint) — requires 'node_modules/.bin/eslint', which is missing — run `bash bin/setup`. …
STOP  schema-drift  (npm run check:drizzle) — requires 'node_modules/.bin/drizzle-kit', which is missing — …
skip  tools-tests  (npm run test:tools)
STOP  tests  (npm run test:coverage) — requires 'node_modules/.bin/vitest', which is missing — …
```

(`tools-tests` reads `skip` rather than `STOP`: it declares no prerequisite and could have run, but
nothing executes once resolution has failed. Transcribed from an actual run, not composed.)

Run `npm install` (or `bash bin/setup`) and try again. **The gate never installs anything itself**:
a gate that repairs the tree it is measuring is measuring something else, and its green stops
meaning what it says.

This path only works because `npm run gate` is bare `node`. It was `tsx` in the first draft of this
work, and `tsx` lives in `node_modules` — so on the very checkout this section is about, the gate
died with *tsx: command not found* instead of reporting anything.

The other exit-2 shape is a declaration the gate cannot read at all. It prints one line and no check
report, because there was no list of checks to report on. Both of these are transcribed from real
runs:

```
the gate could not run — config/checks.md: frontmatter line 5 is outside the declared subset and is refused: oops a stray line
the gate could not run — config/checks.md: a check declares no name
```

That is a syntax error in [`config/checks.md`](../../config/checks.md)'s frontmatter. The parser
refuses what it does not recognise rather than skipping it — the first message names the offending
line; the second is what a **mistyped field key** looks like (`nmae:` instead of `name:`), which is
well-formed enough to parse as an entry and then fails the schema. A parser that skipped either one
would return something plausible and wrong, and the gate would run a shorter list than the file
appears to declare.

### 4. Running one check by hand

Every gate row is an ordinary npm script, so you can run any of them alone while iterating:

```sh
npm run typecheck
npm run lint
npm run check:drizzle
npm run test:tools      # the tools/gate + tools/review node:test suites
npm run test:coverage   # the vitest suite plus the coverage floor
```

This is for iterating only. **`npm run gate` is what "green" means** — a hand-run subset says
nothing about the rows you did not run.

## Adding or removing a check

Edit the frontmatter of [`config/checks.md`](../../config/checks.md). There is no second place:
`PROJECT.md` and `.github/workflows/ci.yml` are pointers, not copies.

Two constraints worth knowing before you write a row:

- **No shell.** Commands are tokenized to argv and executed directly, and a token carrying anything
  outside `A-Za-z0-9._/:=-` is refused before any check runs. That is why every row is an
  `npm run <script>` form — a glob or a pipe lives inside the npm script, never in the declaration.
- **`requires` names the executable**, not the directory that usually holds it. `node_modules` being
  present tells you nothing about whether `tsc` is in it.

## What this does not tell you

- **Green is not "correct."** The gate runs the checks that exist. It reads no prose: a runbook, a
  comment, or a `PROJECT.md` claim that a change has falsified passes green, and this repository has
  the receipts for that failure mode.
- **The coverage percentage asserts less than it looks like.** `tools/gate` and `tools/review` are
  inside the coverage total and report 0%, because their tests are `node:test` suites vitest cannot
  discover — they run under `tools-tests` instead. The floor is honest only while that row is in the
  gate. See [`config/checks.md`](../../config/checks.md) → *The coverage floor*.
