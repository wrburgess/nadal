import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations, openDb } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { players, teamMemberships, teams } from "../src/db/schema.js";
import * as writeModule from "../src/report/write.js";
import { useTnDbPath } from "./helpers/tn-db.js";

function requestLogRows(dbPath: string) {
  const sqlite = new Database(dbPath);
  const rows = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
  sqlite.close();
  return rows;
}

describe("tn report build (end-to-end via dispatch)", () => {
  const dbFixture = useTnDbPath("cmd.db");
  let reportsDir: string;
  const originalReportsPath = process.env.TN_REPORTS_PATH;

  beforeEach(() => {
    reportsDir = mkdtempSync(join(tmpdir(), "tn-reports-cmd-"));
    process.env.TN_REPORTS_PATH = reportsDir;
  });

  afterEach(() => {
    if (originalReportsPath === undefined) delete process.env.TN_REPORTS_PATH;
    else process.env.TN_REPORTS_PATH = originalReportsPath;
    rmSync(reportsDir, { recursive: true, force: true });
    // Restores console + module spies (notably `writeSectionalsDossiers`, mocked by one test below)
    // so a mock never leaks into a later test in this file.
    vi.restoreAllMocks();
  });

  function seedTeamWithRoster(name: string, playerNames: string[]) {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name, nameKey: nameKey(name) }).returning().get();
    for (const playerName of playerNames) {
      const player = db
        .insert(players)
        .values({ canonicalName: playerName, nameKey: nameKey(playerName) })
        .returning()
        .get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    }
    sqlite.close();
    return team;
  }

  it("with a <team> target, builds that team's dossier and prints one summary line naming the root/teams/files, exit 0", async () => {
    seedTeamWithRoster("Team A", ["Player One"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build", "Team A"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toMatch(/^report build status=ok/);
    expect(printed).toContain("teams=1");
    expect(printed).toContain("files=2");
    expect(printed).toContain(`root="${resolve(reportsDir)}"`);
    // The old shape printed every absolute file path on one line — unreadable at Sectionals scale
    // (five-plus teams). The fix replaces that with root+count, so no ".html"/".md" path appears.
    expect(printed).not.toContain(".html");
    expect(printed).not.toContain(".md");
  });

  it("with target sectionals, builds one dossier per team plus a top-level index", async () => {
    seedTeamWithRoster("Team A", []);
    seedTeamWithRoster("Team B", []);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build", "sectionals"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("teams=2");
    expect(printed).toContain("files=6");
  });

  it("bare (no target) is equivalent to sectionals", async () => {
    seedTeamWithRoster("Team A", []);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("teams=1");
    expect(printed).toContain("files=4"); // 1 team * 2 files + 2 top-level index files
  });

  it("--json emits parseable JSON and no key=value summary line", async () => {
    seedTeamWithRoster("Team A", []);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build", "sectionals", "--json"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.status).toBe("ok");
    expect(parsed.teams).toBe(1);
    expect(parsed.files).toBe(4);
    expect(parsed.root).toBe(resolve(reportsDir));
  });

  it("--quiet emits nothing on stdout and preserves exit code 0", async () => {
    seedTeamWithRoster("Team A", []);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build", "sectionals", "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("an unknown team target exits 1 with a message on stderr", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build", "No Such Team"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^report build status=error message=".+"$/));
  });

  it("an ambiguous team target lists every candidate on stderr and exits 1", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(teams)
      .values([
        { name: "Team Alpha", nameKey: nameKey("Team Alpha") },
        { name: "Team Alpho", nameKey: nameKey("Team Alpho") },
      ])
      .run();
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build", "Team Alph"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("Team Alpha");
    expect(printed).toContain("Team Alpho");
  });

  it("an unrecognized non-global flag exits 1", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build", "sectionals", "--bogus"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --bogus"));
  });

  // Issue #36 decided there is no `--pdf` in v1 — on proportion (a bounded, one-event saving against a
  // permanent ~300 MB dependency), NOT on there being nothing to automate. See the runbook. The
  // `--bogus` test above pins the generic unrecognized-flag MECHANISM; this one pins the OUTCOME the
  // decision is actually about — no PDF artifact is produced — which the runbook states in prose and
  // which nothing else enforced.
  //
  // Asserting the exit code and the message alone would NOT establish that (a Reviewer finding on
  // PR #61): a future change could write a PDF on seeing `--pdf` and *then* fall through to the same
  // parser error, and both of those assertions would still pass. So the reports root is checked too.
  // Both argument positions are covered, so the pin does not depend on where the flag sits.
  it("--pdf produces no PDF and is rejected in either argument position (issue #36: no --pdf in v1)", async () => {
    seedTeamWithRoster("Team A", []);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pdfsUnderReportsRoot = () =>
      readdirSync(reportsDir, { recursive: true }).filter((entry) => String(entry).endsWith(".pdf"));

    const bare = await dispatch(["report", "build", "--pdf"]);
    expect(bare).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --pdf"));
    expect(pdfsUnderReportsRoot()).toEqual([]);

    errorSpy.mockClear();

    const afterTarget = await dispatch(["report", "build", "sectionals", "--pdf"]);
    expect(afterTarget).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --pdf"));
    expect(pdfsUnderReportsRoot()).toEqual([]);
  });

  it("a TN_REPORTS_PATH inside the repo tree at anything other than reports/ is refused, exit 1", async () => {
    seedTeamWithRoster("Team A", []);
    process.env.TN_REPORTS_PATH = resolve("src");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build", "sectionals"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("a non-OutputPathError thrown by the writer propagates rather than being swallowed as a normal error result", async () => {
    seedTeamWithRoster("Team A", []);
    vi.spyOn(writeModule, "writeSectionalsDossiers").mockImplementation(() => {
      throw new Error("unexpected disk failure");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // `dispatch` wraps every command in `logRequest`, which itself catches a rethrown error and
    // converts it to exit 1 (src/telemetry/request-log.ts) — so this asserts the OTHER branch of
    // report-build's catch (rethrow, not swallow-as-OutputPathError) without the test itself
    // needing to catch anything.
    const code = await dispatch(["report", "build", "sectionals"]);

    expect(code).toBe(1);
  });

  // REGRESSION (Codex adversarial review, PR #38, Finding 2 [high]). `resolveTeamDirNames`'
  // collision disambiguation only ran inside `writeSectionalsDossiers`, which has whole-DB
  // visibility. `writeTeamDossier` called without a `dirName` (exactly what `tn report build
  // "<team>"` does, see src/cli/commands/report-build.ts) fell back to a BARE `teamSlug()` that only
  // looks at the one team it was asked to build — so two teams that slug identically ("Team A!!!"
  // and "Team A???" both -> "team-a") would silently share one directory, and the second build
  // replaces the first team's dossier, when built one at a time rather than via `sectionals`.
  it("REGRESSION: two teams that slug-collide land in distinct directories when each is built individually via the CLI (not sectionals)", async () => {
    const teamTwo = (() => {
      seedTeamWithRoster("Team A!!!", []);
      return seedTeamWithRoster("Team A???", []);
    })();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const codeOne = await dispatch(["report", "build", "Team A!!!"]);
    const codeTwo = await dispatch(["report", "build", "Team A???"]);

    expect(codeOne).toBe(0);
    expect(codeTwo).toBe(0);

    const dirOne = join(reportsDir, "team-a");
    const dirTwo = join(reportsDir, `team-a-${teamTwo.id}`);
    expect(existsSync(join(dirOne, "index.html"))).toBe(true);
    expect(existsSync(join(dirTwo, "index.html"))).toBe(true);
    // The failure mode this guards: both builds landing in `dirOne`, the second silently replacing
    // the first team's content.
    expect(readFileSync(join(dirOne, "index.html"), "utf8")).toContain("Team A!!!");
    expect(readFileSync(join(dirTwo, "index.html"), "utf8")).toContain("Team A???");
  });

  it("REGRESSION: a single-team build resolves the same collision-safe directory sectionals would choose for it, even without building the other colliding team first", async () => {
    // "Team A!!!" is only ever seeded, never built directly — a single-team build for "Team A???"
    // must still see it (whole-DB visibility) to know it needs the "-<id>" suffix, exactly as
    // `writeSectionalsDossiers` would have assigned it.
    seedTeamWithRoster("Team A!!!", []);
    const teamTwo = seedTeamWithRoster("Team A???", []);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["report", "build", "Team A???"]);

    expect(code).toBe(0);
    expect(existsSync(join(reportsDir, `team-a-${teamTwo.id}`, "index.html"))).toBe(true);
    // The bug: a single-team build that only consulted its own name would land in the bare "team-a"
    // slot instead — the same slot `sectionals` would have reserved for the OTHER colliding team.
    expect(existsSync(join(reportsDir, "team-a", "index.html"))).toBe(false);
  });

  it("writes a request_log row with sanitized args on both the ok and the error path", async () => {
    seedTeamWithRoster("Team A", []);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await dispatch(["report", "build", "sectionals"]);
    await dispatch(["report", "build", "No Such Team"]);

    const rows = requestLogRows(dbFixture.path());
    const commands = rows.map((r) => r.command);
    expect(commands.filter((c) => c === "report build")).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(["ok", "error:exit-1"]));
  });
});
