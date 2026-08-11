import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations, openDb } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { players, teamMemberships, teams } from "../src/db/schema.js";
import { setHomeTeam } from "../src/query/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

function requestLogRows(dbPath: string) {
  const sqlite = new Database(dbPath);
  const rows = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
  sqlite.close();
  return rows;
}

describe("tn team show (end-to-end via dispatch)", () => {
  const dbFixture = useTnDbPath("cmd.db");

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

  it("prints exactly one call to console.log (roster + match record) and exits 0", async () => {
    const team = seedTeamWithRoster("IA/Versteeg/40&Over3.5M", ["Nova Norbury", "Rowan Rushworth"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "show", team.name]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("IA/Versteeg/40&Over3.5M");
    expect(printed).toContain("Nova Norbury");
    expect(printed).toContain("Rowan Rushworth");
    expect(printed.split("\n").length).toBeGreaterThan(1);
  });

  // Issue #128: `ageRange` was NULL for every player before this PR, so the roster line's `age:`
  // segment had never rendered a real value end to end. One of the four `ageRange` render sites
  // task 8's audit named.
  it("prints a real age range for a roster member who has one, and 'unknown' for one who doesn't", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Team Age Range", nameKey: nameKey("Team Age Range") }).returning().get();
    const withRange = db
      .insert(players)
      .values({ canonicalName: "Micah Merrivale", nameKey: nameKey("Micah Merrivale"), ageRange: "41-50" })
      .returning()
      .get();
    const withoutRange = db
      .insert(players)
      .values({ canonicalName: "Noel Nobody", nameKey: nameKey("Noel Nobody") })
      .returning()
      .get();
    db.insert(teamMemberships).values({ playerId: withRange.id, teamId: team.id, eventId: null }).run();
    db.insert(teamMemberships).values({ playerId: withoutRange.id, teamId: team.id, eventId: null }).run();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "show", team.name]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("Micah Merrivale — age: 41-50");
    expect(printed).toContain("Noel Nobody — age: unknown");
  });

  it("--json emits the TeamProfile verbatim, parseable, as the only console.log call", async () => {
    const team = seedTeamWithRoster("Team A", ["Player One"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "show", team.name, "--json"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.teamName).toBe("Team A");
    expect(parsed.roster).toHaveLength(1);
    expect(parsed.isHome).toBe(false);
  });

  it("prints a home: yes/no line, reflecting the designated home team (Task 2: tn team home / #37)", async () => {
    const home = seedTeamWithRoster("Home Team", []);
    const other = seedTeamWithRoster("Other Team", []);
    runMigrations();
    const { db, sqlite } = openDb();
    setHomeTeam(db, home.id);
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["team", "show", home.name]);
    await dispatch(["team", "show", other.name]);

    const printedForHome = logSpy.mock.calls[0]?.[0] as string;
    const printedForOther = logSpy.mock.calls[1]?.[0] as string;
    expect(printedForHome).toContain("home: yes");
    expect(printedForOther).toContain("home: no");
  });

  it("--quiet emits nothing on stdout and preserves exit code 0", async () => {
    const team = seedTeamWithRoster("Team B", []);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "show", team.name, "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("an ambiguous name lists every candidate on stderr and exits 1", async () => {
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

    const code = await dispatch(["team", "show", "Team Alph"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("Team Alpha");
    expect(printed).toContain("Team Alpho");
  });

  it("an unknown target exits 1 with a message on stderr", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "show", "No Such Team"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^team show status=error message=".+"$/));
  });

  it("a missing target exits 1", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "show"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("missing target"));
  });

  it("an unrecognized non-global flag exits 1", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "show", "some-target", "--bogus"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --bogus"));
  });

  it("writes a request_log row with sanitized args on both the ok and the error path", async () => {
    const team = seedTeamWithRoster("Team C", []);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await dispatch(["team", "show", team.name]);
    await dispatch(["team", "show", "No Such Team"]);

    const rows = requestLogRows(dbFixture.path());
    const commands = rows.map((r) => r.command);
    expect(commands.filter((c) => c === "team show")).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(["ok", "error:exit-1"]));
  });
});
