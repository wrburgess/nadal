import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { captainNotes, players, teamMemberships, teams } from "../src/db/schema.js";
import { seedHomeTeamFixture } from "./helpers/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("tn player note (end-to-end via dispatch)", () => {
  useTnDbPath();

  function seedFixture() {
    runMigrations();
    const { db, sqlite } = openDb();
    const fixture = seedHomeTeamFixture(db);
    sqlite.close();
    return fixture;
  }

  it("appends a note and prints a deterministic summary line, exit 0", async () => {
    const fixture = seedFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "Serves big on big points."]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^player note status=ok player=".+" note=".+"$/));

    const { db, sqlite } = openDb();
    try {
      const rows = db.select().from(captainNotes).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playerId: fixture.playerId, note: "Serves big on big points." });
    } finally {
      sqlite.close();
    }
  });

  it("appending twice produces two rows — never an upsert", async () => {
    const fixture = seedFixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["player", "note", fixture.playerName, "First."]);
    await dispatch(["player", "note", fixture.playerName, "Second."]);

    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(captainNotes).all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("empty text exits 1 and writes nothing", async () => {
    const fixture = seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "   "]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));
    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(captainNotes).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("no home team designated refuses, naming the reason", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const player = db.insert(players).values({ canonicalName: "Solo Player" }).returning().get();
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", player.canonicalName, "Anything."]);

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0] as string).toContain("home team");
  });

  it("a note about a non-home-team player refuses, naming the reason", async () => {
    const fixture = seedFixture();
    const { db, sqlite } = openDb();
    const otherTeam = db.insert(teams).values({ name: "Opponent" }).returning().get();
    const otherPlayer = db.insert(players).values({ canonicalName: "Opponent Player" }).returning().get();
    db.insert(teamMemberships)
      .values({ playerId: otherPlayer.id, teamId: otherTeam.id, eventId: fixture.eventId })
      .run();
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", otherPlayer.canonicalName, "About an opponent."]);

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0] as string).toContain("roster");
  });

  it("a missing text payload argument exits 1 with a usage message", async () => {
    const fixture = seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("usage"));
  });

  it("--json emits status=ok and the stored note as JSON", async () => {
    const fixture = seedFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "A note.", "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({ status: "ok", note: "A note." });
  });

  it("--quiet emits nothing on stdout and preserves exit code 0", async () => {
    const fixture = seedFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "A note.", "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
