import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations, openDb } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { playerAliases, players, teamMemberships, teams } from "../src/db/schema.js";
import { resolvePlayer } from "../src/ingest/identity.js";
import { seedTeamWithRosters } from "./helpers/roster.js";
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

  // Issue #131, end to end. The formatter's own contract is pinned in
  // `test/cli-format-profile.test.ts`; these four assert the WIRING — that the command actually
  // calls it, that the query hands it a named event, and that the surfaces beside the human line
  // (`--json`, and the MCP tool that returns the same object) neither lose rows nor lose the field.
  // A formatter test alone stays green while `player-show.ts` still runs its old inline `.map()`.
  it("prints a team ONCE when the player holds both a season and an event membership on it (#131)", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    seedTeamWithRosters(db, {
      teamName: "HOA/Burgess-Zingg/40&over3.5M",
      season: ["Rowan Rushworth"],
      registered: { eventName: "Springfield Sectionals", names: ["Rowan Rushworth"] },
    });
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "Rowan Rushworth"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    // Occurrence count, not `toContain` — the buggy output contains the name too.
    expect(printed.split("HOA/Burgess-Zingg/40&over3.5M").length - 1).toBe(1);
    expect(printed).toContain('registered for "Springfield Sectionals"');
  });

  // Guards the one mistake that would make this change LOSE data: an inner join to `events` drops
  // every `event_id IS NULL` row, i.e. the entire `teams:` line for the 1696 players who hold only
  // a season membership — and it would look like a working dedupe in every test that seeds an event.
  it("still shows the team of a player who holds only a season membership", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    seedTeamWithRosters(db, { teamName: "Season Only Team", season: ["Kai Kestrel"] });
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "Kai Kestrel"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    const teamsLine = printed.split("\n").find((l) => l.startsWith("  teams: "));
    // Scoped to the `teams:` LINE, not the whole profile — several other lines legitimately read
    // "none"/"none on file" for a player with no ratings and no matches, so a whole-profile
    // assertion would be about the wrong line and pass or fail for the wrong reason.
    expect(teamsLine).toBe("  teams: Season Only Team");
  });

  it("--json keeps both membership rows and names the event on the registered one", async () => {
    // The presenter fix must NOT reach the structured surface: `--json` and the MCP `player_show`
    // tool return the same `PlayerProfile`, and a caller integrating against them needs the rows
    // the database actually holds. What they gain is `eventName` — before this change the row
    // carried a bare `eventId` integer no caller could resolve to a name.
    runMigrations();
    const { db, sqlite } = openDb();
    seedTeamWithRosters(db, {
      teamName: "HOA/Burgess-Zingg/40&over3.5M",
      season: ["Rowan Rushworth"],
      registered: { eventName: "Springfield Sectionals", names: ["Rowan Rushworth"] },
    });
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "Rowan Rushworth", "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.teamMemberships).toHaveLength(2);
    // Ordered by the query (`teams.name`, then `event_id` — SQLite sorts NULL first), so the season
    // row precedes its registration deterministically rather than by luck of the scan.
    expect(parsed.teamMemberships[0]).toMatchObject({ eventId: null, eventName: null });
    expect(parsed.teamMemberships[1]).toMatchObject({ eventName: "Springfield Sectionals" });
  });

  // Issue #131's folded adjacent defect. Every player-creating path seeds an alias equal to the new
  // player's own canonical name, so `(aka <same name>)` printed on all 1745 live profiles. Seeded
  // here through the real writer (`resolvePlayer` creates the row AND its self-alias) rather than by
  // hand, so the test cannot drift from what production actually writes.
  it("omits the '(aka …)' suffix when the only alias is the player's own name", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const resolution = resolvePlayer(db, { name: "Nova Norbury" });
    expect(resolution.kind).toBe("created");
    const aliasCount = db.select().from(playerAliases).all().length;
    sqlite.close();
    // The premise of the fix, asserted rather than assumed: the real writer DID seed a self-alias.
    expect(aliasCount).toBe(1);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", "Nova Norbury"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).not.toContain("aka");
    expect(printed).toContain("Nova Norbury");
  });
});
