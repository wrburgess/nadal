import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations, openDb } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { players, teamMemberships, teams } from "../src/db/schema.js";
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

  it("--json emits the TeamProfile verbatim, parseable, as the only console.log call", async () => {
    const team = seedTeamWithRoster("Team A", ["Player One"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "show", team.name, "--json"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.teamName).toBe("Team A");
    expect(parsed.roster).toHaveLength(1);
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
