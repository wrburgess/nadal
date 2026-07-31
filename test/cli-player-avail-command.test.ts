import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { availability, players, teamMemberships, teams } from "../src/db/schema.js";
import { seedHomeTeamFixture } from "./helpers/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("tn player avail (end-to-end via dispatch)", () => {
  useTnDbPath();

  function seedFixture() {
    runMigrations();
    const { db, sqlite } = openDb();
    const fixture = seedHomeTeamFixture(db);
    sqlite.close();
    return fixture;
  }

  it("records availability and prints a deterministic summary line, exit 0", async () => {
    const fixture = seedFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", fixture.playerName, "2026-08-29", "available"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^player avail status=ok player=".+" day="2026-08-29" availability="available" event=".+"$/,
      ),
    );

    const { db, sqlite } = openDb();
    try {
      const rows = db.select().from(availability).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playerId: fixture.playerId, day: "2026-08-29", status: "available" });
    } finally {
      sqlite.close();
    }
  });

  it("re-running the same (player, day) updates status in place — idempotent, no duplicate row", async () => {
    const fixture = seedFixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["player", "avail", fixture.playerName, "2026-08-29", "available"]);
    await dispatch(["player", "avail", fixture.playerName, "2026-08-29", "unavailable"]);

    const { db, sqlite } = openDb();
    try {
      const rows = db.select().from(availability).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("unavailable");
    } finally {
      sqlite.close();
    }
  });

  it("an unknown status exits 1 and writes nothing", async () => {
    const fixture = seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", fixture.playerName, "2026-08-29", "maybe"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));
    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(availability).all()).toHaveLength(0);
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

    const code = await dispatch(["player", "avail", player.canonicalName, "2026-08-29", "available"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("home team");
  });

  it("an ambiguous player name lists every candidate on stderr, exits 1, and writes nothing", async () => {
    const fixture = seedFixture();
    const { db, sqlite } = openDb();
    // Near-identical to the fixture's own player name (edit distance 1) so the fuzzy tier fires.
    const name = fixture.playerName;
    const near = `${name.slice(0, -1)}x`;
    db.insert(players).values({ canonicalName: near }).run();
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", name.slice(0, -1), "2026-08-29", "available"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("ambiguous");
    const { db: db2, sqlite: sqlite2 } = openDb();
    try {
      expect(db2.select().from(availability).all()).toHaveLength(0);
    } finally {
      sqlite2.close();
    }
  });

  it("a player not on the home team's roster refuses, naming the reason", async () => {
    const fixture = seedFixture();
    const { db, sqlite } = openDb();
    const otherTeam = db.insert(teams).values({ name: "Opponent" }).returning().get();
    const otherPlayer = db.insert(players).values({ canonicalName: "Opponent Player" }).returning().get();
    db.insert(teamMemberships)
      .values({ playerId: otherPlayer.id, teamId: otherTeam.id, eventId: fixture.eventId })
      .run();
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", otherPlayer.canonicalName, "2026-08-29", "available"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("roster");
  });

  it("missing payload arguments exit 1 with a usage message", async () => {
    const fixture = seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", fixture.playerName, "2026-08-29"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("usage"));
  });

  it("--json emits status=ok and the recorded availability as JSON", async () => {
    const fixture = seedFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", fixture.playerName, "2026-08-29", "available", "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({ status: "ok", day: "2026-08-29", availability: "available" });
  });

  it("--quiet emits nothing on stdout and preserves exit code 0", async () => {
    const fixture = seedFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", fixture.playerName, "2026-08-29", "available", "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
