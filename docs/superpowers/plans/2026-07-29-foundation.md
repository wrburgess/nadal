# nadal Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the nadal repo: vendored ace baseline, customized project config, TypeScript scaffold with the `tn` CLI skeleton, database schema, request telemetry, CI, anti-bloat seeds, and the GitHub work queue — everything Phase-2+ SOWs need to start.

**Architecture:** ace is vendored as plain files (ace ADR 0001) with `PROJECT.md` as the customization surface. The app is TypeScript/ESM: a service layer under `src/`, thin CLI presenter (`tn`) with a registry-driven router, SQLite via drizzle, vitest for TDD. The CLI grammar lives in `docs/cli/GRAMMAR.md` and a parity test keeps code and doc identical.

**Tech Stack:** Node ≥22, TypeScript (strict, ESM), better-sqlite3 + drizzle-orm/drizzle-kit, vitest + @vitest/coverage-v8, eslint + typescript-eslint, tsx, Playwright (installed later, Phase 2+).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-nadal-v1-springfield-design.md` — this plan implements its Phases 0–1.
- Node `>=22`; `"type": "module"`; TypeScript `strict: true`.
- CLI grammar: `tn <noun> <verb> <target> [payload] [flags]`; one spelling per operation; GNU flags (`--long`/`-s`, max one short alias); global flags only `--quiet/-q`, `--json`, `--help`.
- Every command prints one deterministic `key=value` summary line to stdout and exits non-zero on failure.
- TDD: red before green — run each failing test and see it fail before implementing.
- Commits on feature branches; PR per branch; attribution trailer per `PROJECT.md` § Attribution (executor default: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`; use the runtime-actual model).
- Model routing (spec § Model routing): task execution at Sonnet/high unless noted; never Fable.
- No self-improvement PRs: anything process-shaped discovered during execution is one line in `docs/findings.md`, appended within the task's PR.
- DB path: `TN_DB_PATH` env var, default `data/nadal.db`; tests always set `TN_DB_PATH` to a temp path, never touch the default.

---

### Task 1: Vendor the ace baseline

**Files:**
- Create: (entire vendored bundle — `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `PROJECT.md`, `CONTEXT.md`, `.github/`, `.claude/`, `.githooks/`, `bin/`, `skills/`, `rules/`, `docs/` additions, `scripts/`)
- Create: `docs/ace-sync-manifest.md`

**Interfaces:**
- Produces: vendored `scripts/parity_check.rb` (CI calls it), `bin/install-git-hooks`, `PROJECT.md` (Task 2 customizes it), branch-protection hooks all later tasks obey.

- [ ] **Step 1: Get an ace checkout and record its SHA**

```bash
ls /Users/wrburgess/Projects/aaa/ace 2>/dev/null || git clone git@github.com:wrburgess/ace.git /Users/wrburgess/Projects/aaa/ace
cd /Users/wrburgess/Projects/aaa/ace && git pull && ACE_SHA=$(git rev-parse HEAD) && echo "$ACE_SHA"
```

- [ ] **Step 2: Create the branch in nadal**

```bash
cd /Users/wrburgess/Projects/aaa/nadal && git checkout -b chore/vendor-ace-baseline
```

- [ ] **Step 3: Dry-run the sync and review the plan output**

```bash
ruby /Users/wrburgess/Projects/aaa/ace/bin/ace-sync --dry-run --from /Users/wrburgess/Projects/aaa/ace /Users/wrburgess/Projects/aaa/nadal
```

Expected: a copy plan listing the ALLOW surfaces; no writes.

- [ ] **Step 4: Run the sync for real**

```bash
ruby /Users/wrburgess/Projects/aaa/ace/bin/ace-sync --from /Users/wrburgess/Projects/aaa/ace /Users/wrburgess/Projects/aaa/nadal
```

- [ ] **Step 5: Write the manifest**

Create `docs/ace-sync-manifest.md`:

```markdown
# ace-sync manifest

nadal vendors the ace baseline (factory model — spec § Factory model and SDLC).
Re-sync: `ruby <ace>/bin/ace-sync --from <ace> <nadal>`, then reconcile via `git diff`
(PROJECT.md and bin/setup are preserved automatically).

| Date | ace SHA | Notes |
|------|---------|-------|
| 2026-07-29 | <ACE_SHA from Step 1> | Initial vendoring |

Known local deltas reapplied after any re-sync:
- `.claude/settings.json` — model pin (Task 3)
```

- [ ] **Step 6: Verify parity is green**

```bash
ruby scripts/parity_check.rb
```

Expected: exit 0.

- [ ] **Step 7: Install the git hooks**

```bash
bash bin/install-git-hooks 2>/dev/null || ruby bin/install-git-hooks
git config core.hooksPath   # expected: .githooks
```

- [ ] **Step 8: Commit and open the PR**

```bash
git add -A
git commit -m "chore: vendor ace baseline (ace <ACE_SHA short>)"
git push -u origin chore/vendor-ace-baseline
gh pr create --title "Vendor ace baseline" --body "Vendors the ace Generic Baseline at <ACE_SHA>. Part of #1.

Baseline ships ungated to merge per ace ADR 0029 (reviewer wiring arrives in this PR).

— Claude Code (Sonnet 5)"
```

- [ ] **Step 9: Merge ungated (ace ADR 0029) and clean up**

```bash
gh pr merge --squash --delete-branch
git checkout main && git pull
```

---

### Task 2: Customize PROJECT.md

**Files:**
- Modify: `PROJECT.md` (the designed customization surface — this is the ONE vendored file hosts edit)

**Interfaces:**
- Produces: Quality Checks table (CI and skills read it), Reviewer chain (verify/merge gate reads it), `## Execution Profile` section (all sessions read it).

- [ ] **Step 1: Branch**

```bash
git checkout -b chore/project-config
```

- [ ] **Step 2: Replace the Quality Checks table**

In `PROJECT.md` § Quality Checks, replace the shipped rows with:

```markdown
| Purpose | Command |
|---------|---------|
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Tests + coverage floor | `npm run test:coverage` |
| Structural parity | `ruby scripts/parity_check.rb` |
| CLI grammar parity | `npm test -- test/cli-grammar-parity.test.ts` |
```

(Tasks 4–6 create these commands; until they exist, the parity rows are the effective gate.)

- [ ] **Step 3: Set Branch & PR Policy protected list**

Change the protected-branches backticked list to `main` only, then regenerate the sidecar:

```bash
ruby bin/install-git-hooks
cat .githooks/protected-branches   # expected: main
```

- [ ] **Step 4: Confirm Attribution declares Claude Opus 5 for Claude Code**

The vendored default already reads `Claude Opus 5` — keep it (nadal's ceiling). No edit unless it differs.

- [ ] **Step 5: Set the Reviewer chain**

In § Reviewer: Primary `Codex` (the vendored real mechanism, ace ADR 0035), Fallback `none`, Bounded window `30m`, floor `stop-and-ask` (fixed). In § Human Gates (if present): set merge gate to none — record: "AC merges after green Quality Checks + adversarial second-model review (SHA-bound). No human merge gate (HC decision 2026-07-29)."

- [ ] **Step 6: Add the Execution Profile section (additive — parity-safe)**

Append:

```markdown
## Execution Profile

Per-step model/effort routing (spec § Model routing; proving ground for ace#143).
Ceiling: **Opus / high** — Fable only on explicit HC invocation.
Executable at delegation boundaries (`.claude/agents/*.md`, subagent spawns) and via the
project model pin; step-level routing inside one session is advisory.

| Step | Model / effort |
|------|----------------|
| Driver sessions (grilling, planning, judgment) | Opus / high |
| SOW execution (TDD implement) | Sonnet / high; escalate to Opus when stuck, noted on the issue |
| Mechanical (scaffolds, fixture capture, writeups, findings appends) | Haiku or Sonnet / low |
| Adversarial PR review | GPT family via Codex / high |
| AFK research | Sonnet / medium |
```

- [ ] **Step 7: Verify parity, commit, PR, adversarial review, merge**

```bash
ruby scripts/parity_check.rb   # expected: exit 0
git add PROJECT.md .githooks/protected-branches
git commit -m "chore: customize PROJECT.md for nadal (quality checks, reviewer, execution profile)"
git push -u origin chore/project-config
gh pr create --title "Customize PROJECT.md" --body "Quality checks, protected=main, Reviewer=Codex, Execution Profile v0. Part of #1."
```

Summon the Codex reviewer on the PR per `skills/verify/SKILL.md`; address findings; merge on green + attested review:

```bash
gh pr merge --squash --delete-branch && git checkout main && git pull
```

(From this task on, **every** PR follows this same verify → review → merge tail; later tasks say "PR, review, merge" to mean exactly this block.)

---

### Task 3: Project-local layer — model pin and role agents

**Files:**
- Modify: `.claude/settings.json` (known local delta — recorded in the manifest)
- Create: `.claude/agents/executor.md`, `.claude/agents/mechanic.md`, `.claude/agents/researcher.md`

**Interfaces:**
- Produces: agent roles `executor` (sonnet), `mechanic` (haiku), `researcher` (sonnet) for subagent-driven execution of all later work.

- [ ] **Step 1: Branch**

```bash
git checkout -b chore/model-routing-layer
```

- [ ] **Step 2: Pin the project default model**

In `.claude/settings.json`, merge (preserving vendored hook config):

```json
{
  "model": "opus"
}
```

- [ ] **Step 3: Create the three role agents**

`.claude/agents/executor.md`:

```markdown
---
name: executor
description: Implements one SOW task with strict TDD (red before green). Use for all implementation work.
model: sonnet
---

You implement exactly one task from an implementation plan. Follow the task's steps in order.
Write the failing test first and RUN it to see it fail before implementing. Never widen scope
beyond the task. Follow PROJECT.md Quality Checks before declaring done. Anything process-shaped
you notice goes as one line into docs/findings.md, not into extra changes.
```

`.claude/agents/mechanic.md`:

```markdown
---
name: mechanic
description: Mechanical, low-judgment steps — scaffolding, file moves, fixture capture, findings appends, report/SOW boilerplate.
model: haiku
---

You perform mechanical steps exactly as specified. No design decisions: if a step requires
judgment or deviation, stop and report back instead of improvising.
```

`.claude/agents/researcher.md`:

```markdown
---
name: researcher
description: AFK research tickets — reading docs/sites and reporting facts with citations. No code changes.
model: sonnet
---

You research and report facts with sources. You never modify the repository.
Return findings as structured notes the driver can paste into the ticket.
```

- [ ] **Step 4: Commit, PR, review, merge**

```bash
git add .claude
git commit -m "chore: pin project model and add role agents per Execution Profile"
git push -u origin chore/model-routing-layer
gh pr create --title "Model routing layer" --body "Project model pin + executor/mechanic/researcher role agents. Part of #1."
```

Then the standard review/merge tail (Task 2 Step 7).

---

### Task 4: TypeScript scaffold and the `tn` router (TDD)

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore` additions, `bin/tn`, `src/cli/main.ts`, `src/cli/router.ts`
- Test: `test/cli-router.test.ts`

**Interfaces:**
- Produces: `COMMANDS: Command[]` registry in `src/cli/router.ts` — `type Command = { noun: string; verb: string; summary: string; run: (args: string[]) => Promise<number> }`; `dispatch(argv: string[]): Promise<number>`; `helpText(): string`. Later tasks register commands by adding to `COMMANDS`.

- [ ] **Step 1: Branch**

```bash
git checkout -b feature/ts-scaffold-router
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "nadal",
  "version": "0.1.0",
  "private": true,
  "description": "USTA tennis scouting and lineup planning (v1: Springfield Sectionals). CLI: tn.",
  "type": "module",
  "bin": { "tn": "bin/tn" },
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "better-sqlite3": "^12.2.0",
    "drizzle-orm": "^0.45.2",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.30.0",
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.15.0",
    "@vitest/coverage-v8": "^3.2.0",
    "drizzle-kit": "^0.31.1",
    "eslint": "^9.30.0",
    "tsx": "^4.20.0",
    "typescript": "^5.8.3",
    "typescript-eslint": "^8.35.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "test", "vitest.config.ts", "eslint.config.js", "drizzle.config.ts"]
}
```

- [ ] **Step 4: Write eslint.config.js**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", "drizzle/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

- [ ] **Step 5: Write vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { lines: 75, functions: 75 },
    },
  },
});
```

- [ ] **Step 6: Write bin/tn and .gitignore additions**

`bin/tn`:

```sh
#!/bin/sh
DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$DIR/node_modules/.bin/tsx" "$DIR/src/cli/main.ts" "$@"
```

```bash
chmod +x bin/tn
printf 'node_modules/\ndist/\ncoverage/\ndata/\nraw/\n' >> .gitignore
```

- [ ] **Step 7: Install dependencies**

```bash
npm install
```

- [ ] **Step 8: Write the failing router test**

`test/cli-router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { COMMANDS, dispatch, helpText } from "../src/cli/router.js";

describe("tn router", () => {
  it("helpText lists every registered command as 'noun verb — summary'", () => {
    const help = helpText();
    for (const c of COMMANDS) {
      expect(help).toContain(`${c.noun} ${c.verb}`);
    }
  });

  it("dispatch returns 2 and prints an error line for an unknown command", async () => {
    const code = await dispatch(["bogus", "nope"]);
    expect(code).toBe(2);
  });

  it("dispatch of --help returns 0", async () => {
    const code = await dispatch(["--help"]);
    expect(code).toBe(0);
  });

  it("has no duplicate noun+verb spellings", () => {
    const keys = COMMANDS.map((c) => `${c.noun} ${c.verb}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 9: Run it to make sure it fails**

```bash
npx vitest run test/cli-router.test.ts
```

Expected: FAIL — cannot resolve `../src/cli/router.js`.

- [ ] **Step 10: Implement the router**

`src/cli/router.ts`:

```ts
export type Command = {
  noun: string;
  verb: string;
  summary: string;
  run: (args: string[]) => Promise<number>;
};

export const COMMANDS: Command[] = [];

export function helpText(): string {
  const lines = ["tn <noun> <verb> <target> [payload] [flags]", ""];
  for (const c of COMMANDS) {
    lines.push(`  tn ${c.noun} ${c.verb.padEnd(8)} ${c.summary}`);
  }
  lines.push("", "Global flags: --quiet/-q  --json  --help");
  return lines.join("\n");
}

export async function dispatch(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help") {
    console.log(helpText());
    return 0;
  }
  const [noun, verb, ...rest] = argv;
  const cmd = COMMANDS.find((c) => c.noun === noun && c.verb === verb);
  if (!cmd) {
    console.error(`error: unknown command "tn ${noun} ${verb ?? ""}".`.trim() + ` Run tn --help`);
    return 2;
  }
  return cmd.run(rest);
}
```

`src/cli/main.ts`:

```ts
import { dispatch } from "./router.js";

const code = await dispatch(process.argv.slice(2));
process.exit(code);
```

- [ ] **Step 11: Run tests, typecheck, lint — all green**

```bash
npx vitest run test/cli-router.test.ts && npm run typecheck && npm run lint
```

Expected: PASS / clean.

- [ ] **Step 12: Smoke the binary**

```bash
./bin/tn --help
```

Expected: usage line + global flags, exit 0.

- [ ] **Step 13: Commit, PR, review, merge**

```bash
git add -A
git commit -m "feat: TypeScript scaffold and tn router skeleton"
git push -u origin feature/ts-scaffold-router
gh pr create --title "tn scaffold + router" --body "TS/ESM scaffold, vitest, eslint, registry router with help/dispatch. Part of #1."
```

Standard review/merge tail.

---

### Task 5: CLI grammar doc and parity test (TDD)

**Files:**
- Create: `docs/cli/GRAMMAR.md`
- Test: `test/cli-grammar-parity.test.ts`

**Interfaces:**
- Consumes: `COMMANDS` from `src/cli/router.ts` (Task 4).
- Produces: `docs/cli/GRAMMAR.md` — the authored grammar; the parity test that makes it binding.

- [ ] **Step 1: Branch**

```bash
git checkout -b feature/cli-grammar-parity
```

- [ ] **Step 2: Write docs/cli/GRAMMAR.md**

````markdown
# tn CLI Grammar

`tn <noun> <verb> <target> [payload] [flags]` — one spelling per operation; the entire surface
fits this table. Targets: bare text = name lookup; `usta:`, `wtn:`, `tr:` prefixes select an ID
namespace. Ambiguous names error with candidates listed — never guess. Global flags only:
`--quiet/-q`, `--json`, `--help`. GNU flag style, max one short alias per flag. Every command
prints one deterministic `key=value` summary line; non-zero exit on failure.

The parity test (`test/cli-grammar-parity.test.ts`) fails CI when this table and the router's
registry diverge — in either direction.

## Commands

| Command | Summary |
|---------|---------|
| `tn db migrate` | Apply pending schema migrations |

Planned (spec § Interfaces; rows move up as commands land): `team pull/show/list`,
`player pull/show/note/list`, `match add`, `event show`, `lineup plan`, `report build`,
`db backup/restore`.
````

- [ ] **Step 3: Write the failing parity test**

`test/cli-grammar-parity.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli/router.js";

function grammarRows(): string[] {
  const md = readFileSync("docs/cli/GRAMMAR.md", "utf8");
  const section = md.split("## Commands")[1] ?? "";
  const rows: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\|\s*`tn ([a-z]+) ([a-z]+)[^`]*`\s*\|/.exec(line);
    if (m) rows.push(`${m[1]} ${m[2]}`);
  }
  return rows;
}

describe("grammar parity", () => {
  it("every registered command appears in GRAMMAR.md", () => {
    const rows = grammarRows();
    for (const c of COMMANDS) {
      expect(rows, `tn ${c.noun} ${c.verb} missing from GRAMMAR.md`).toContain(`${c.noun} ${c.verb}`);
    }
  });

  it("every GRAMMAR.md row is a registered command", () => {
    const keys = new Set(COMMANDS.map((c) => `${c.noun} ${c.verb}`));
    for (const row of grammarRows()) {
      expect(keys, `GRAMMAR.md row "tn ${row}" not implemented`).toContain(row);
    }
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

```bash
npx vitest run test/cli-grammar-parity.test.ts
```

Expected: FAIL — GRAMMAR.md lists `db migrate` but `COMMANDS` is empty. (This failure is Task 6's opening state; the pair lands together in this branch's PR only if Task 6 is folded in — otherwise proceed to Step 5.)

- [ ] **Step 5: Make it pass minimally — placeholder-free**

Remove the `tn db migrate` row from the table (leave the header and the Planned paragraph). Re-run:

```bash
npx vitest run test/cli-grammar-parity.test.ts
```

Expected: PASS (both directions vacuously true but structurally exercised by the empty registry).

- [ ] **Step 6: Commit, PR, review, merge**

```bash
git add docs/cli/GRAMMAR.md test/cli-grammar-parity.test.ts
git commit -m "feat: CLI grammar doc with two-way parity test"
git push -u origin feature/cli-grammar-parity
gh pr create --title "CLI grammar parity ratchet" --body "GRAMMAR.md + two-way parity test; commands must land in both places. Part of #1."
```

Standard review/merge tail.

---

### Task 6: Schema and `tn db migrate` (TDD)

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`, `src/cli/commands/db-migrate.ts`, generated `drizzle/` SQL migrations
- Modify: `src/cli/router.ts` (register command), `docs/cli/GRAMMAR.md` (add row)
- Test: `test/db-migrate.test.ts`

**Interfaces:**
- Consumes: `COMMANDS` registry (Task 4).
- Produces: `openDb(path?: string): { db: BetterSQLite3Database; sqlite: Database.Database }` from `src/db/client.ts`; `runMigrations(dbPath: string): void`; all nine domain tables + `request_log`.

- [ ] **Step 1: Branch**

```bash
git checkout -b feature/schema-db-migrate
```

- [ ] **Step 2: Write the failing migration test**

`test/db-migrate.test.ts`:

```ts
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/client.js";

const EXPECTED_TABLES = [
  "players", "player_aliases", "teams", "team_memberships", "events",
  "team_matches", "court_matches", "court_match_players",
  "rating_observations", "availability", "captain_notes", "request_log",
];

describe("tn db migrate", () => {
  it("creates every table in the domain model plus request_log", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
    runMigrations(dbPath);
    const sqlite = new Database(dbPath);
    const names = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%drizzle%' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
    sqlite.close();
  });

  it("is idempotent — running twice changes nothing and does not throw", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
    runMigrations(dbPath);
    expect(() => runMigrations(dbPath)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
npx vitest run test/db-migrate.test.ts
```

Expected: FAIL — `runMigrations` not exported.

- [ ] **Step 4: Write the schema**

`src/db/schema.ts`:

```ts
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  canonicalName: text("canonical_name").notNull(),
  ustaUaid: text("usta_uaid").unique(),
  wtnTennisId: text("wtn_tennis_id").unique(),
  trNameKey: text("tr_name_key"),
  ageRange: text("age_range"),
  gender: text("gender"),
});

export const playerAliases = sqliteTable("player_aliases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  alias: text("alias").notNull(),
}, (t) => [uniqueIndex("player_alias_unique").on(t.playerId, t.alias)]);

export const teams = sqliteTable("teams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),          // e.g. IA/Versteeg/40&Over3.5M
  section: text("section"),
  district: text("district"),
  tennislinkUrl: text("tennislink_url"),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),          // e.g. Sectionals 2026 (Springfield)
  kind: text("kind").notNull(),                   // league | tournament
  format: text("format", { mode: "json" }),       // court slots, pools/rr, per spec: format is data
  startsOn: text("starts_on"),
  endsOn: text("ends_on"),
});

export const teamMemberships = sqliteTable("team_memberships", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  teamId: integer("team_id").notNull().references(() => teams.id),
  eventId: integer("event_id").references(() => events.id),
}, (t) => [uniqueIndex("membership_unique").on(t.playerId, t.teamId, t.eventId)]);

export const teamMatches = sqliteTable("team_matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").references(() => events.id),
  homeTeamId: integer("home_team_id").notNull().references(() => teams.id),
  visitingTeamId: integer("visiting_team_id").notNull().references(() => teams.id),
  playedOn: text("played_on"),
  sourceMatchId: text("source_match_id"),         // TennisLink match id when known
  homeCourtsWon: integer("home_courts_won"),
  visitingCourtsWon: integer("visiting_courts_won"),
});

export const courtMatches = sqliteTable("court_matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamMatchId: integer("team_match_id").references(() => teamMatches.id),
  slot: text("slot").notNull(),                   // S1 | D1 | D2 | D3 | D4
  discipline: text("discipline").notNull(),       // singles | doubles
  winnerSide: text("winner_side"),                // home | visiting
  score: text("score"),                           // e.g. "6-3 1-6 1-0"
  leagueContext: text("league_context"),          // source league/flight when outside a known event
  playedOn: text("played_on"),
});

export const courtMatchPlayers = sqliteTable("court_match_players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  courtMatchId: integer("court_match_id").notNull().references(() => courtMatches.id),
  playerId: integer("player_id").notNull().references(() => players.id),
  side: text("side").notNull(),                   // home | visiting
}, (t) => [uniqueIndex("court_match_player_unique").on(t.courtMatchId, t.playerId)]);

export const ratingObservations = sqliteTable("rating_observations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  source: text("source").notNull(),               // ntrp | wtn_singles | wtn_doubles | tr_dynamic
  value: real("value").notNull(),
  ratingType: text("rating_type"),                // NTRP: C | S | A | D | M
  observedOn: text("observed_on").notNull(),
}, (t) => [uniqueIndex("rating_obs_unique").on(t.playerId, t.source, t.observedOn)]);

export const availability = sqliteTable("availability", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  eventId: integer("event_id").notNull().references(() => events.id),
  day: text("day").notNull(),                     // ISO date
  status: text("status").notNull(),               // available | unavailable | uncertain
}, (t) => [uniqueIndex("availability_unique").on(t.playerId, t.eventId, t.day)]);

export const captainNotes = sqliteTable("captain_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull().references(() => players.id),
  pairPlayerId: integer("pair_player_id").references(() => players.id), // set = note about a pairing
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
});

export const requestLog = sqliteTable("request_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  surface: text("surface").notNull(),             // cli | mcp
  command: text("command").notNull(),             // e.g. "player pull"
  args: text("args"),                             // sanitized JSON
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  outcome: text("outcome"),                       // ok | error:<class>
});
```

- [ ] **Step 5: Write drizzle.config.ts and generate migrations**

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

```bash
npx drizzle-kit generate
git add drizzle/
```

- [ ] **Step 6: Write the client**

`src/db/client.ts`:

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DB_PATH = "data/nadal.db";

export function dbPath(): string {
  return process.env.TN_DB_PATH ?? DEFAULT_DB_PATH;
}

export function openDb(path: string = dbPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { sqlite, db: drizzle(sqlite) };
}

export function runMigrations(path: string = dbPath()): void {
  const { db, sqlite } = openDb(path);
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.close();
}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run test/db-migrate.test.ts
```

Expected: PASS (both tests).

- [ ] **Step 8: Register the CLI command and grammar row**

`src/cli/commands/db-migrate.ts`:

```ts
import type { Command } from "../router.js";
import { dbPath, runMigrations } from "../../db/client.js";

export const dbMigrate: Command = {
  noun: "db",
  verb: "migrate",
  summary: "Apply pending schema migrations",
  run: async () => {
    runMigrations();
    console.log(`db migrate status=ok path=${dbPath()}`);
    return 0;
  },
};
```

In `src/cli/router.ts`, change the registry line to:

```ts
import { dbMigrate } from "./commands/db-migrate.js";

export const COMMANDS: Command[] = [dbMigrate];
```

(Move the `import` to the top of the file. If this creates a cycle because `Command` lives in `router.ts`, extract `Command` to `src/cli/command.ts` and import it from both — keep `COMMANDS` in `router.ts`.)

In `docs/cli/GRAMMAR.md` § Commands, restore the row:

```markdown
| `tn db migrate` | Apply pending schema migrations |
```

- [ ] **Step 9: Full suite green (router, grammar parity, migrate)**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: all PASS — grammar parity now proves the two-way ratchet with a real command.

- [ ] **Step 10: Smoke it**

```bash
TN_DB_PATH=/tmp/tn-smoke.db ./bin/tn db migrate
```

Expected: `db migrate status=ok path=/tmp/tn-smoke.db`, exit 0.

- [ ] **Step 11: Commit, PR, review, merge**

```bash
git add -A
git commit -m "feat: domain schema, migrations, and tn db migrate"
git push -u origin feature/schema-db-migrate
gh pr create --title "Schema + tn db migrate" --body "Nine domain tables + request_log via drizzle; first real tn command. Part of #1."
```

Standard review/merge tail.

---

### Task 7: Request telemetry middleware (TDD)

**Files:**
- Create: `src/telemetry/request-log.ts`
- Modify: `src/cli/router.ts` (wrap dispatch)
- Test: `test/request-log.test.ts`

**Interfaces:**
- Consumes: `openDb`, `runMigrations` (Task 6); `COMMANDS`/`dispatch` (Task 4).
- Produces: `logRequest(surface: "cli" | "mcp", command: string, args: string[], fn: () => Promise<number>): Promise<number>` — later MCP tools (Phase 5) wrap through the same function.

- [ ] **Step 1: Branch**

```bash
git checkout -b feature/request-telemetry
```

- [ ] **Step 2: Write the failing test**

`test/request-log.test.ts`:

```ts
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/client.js";
import { logRequest } from "../src/telemetry/request-log.js";

let dbPath: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
  process.env.TN_DB_PATH = dbPath;
  runMigrations(dbPath);
});

afterEach(() => {
  delete process.env.TN_DB_PATH;
});

function rows() {
  const sqlite = new Database(dbPath);
  const r = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
  sqlite.close();
  return r;
}

describe("request telemetry", () => {
  it("logs surface, command, args, timestamps, and ok outcome", async () => {
    const code = await logRequest("cli", "db migrate", ["--quiet"], async () => 0);
    expect(code).toBe(0);
    const [row] = rows();
    expect(row).toMatchObject({ surface: "cli", command: "db migrate", outcome: "ok" });
    expect(row?.started_at).toBeTruthy();
    expect(row?.ended_at).toBeTruthy();
    expect(JSON.parse(String(row?.args))).toEqual(["--quiet"]);
  });

  it("records error outcome and still returns the exit code when fn throws", async () => {
    const code = await logRequest("cli", "db migrate", [], async () => {
      throw new Error("boom");
    });
    expect(code).toBe(1);
    const [row] = rows();
    expect(String(row?.outcome)).toMatch(/^error:/);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
npx vitest run test/request-log.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/telemetry/request-log.ts`:

```ts
import { openDb } from "../db/client.js";
import { requestLog } from "../db/schema.js";

export async function logRequest(
  surface: "cli" | "mcp",
  command: string,
  args: string[],
  fn: () => Promise<number>,
): Promise<number> {
  const startedAt = new Date().toISOString();
  let outcome = "ok";
  let code: number;
  try {
    code = await fn();
    if (code !== 0) outcome = `error:exit-${code}`;
  } catch (err) {
    outcome = `error:${err instanceof Error ? err.constructor.name : "unknown"}`;
    code = 1;
  }
  try {
    const { db, sqlite } = openDb();
    db.insert(requestLog)
      .values({ surface, command, args: JSON.stringify(args), startedAt, endedAt: new Date().toISOString(), outcome })
      .run();
    sqlite.close();
  } catch {
    // Telemetry must never break the request itself (e.g. before first migrate).
  }
  return code;
}
```

- [ ] **Step 5: Wire it into dispatch**

In `src/cli/router.ts`, replace the final line of `dispatch` (`return cmd.run(rest);`) with:

```ts
  return logRequest("cli", `${cmd.noun} ${cmd.verb}`, rest, () => cmd.run(rest));
```

and add the import at the top:

```ts
import { logRequest } from "../telemetry/request-log.js";
```

- [ ] **Step 6: Full suite green**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: PASS — including the Task 4/5/6 tests, proving dispatch still works wrapped.

- [ ] **Step 7: Commit, PR, review, merge**

```bash
git add -A
git commit -m "feat: request telemetry — every CLI dispatch logs to request_log"
git push -u origin feature/request-telemetry
gh pr create --title "Request telemetry" --body "logRequest middleware wraps CLI dispatch; MCP will share it. Spec § Request telemetry. Part of #1."
```

Standard review/merge tail.

---

### Task 8: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: npm scripts (Task 4), parity scripts (Task 1), grammar test (Task 5).
- Produces: the required status checks the merge gate waits on.

- [ ] **Step 1: Branch**

```bash
git checkout -b chore/ci
```

- [ ] **Step 2: Write .github/workflows/ci.yml**

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  app:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test:coverage
  parity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with:
          ruby-version: "3.3"
      - run: ruby scripts/parity_check.rb
```

- [ ] **Step 3: Commit, push, verify the run is green**

```bash
git add .github/workflows/ci.yml
git commit -m "chore: CI — typecheck, lint, coverage-floored tests, parity"
git push -u origin chore/ci
gh pr create --title "CI workflow" --body "App checks + structural parity on every PR. Part of #1."
gh pr checks --watch
```

Expected: both jobs green on the PR before merging.

- [ ] **Step 4: Standard review/merge tail**

---

### Task 9: Anti-bloat and ops seeds

**Files:**
- Create: `docs/findings.md`, `docs/runbooks/README.md`

**Interfaces:**
- Produces: the findings log every later PR appends to; the runbooks home Phase-7 fills.

- [ ] **Step 1: Branch**

```bash
git checkout -b docs/findings-runbooks-seed
```

- [ ] **Step 2: Write docs/findings.md with the session's queued findings**

```markdown
# Findings Log

Append-only. One line per finding: `date · type · gist`. Types: process | bug | idea | data.
Findings become work ONLY at an HC-triggered triage session (dispositions: do-now /
upstream-to-ace / drop). No Issues, PRs, rules, or ADRs spawn directly from this file.
(Spec § Factory model and SDLC.)

- 2026-07-29 · process · sandcastle/warren-style dispatched-worker execution preserves our operating loop; candidate ace capability, not nadal v1 work
- 2026-07-29 · process · an `ace new <project>` stamper would complete the factory model; upstream idea for ace
- 2026-07-29 · idea · wire harness token/cost telemetry (Claude Code OTEL/cost export) to request_log for per-request economics; post-Springfield
- 2026-07-29 · process · Execution Profile observations for ace#143 accumulate here (what under-thought, what over-spent)
```

- [ ] **Step 3: Write docs/runbooks/README.md**

```markdown
# Runbooks

One runbook per operational flow; each SOW's manual-test segment cites the runbook it
exercises, and runbooks double as HC post-merge checklists. Planned (spec § Testing):

- pre-tournament-full-pull.md — refresh all scouted teams end to end
- login-assisted-scrape.md — USTA/WTN pull with HC standing by to log in
- in-event-screenshot-ingest.md — scorecard photo → tn match add → verified rows
- backup-restore.md — tn db backup / restore drill
```

- [ ] **Step 4: Commit, PR, review, merge**

```bash
git add docs/findings.md docs/runbooks/README.md
git commit -m "docs: seed findings log and runbooks index"
git push -u origin docs/findings-runbooks-seed
gh pr create --title "Findings log + runbooks seed" --body "Anti-bloat mechanics from the spec, seeded with kickoff findings. Part of #1."
```

Standard review/merge tail.

---

### Task 10: GitHub work-queue bootstrap

**Files:** none in-repo (GitHub state: labels, map issue, SOW issues)

**Interfaces:**
- Consumes: the spec (committed), epic #1.
- Produces: the wayfinder map and the SOW queue every future session claims from.

- [ ] **Step 1: Create labels**

```bash
for l in "wayfinder:map" "wayfinder:grilling" "wayfinder:research" "wayfinder:prototype" "wayfinder:task" "sow"; do
  gh label create "$l" --repo wrburgess/nadal --force
done
```

- [ ] **Step 2: Create the wayfinder map issue**

```bash
gh issue create --repo wrburgess/nadal --label "wayfinder:map" \
  --title "Wayfinder map: nadal v1 — Springfield Sectionals" \
  --body "## Destination

Randy walks into USTA MO Valley 40+ 3.5 Sectionals (Springfield, Aug 28–30 2026) with complete
scouting dossiers on every opponent and a lineup-building tool. Spec:
docs/superpowers/specs/2026-07-29-nadal-v1-springfield-design.md. Part of #1.

## Notes

Operating loop per spec: one ticket or SOW per session; GitHub is the only memory between
sessions; Execution Profile in PROJECT.md governs models. Questions to HC: sequential only.

## Decisions so far

- [Design spec](../blob/main/docs/superpowers/specs/2026-07-29-nadal-v1-springfield-design.md) — destination, domain model, ingestion, tn grammar, factory/SDLC, operating loop, telemetry, model routing all locked 2026-07-29

## Not yet specified

- Springfield match schedule (TennisLink shows Not Scheduled) — plan under uncertainty
- Predicted-lineup heuristic — how assignment history + ratings become a labeled guess
- Dossier layout — what HC wants on one page per opponent
- Lineup-planning data shape — how pairings/scenarios are stored and compared
- Scrape cadence pre-tournament; watch for field growth (new teams joining)

## Out of scope

- UTR/Tencap, web UI, multi-user, worker infrastructure, ace-side factory features (see spec § Out of scope)"
```

- [ ] **Step 3: Create the phase SOW issues**

```bash
gh issue create --repo wrburgess/nadal --label sow --title "SOW: Phase 2 — parsers from fixtures" \
  --body "TennisLink team/player/scorecard, USTA profile, WTN, TennisRecord parsers, TDD against captured raw pages. Sized/planned at claim time. Spec § Ingestion. Part of #1."
gh issue create --repo wrburgess/nadal --label sow --title "SOW: Phase 3 — pull pipelines" \
  --body "tn team pull / tn player pull, login-assisted flow, idempotent upserts, raw/ archive. Spec § Ingestion. Part of #1."
gh issue create --repo wrburgess/nadal --label sow --title "SOW: Phase 4 — profiles and dossiers" \
  --body "tn player show / tn team show / tn report build (HTML primary + md, --pdf via Playwright). Spec § Interfaces, § Reports. Part of #1."
gh issue create --repo wrburgess/nadal --label sow --title "SOW: Phase 5 — lineup planning + MCP server" \
  --body "tn lineup plan, MCP tools mirroring the grammar, telemetry on MCP surface. Spec § Interfaces. Part of #1."
gh issue create --repo wrburgess/nadal --label sow --title "SOW: Phase 6 — screenshot ingestion" \
  --body "tn match add from scorecard images; fixtures from Tulsa 2025; roster-resolution flagging. Spec § Ingestion. Part of #1."
gh issue create --repo wrburgess/nadal --label sow --title "SOW: Phase 7 — runbooks, binder, dry run" \
  --body "Fill docs/runbooks/, print courtside binder, full dry run on 2025 data. Spec § Testing. Part of #1."
```

- [ ] **Step 4: Wire blocking order (native dependencies)**

Phases are sequential except 6 (needs only Phase 2's scorecard parser + Task 6 schema): mark Phase 3 blocked by Phase 2; Phase 4 by Phase 3; Phase 5 by Phase 4; Phase 6 by Phase 2; Phase 7 by Phases 4, 5, 6. Use GitHub's native "blocked by" relationships on each issue (or `gh api` sub-issue/dependency endpoints if the UI relationship isn't scriptable at execution time — record whichever was used in a comment on the map).

- [ ] **Step 5: Comment the map link on epic #1**

```bash
gh issue comment 1 --repo wrburgess/nadal --body "Foundation underway. Wayfinder map: see the wayfinder:map issue. Design spec committed at docs/superpowers/specs/2026-07-29-nadal-v1-springfield-design.md. — Claude Code"
```

---

## Self-review notes

- **Spec coverage:** Phases 0–1 fully tasked (vendor, config, routing layer, scaffold, grammar ratchet, schema, telemetry, CI, seeds, queue). Phases 2–7 are deliberately SOW issues, per the operating loop — planned at claim time when fixtures exist.
- **Type consistency:** `Command`/`COMMANDS`/`dispatch`/`helpText` (Task 4) consumed by Tasks 5–7; `runMigrations`/`openDb`/`dbPath` (Task 6) consumed by Task 7; table names in Task 6's test match the schema exactly.
- **Known judgment points for executors:** drizzle-kit generated SQL is committed, not hand-written; if `drizzle-kit generate` output names differ, trust the generator. Task 5 Step 5 removes the grammar row so the pair (row + command) lands atomically in Task 6.
