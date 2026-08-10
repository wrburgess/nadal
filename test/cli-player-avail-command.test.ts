import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { availability, events, players, teamMemberships, teams } from "../src/db/schema.js";
import { setHomeTeam } from "../src/query/home-team.js";
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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

// #129: a season-roster player who has not registered for the resolved event still writes — the
// writer's own roster check is deliberately wider than the dossier's roster (see
// `setAvailability`'s `onEventRoster` doc comment) — but the CLI has to say so, since nothing else
// will.
describe("tn player avail: the not-registered warning (#129)", () => {
  useTnDbPath();

  function seedUnregistered() {
    runMigrations();
    const { db, sqlite } = openDb();
    const fixture = seedHomeTeamFixture(db); // registers ITS OWN player, giving the event a roster
    const unregistered = db.insert(players).values({ canonicalName: "Nate Notregistered" }).returning().get();
    db.insert(teamMemberships).values({ playerId: unregistered.id, teamId: fixture.homeTeamId, eventId: null }).run();
    backfillNameKeys(db);
    sqlite.close();
    return { fixture, unregisteredName: unregistered.canonicalName };
  }

  it("still writes (exit 0), reports onEventRoster=\"false\" on the summary line, and warns on stderr naming the player and event", async () => {
    const { unregisteredName } = seedUnregistered();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", unregisteredName, "2026-08-29", "available"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('onEventRoster="false"'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`"${unregisteredName}" is not registered for "Springfield Sectionals 2026"`),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("will not appear on that event's dossier"));

    const { db, sqlite } = openDb();
    try {
      // Stored regardless — this is a warning, not a refusal.
      expect(db.select().from(availability).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("the registered fixture player carries onEventRoster=\"true\" and no warning", async () => {
    const { fixture } = seedUnregistered();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", fixture.playerName, "2026-08-29", "available"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('onEventRoster="true"'));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Settles the --quiet question rather than leaving it implicit: `emit.ts`/GRAMMAR.md's own
  // contract is that `--quiet` suppresses only the stdout `status=ok` line, never anything written
  // to stderr (their own wording groups "errors, warnings" together) — this warning is exactly that,
  // printed unconditionally the same way `team pull`'s `cascadeFailureWarning` already is.
  it("--quiet suppresses the stdout summary line but NOT the not-registered warning", async () => {
    const { unregisteredName } = seedUnregistered();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", unregisteredName, "2026-08-29", "available", "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("is not registered"));
  });

  it("--json carries onEventRoster as a real boolean-shaped string field", async () => {
    const { unregisteredName } = seedUnregistered();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", unregisteredName, "2026-08-29", "available", "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({ status: "ok", onEventRoster: "false" });
  });
});

// The CLI half of the overlapping-events fix (Codex review of PR #47, rated high).
describe("tn player avail with an overlapping event day", () => {
  useTnDbPath();

  function seedOverlap() {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    setHomeTeam(db, team.id); // the real writer, never a raw isHome insert (test/helpers/home-team.ts)
    const player = db.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    db.insert(events)
      .values({ name: "HOA 40&over3.5M Spring 2026", kind: "league", startsOn: "2026-03-01", endsOn: "2026-06-30" })
      .run();
    db.insert(events)
      .values({ name: "Heart of America Districts", kind: "tournament", startsOn: "2026-05-15", endsOn: "2026-05-17" })
      .run();
    backfillNameKeys(db);
    sqlite.close();
    return { playerId: player.id };
  }

  it("refuses without an event name, listing the candidates and saying to name one", async () => {
    seedOverlap();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "avail", "Randy Rostered", "2026-05-16", "available"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("falls within more than one event"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("name the one you mean"));
  });

  it("accepts the event as a fourth positional and writes against it", async () => {
    const { playerId } = seedOverlap();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "player", "avail", "Randy Rostered", "2026-05-16", "available", "Heart of America Districts",
    ]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('event="Heart of America Districts"'));

    const { db, sqlite } = openDb();
    try {
      const rows = db.select().from(availability).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playerId, day: "2026-05-16", status: "available" });
    } finally {
      sqlite.close();
    }
  });

  it("still refuses a fifth positional — the payload count did not become unbounded", async () => {
    seedOverlap();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch([
      "player", "avail", "Randy Rostered", "2026-05-16", "available", "Heart of America Districts", "extra",
    ]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected extra argument"));
  });

  it("refuses a named event that does not cover the day", async () => {
    seedOverlap();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch([
      "player", "avail", "Randy Rostered", "2026-06-20", "available", "Heart of America Districts",
    ]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("does not cover day"));
  });
});
