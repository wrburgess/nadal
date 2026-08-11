import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations, openDb } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { playerAliases, players, teamMemberships, teams } from "../src/db/schema.js";
import { useTnDbPath } from "./helpers/tn-db.js";

function requestLogRows(dbPath: string) {
  const sqlite = new Database(dbPath);
  const rows = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
  sqlite.close();
  return rows;
}

describe("tn player show (end-to-end via dispatch)", () => {
  const dbFixture = useTnDbPath("cmd.db");

  function seedPlayer(name: string) {
    runMigrations();
    const { db, sqlite } = openDb();
    const row = db.insert(players).values({ canonicalName: name, nameKey: nameKey(name) }).returning().get();
    sqlite.close();
    return row;
  }

  it("prints exactly one call to console.log (a compact multi-line profile) and exits 0", async () => {
    const player = seedPlayer("Nova Norbury");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", player.canonicalName]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("Nova Norbury");
    expect(printed.split("\n").length).toBeGreaterThan(1);
  });

  // Issues #128/#130. Neither field had a real value to render before this PR (`ageRange` was NULL
  // for all 1745 players; `gender` held a raw source label on the 77 that had one). `player show`
  // is the ONLY render site for `gender` (task 8's audit) and one of four for `ageRange` — this
  // pins the printed line end to end, present and absent, so a future edit to the same line cannot
  // silently drop one field while leaving the other's test green.
  it("prints a real age and gender when present on the player row", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const player = db
      .insert(players)
      .values({ canonicalName: "Micah Merrivale", nameKey: nameKey("Micah Merrivale"), ageRange: "41-50", gender: "Male" })
      .returning()
      .get();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", player.canonicalName]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("age: 41-50   gender: Male");
  });

  it("prints 'unknown' for age and gender when neither is on file — the permanent no-WTN-profile case", async () => {
    const player = seedPlayer("Noel Nobody");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", player.canonicalName]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("age: unknown   gender: unknown");
  });

  it("includes aliases in the human profile text when the player has any on file", async () => {
    const player = seedPlayer("JT Martin");
    const { db, sqlite } = openDb();
    db.insert(playerAliases)
      .values({ playerId: player.id, alias: "Jerry Martin", nameKey: nameKey("Jerry Martin") })
      .run();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "JT Martin"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("(aka Jerry Martin)");
  });

  // Issue #49: a retired membership is not hidden from `player show` (it is real history), but must
  // read distinctly from a current one — otherwise a captain reading the profile has no way to tell
  // a former team from a current one.
  it("labels a retired team membership '(former)', and a current one plainly", async () => {
    const player = seedPlayer("Rowan Rushworth");
    const { db, sqlite } = openDb();
    const currentTeam = db.insert(teams).values({ name: "Current Team" }).returning().get();
    const formerTeam = db.insert(teams).values({ name: "Former Team" }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: currentTeam.id, eventId: null }).run();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: formerTeam.id, eventId: null }).run();
    db.update(teamMemberships)
      .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
      .where(eq(teamMemberships.teamId, formerTeam.id))
      .run();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", player.canonicalName]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("Current Team");
    expect(printed).not.toContain("Current Team (former)");
    expect(printed).toContain("Former Team (former)");
  });

  it("--json emits the PlayerProfile verbatim, parseable, as the only console.log call", async () => {
    const player = seedPlayer("Rowan Rushworth");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", player.canonicalName, "--json"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.identity.canonicalName).toBe("Rowan Rushworth");
    expect(parsed.identity.playerId).toBe(player.id);
  });

  it("--quiet emits nothing on stdout and preserves exit code 0", async () => {
    const player = seedPlayer("Kai Kestrel");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", player.canonicalName, "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("an ambiguous name lists every candidate on stderr and exits 1", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(players)
      .values([
        { canonicalName: "Alex Stone", nameKey: nameKey("Alex Stone") },
        { canonicalName: "Alex Stove", nameKey: nameKey("Alex Stove") },
      ])
      .run();
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "Alex Ston"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("Alex Stone");
    expect(printed).toContain("Alex Stove");
  });

  it("an unknown target exits 1 with a message on stderr", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "Nobody Atall"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^player show status=error message=".+"$/));
  });

  it("a missing target exits 1", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("missing target"));
  });

  it("an unrecognized non-global flag exits 1", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "some-target", "--bogus"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --bogus"));
  });

  it("a usta: prefixed target with no such player exits 1, unknown-target contract, not a crash", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "usta:no-such-uaid"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("writes a request_log row with sanitized args on both the ok and the error path", async () => {
    const player = seedPlayer("Blake Bramwell");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await dispatch(["player", "show", player.canonicalName]);
    await dispatch(["player", "show", "Nobody Atall"]);

    const rows = requestLogRows(dbFixture.path());
    const commands = rows.map((r) => r.command);
    expect(commands.filter((c) => c === "player show")).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(["ok", "error:exit-1"]));
  });
});
