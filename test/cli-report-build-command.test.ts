import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations, openDb } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { addEvent } from "../src/query/events.js";
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

  /** A team with real court-match history, so the predicted-lineup section actually renders
   * (rather than the "nothing to predict from" absence a bare roster produces). */
  function seedTeamWithHistory(name: string): { team: { id: number; name: string }; playerIds: number[] } {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name, nameKey: nameKey(name) }).returning().get();
    const opponentName = `${name} Opponent`;
    const opponent = db.insert(teams).values({ name: opponentName, nameKey: nameKey(opponentName) }).returning().get();
    const p1 = db.insert(players).values({ canonicalName: "Ada Ashby" }).returning().get();
    const p2 = db.insert(players).values({ canonicalName: "Bo Bramwell" }).returning().get();
    for (const p of [p1, p2]) {
      db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
    }
    const tm = db
      .insert(teamMatches)
      .values({ homeTeamId: team.id, visitingTeamId: opponent.id, sourceMatchId: `${name}-match` })
      .returning()
      .get();
    const cm = upsertCourtMatch(db, {
      teamMatchId: tm.id,
      slot: "D1",
      discipline: "doubles",
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: `${name}-cm`,
    });
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: p1.id, side: "home" });
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: p2.id, side: "home" });
    sqlite.close();
    return { team, playerIds: [p1.id, p2.id] };
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

  describe("an optional trailing event positional (#63)", () => {
    it("tn report build sectionals <event> — every dossier uses the event's courts", async () => {
      seedTeamWithHistory("Team Event");
      const { db, sqlite } = openDb();
      addEvent(db, {
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "D1:doubles",
      });
      sqlite.close();
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "sectionals", "Springfield Sectionals 2026"]);

      expect(code).toBe(0);
      const dirName = "team-event";
      const md = readFileSync(join(reportsDir, dirName, "index.md"), "utf8");
      expect(md).toContain('from the format of event "Springfield Sectionals 2026"');
      expect(md).not.toContain("taken from this team's observed match history");
    });

    it("tn report build <team> <event> also threads the event through a single-team build", async () => {
      seedTeamWithHistory("Team Solo Event");
      const { db, sqlite } = openDb();
      addEvent(db, {
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "D1:doubles",
      });
      sqlite.close();
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "Team Solo Event", "Springfield Sectionals 2026"]);

      expect(code).toBe(0);
      const md = readFileSync(join(reportsDir, "team-solo-event", "index.md"), "utf8");
      expect(md).toContain('from the format of event "Springfield Sectionals 2026"');
    });

    it("an unknown event name exits 1 and writes nothing", async () => {
      seedTeamWithHistory("Team Bad Event");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "sectionals", "No Such Event"]);

      expect(code).toBe(1);
      // Pinned to the actual refusal text (not merely "the event name appears somewhere"), so this
      // cannot pass on a coincidental parse error (e.g. "unexpected extra argument") that happens to
      // quote the same string. The event name itself is checked separately from "unknown event"
      // because the summary line backslash-escapes the inner quotes around it.
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown event"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("No Such Event"));
      expect(existsSync(join(reportsDir, "index.html"))).toBe(false);
    });

    it("bare tn report build (no event) stays unchanged", async () => {
      seedTeamWithHistory("Team No Event");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "sectionals"]);

      expect(code).toBe(0);
      const md = readFileSync(join(reportsDir, "team-no-event", "index.md"), "utf8");
      expect(md).toContain("taken from this team's observed match history — not from the event format.");
    });
  });

  // #124: the batch build's summary names which reading of "the field" it used, and its `teams=`
  // count comes out of the write rather than from a second whole-table read.
  describe("the field= summary field (#124)", () => {
    it("scopes the batch to the registered teams and prints field=\"registered\" with a matching teams=", async () => {
      const { team, playerIds } = seedTeamWithHistory("Team In Field");
      seedTeamWithHistory("Team Not In Field");
      const { db, sqlite } = openDb();
      const event = addEvent(db, {
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "D1:doubles",
      });
      db.insert(teamMemberships).values({ playerId: playerIds[0]!, teamId: team.id, eventId: event.eventId }).run();
      sqlite.close();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "sectionals", "Springfield Sectionals 2026"]);

      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      expect(printed).toContain('field="registered"');
      // `teams=1`, not `teams=2`: this is the assertion that fails if the count is ever taken from a
      // second whole-table read again — two teams are on file and only one is in the field.
      expect(printed).toContain("teams=1");
      expect(existsSync(join(reportsDir, "team-in-field", "index.md"))).toBe(true);
      expect(existsSync(join(reportsDir, "team-not-in-field", "index.md"))).toBe(false);
    });

    it("prints field=\"all-teams\" when the named event has nobody registered", async () => {
      seedTeamWithHistory("Team A Unregistered");
      seedTeamWithHistory("Team B Unregistered");
      const { db, sqlite } = openDb();
      addEvent(db, {
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "D1:doubles",
      });
      sqlite.close();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "sectionals", "Springfield Sectionals 2026"]);

      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      expect(printed).toContain('field="all-teams"');
      // Both seeded teams are rendered. Deliberately NOT asserting a literal `teams=` count here:
      // this suite shares one database across its tests, so the total depends on what earlier tests
      // seeded. The registered case above is where the count is pinned, and it is pinned there
      // against a field SMALLER than the table — which is the case that actually distinguishes a
      // count taken from the write from one taken from a second whole-table read.
      expect(existsSync(join(reportsDir, "team-a-unregistered", "index.md"))).toBe(true);
      expect(existsSync(join(reportsDir, "team-b-unregistered", "index.md"))).toBe(true);
    });

    // A single-team build has no field to have scoped, so the key must be ABSENT rather than
    // present-with-some-value — `field="all-teams"` on a one-team build would read as a claim that
    // one team is the whole field.
    it("omits field= entirely on a single-team build", async () => {
      seedTeamWithHistory("Team Solo");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "Team Solo"]);

      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      expect(printed).not.toContain("field=");
    });
  });

  // Task 7 (#113): the single-team build's summary line names which roster the dossier just written
  // actually drew on.
  describe("the roster= summary field (#113)", () => {
    it("a single-team build against a REGISTERED event prints roster=\"registered\"", async () => {
      const { team, playerIds } = seedTeamWithHistory("Team Roster Registered");
      const { db, sqlite } = openDb();
      const event = addEvent(db, {
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "D1:doubles",
      });
      db.insert(teamMemberships).values({ playerId: playerIds[0]!, teamId: team.id, eventId: event.eventId }).run();
      sqlite.close();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "Team Roster Registered", "Springfield Sectionals 2026"]);

      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      expect(printed).toContain('roster="registered"');
    });

    // The invariant the field exists to satisfy, and the one an earlier revision could break: the
    // summary is read out of the WRITE, so it cannot describe a different roster than the files it
    // just produced. Previously it came from a second database read AFTER the write had landed —
    // a window a concurrent `tn roster set` could slip inside, leaving the summary saying
    // `roster="registered"` about files that say season roster. Asserted by comparing the two
    // artifacts rather than by racing them, since the fix is that there is only one source now.
    // (Codex adversarial review of PR #121, round 1, finding 3 [medium].)
    it("the summary's roster= agrees with the Roster: line in the markdown it just wrote", async () => {
      const { team, playerIds } = seedTeamWithHistory("Team Roster Agreement");
      const { db, sqlite } = openDb();
      const event = addEvent(db, {
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "D1:doubles",
      });
      db.insert(teamMemberships).values({ playerId: playerIds[0]!, teamId: team.id, eventId: event.eventId }).run();
      sqlite.close();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "Team Roster Agreement", "Springfield Sectionals 2026"]);

      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      const summarySaysRegistered = printed.includes('roster="registered"');

      const teamDir = readdirSync(reportsDir).find((d) => d.startsWith("team-roster-agreement"))!;
      const md = readFileSync(join(reportsDir, teamDir, "index.md"), "utf8");
      const rosterLine = md.split("\n").find((l) => l.startsWith("**Roster:**"))!;
      const fileSaysRegistered = rosterLine.includes("registered ");

      expect(rosterLine, "the dossier must state a roster source at all").toBeDefined();
      expect(summarySaysRegistered, `summary: ${printed}\nfile: ${rosterLine}`).toBe(fileSaysRegistered);
      // And both must say the registered thing, not merely agree on "season" vacuously.
      expect(summarySaysRegistered).toBe(true);
    });

    it("a single-team build against an event with NO registered rows prints roster=\"season\"", async () => {
      seedTeamWithHistory("Team Roster Season");
      const { db, sqlite } = openDb();
      addEvent(db, {
        name: "Unregistered Event",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "D1:doubles",
      });
      sqlite.close();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "Team Roster Season", "Unregistered Event"]);

      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      expect(printed).toContain('roster="season"');
    });

    it("the sectionals BATCH path carries no roster= field — a single scalar cannot describe mixed teams", async () => {
      seedTeamWithHistory("Team Roster Batch");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["report", "build", "sectionals"]);

      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      expect(printed).not.toContain("roster=");
    });
  });
});
