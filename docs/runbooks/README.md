# Runbooks

One runbook per operational flow; each SOW's manual-test segment cites the runbook it
exercises, and runbooks double as HC post-merge checklists.

## Before the first runbook: get `tn` on your PATH

Every runbook below opens with a bare `tn ...`. On a fresh clone there is no such command — nothing
installs one for you (issue #87):

```sh
npm install
npm link      # from the repo root -- NEVER from a git worktree, which would bind the
              # global `tn` to a throwaway checkout
tn --help     # expect: tn <noun> <verb> <target> [payload] [flags]
```

`npm link` writes a symlink into your global npm prefix, outside this repo, which is why `bin/setup`
prints this step rather than running it. If you would rather install nothing, run `./bin/tn` from the
repo root and read every `tn ...` line below as `./bin/tn ...`.

**The install boundary (issue #111).** `tn`'s default database (`data/nadal.db`), archive root
(`raw/`), reports root (`reports/`), and scorecard-photos root are all anchored to wherever
`src/fs/package-root.ts` itself resolves on disk — i.e. **this checkout**, never the caller's
working directory. `npm link` is the supported install path specifically *because* it links to this
checkout rather than copying it: every `tn` invocation, from anywhere on your machine, still
resolves its module files here and therefore still reads/writes the same `data/nadal.db`, `raw/`,
etc. under this repo. A hypothetical global tarball install (`npm install -g` from a packaged
tarball rather than `npm link`) would instead copy the package into `node_modules` somewhere under
npm's global prefix, and the anchored defaults would then point INSIDE that installed copy — a
different `data/nadal.db` than this checkout's, and one a normal `git status` here would never show
as dirty. `package.json` is `"private": true` with no publish/build step, so this is a boundary
worth naming rather than a currently reachable path — `npm link` is the only shipped, documented
install.

**`npm link` does not touch your `PATH`.** It only creates the symlink; whether your shell finds it
depends on whether npm's global bin directory is already on `PATH`. With a version manager (mise,
nvm, fnm, volta) it normally is. With a custom prefix it may not be, and `npm link` still reports
success — so the next command fails with `command not found: tn` and nothing has told you why:

```sh
tn --help || {
  echo "npm's global bin is not on your PATH; it is: $(npm prefix -g)/bin"
  export PATH="$(npm prefix -g)/bin:$PATH"   # this shell only -- add it to your shell profile to persist
  tn --help
}
```

Verify with `tn --help` before starting anything else — a runbook is not the place to discover the
command is missing.

- [login-assisted-scrape.md](login-assisted-scrape.md) — USTA/WTN pull with HC standing by to log in
- [capture-fixtures.md](capture-fixtures.md) — turn a live page into a committed test fixture; the
  HC-driven variant for login-gated pages, and the refusal loop that is most of the work
- [build-and-print-dossiers.md](build-and-print-dossiers.md) — `tn report build` → browser → courtside binder
- [agent-chat-over-mcp.md](agent-chat-over-mcp.md) — point an agent chat at `tn mcp serve`; capture
  availability and captain notes conversationally
- [predict-an-opponent-lineup.md](predict-an-opponent-lineup.md) — `tn lineup plan` → read the guess
  critically; record availability behind `tn event add`
- [in-event-screenshot-ingest.md](in-event-screenshot-ingest.md) — scorecard photo → agent →
  `match_add` → verified rows → what to do when a name is flagged
- [db-migration-recovery.md](db-migration-recovery.md) — `tn db migrate` fails on an existing
  database; the one-line recovery and why losing the database costs nothing by design
- [pre-tournament-full-pull.md](pre-tournament-full-pull.md) — refresh every scouted team end to
  end: live TennisRecord pulls, the human-in-the-loop USTA/WTN path, and the TennisLink hole (#27)
  none of it closes
- [backup-restore.md](backup-restore.md) — `sqlite3 .backup`/`.restore` drill against the database
  `tn` actually ships today (no `tn db backup`/`db restore` command exists yet)
