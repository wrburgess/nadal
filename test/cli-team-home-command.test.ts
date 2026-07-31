import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations, openDb } from "../src/db/client.js";
import { teams } from "../src/db/schema.js";
import { resolveHomeTeam } from "../src/query/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("tn team home (end-to-end via dispatch)", () => {
  useTnDbPath();

  function seedTeam(name: string) {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name }).returning().get();
    sqlite.close();
    return team;
  }

  it("designates the resolved team as home and prints a deterministic summary line, exit 0", async () => {
    const team = seedTeam("HOA/Burgess-Zingg/40&over3.5M");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "home", team.name]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^team home status=ok team=".+"$/));

    const { db, sqlite } = openDb();
    try {
      expect(resolveHomeTeam(db)?.id).toBe(team.id);
    } finally {
      sqlite.close();
    }
  });

  it("re-running against a different team moves the designation (never creates a team)", async () => {
    const teamA = seedTeam("Team A");
    const teamB = seedTeam("Team B");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["team", "home", teamA.name]);
    await dispatch(["team", "home", teamB.name]);

    const { db, sqlite } = openDb();
    try {
      expect(resolveHomeTeam(db)?.id).toBe(teamB.id);
      expect(db.select().from(teams).all()).toHaveLength(2); // never creates
    } finally {
      sqlite.close();
    }
  });

  it("an unknown target exits 1 with a message on stderr and designates nothing", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "home", "No Such Team"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^team home status=error message=".+"$/));
    const { db, sqlite } = openDb();
    try {
      expect(resolveHomeTeam(db)).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("an ambiguous name lists every candidate on stderr and exits 1", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(teams).values([{ name: "Team Alpha" }, { name: "Team Alpho" }]).run();
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "home", "Team Alph"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("Team Alpha");
    expect(printed).toContain("Team Alpho");
  });

  it("a missing target exits 1", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "home"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("missing target"));
  });

  it("--json emits status=ok and the team name as JSON", async () => {
    const team = seedTeam("Team C");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "home", team.name, "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toEqual({ status: "ok", team: team.name });
  });

  it("--quiet emits nothing on stdout and preserves exit code 0", async () => {
    const team = seedTeam("Team D");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "home", team.name, "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
