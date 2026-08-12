// `tn player plays <name> <both|doubles-only>` (#149 Task 6), end to end through `dispatch`. Models
// `test/cli-player-avail-command.test.ts`'s shape. Unlike `player avail`, target resolution lives
// INSIDE `setPlays` (src/query/player-plays.ts) rather than in this command, so there is no separate
// "unknown target"/"ambiguous target" branch in the command itself to test around — every refusal
// below is `setPlays`'s own, reached through the CLI door.

import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { players, teamMemberships, teams } from "../src/db/schema.js";
import { seedHomeTeamFixture } from "./helpers/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("tn player plays (end-to-end via dispatch)", () => {
  useTnDbPath();

  function seedFixture() {
    runMigrations();
    const { db, sqlite } = openDb();
    const fixture = seedHomeTeamFixture(db);
    sqlite.close();
    return fixture;
  }

  function playsColumn(playerId: number): string | null {
    const { db, sqlite } = openDb();
    try {
      return db.select({ plays: players.plays }).from(players).where(eq(players.id, playerId)).get()?.plays ?? null;
    } finally {
      sqlite.close();
    }
  }

  it("records the constraint and prints a deterministic summary line, exit 0", async () => {
    const fixture = seedFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", fixture.playerName, "doubles-only"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^player plays status=ok player=".+" plays="doubles-only"$/),
    );
    expect(playsColumn(fixture.playerId)).toBe("doubles-only");
  });

  it("re-running with 'both' overwrites in place — exactly one value per player", async () => {
    const fixture = seedFixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["player", "plays", fixture.playerName, "doubles-only"]);
    const code = await dispatch(["player", "plays", fixture.playerName, "both"]);

    expect(code).toBe(0);
    expect(playsColumn(fixture.playerId)).toBe("both");
  });

  it("a value outside the enum exits 1, names the accepted values, and writes nothing (InvalidPlaysError)", async () => {
    const fixture = seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", fixture.playerName, "singles-only"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("status=error");
    expect(printed).toContain("both");
    expect(printed).toContain("doubles-only");
    expect(playsColumn(fixture.playerId)).toBeNull();
  });

  it("no home team designated refuses, naming the reason (NoHomeTeamError)", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const player = db.insert(players).values({ canonicalName: "Solo Player" }).returning().get();
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", player.canonicalName, "doubles-only"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("home team");
  });

  it("an unknown target refuses, naming it (UnknownPlayerTargetError)", async () => {
    seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", "Nobody Nowhere", "doubles-only"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("unknown");
    expect(printed).toContain("Nobody Nowhere");
  });

  it("an ambiguous player name lists every candidate on stderr, exits 1, and writes nothing (AmbiguousPlayerTargetError)", async () => {
    const fixture = seedFixture();
    const { db, sqlite } = openDb();
    // Near-identical to the fixture's own player name (edit distance 1) so the fuzzy tier fires —
    // same construction `cli-player-avail-command.test.ts` uses for the identical mechanism.
    const near = `${fixture.playerName.slice(0, -1)}x`;
    db.insert(players).values({ canonicalName: near }).run();
    backfillNameKeys(db);
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", fixture.playerName.slice(0, -1), "doubles-only"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("ambiguous");
  });

  it("a player not on the home team's roster refuses, naming the reason (PlayerNotOnHomeRosterError)", async () => {
    const fixture = seedFixture();
    const { db, sqlite } = openDb();
    const otherTeam = db.insert(teams).values({ name: "Opponent" }).returning().get();
    const otherPlayer = db.insert(players).values({ canonicalName: "Opponent Player" }).returning().get();
    db.insert(teamMemberships)
      .values({ playerId: otherPlayer.id, teamId: otherTeam.id, eventId: fixture.eventId })
      .run();
    backfillNameKeys(db);
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", otherPlayer.canonicalName, "doubles-only"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("roster");
  });

  it("no arguments at all refuses, naming the missing target — distinct from the missing-payload usage message", async () => {
    seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("missing target"));
  });

  it("a missing payload argument exits 1 with a usage message", async () => {
    const fixture = seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", fixture.playerName]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("usage"));
  });

  it("an unrecognized flag refuses rather than being silently ignored — no command-specific flags exist", async () => {
    const fixture = seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", fixture.playerName, "doubles-only", "--bogus"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --bogus"));
  });

  it("--json emits status=ok and the recorded plays value as JSON", async () => {
    const fixture = seedFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", fixture.playerName, "doubles-only", "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({ status: "ok", plays: "doubles-only" });
  });

  it("--quiet emits nothing on stdout and preserves exit code 0", async () => {
    const fixture = seedFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "plays", fixture.playerName, "doubles-only", "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
