import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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

// Independent-reviewer finding, ROUND 2 of #17 PR A (Codex, medium, category A) — a defect LEFT BY
// the round-1 fix, which is this repo's documented recurring shape. `dispatch()` checked
// `argv.includes("--help")` across the whole of argv before any command parser ran, so it silently
// outranked the `--` end-of-flags delimiter round 1 had just added: `tn player note Randy -- --help`
// printed help and exited 0 instead of recording the note, for exactly one token — while the MCP
// `player_note` tool accepted the identical text, leaving the two surfaces disagreeing. Help
// detection is now delimiter-aware.
describe("tn player note — `--help` as literal note text (round-2 reviewer finding)", () => {
  useTnDbPath();

  function seedFixture() {
    runMigrations();
    const { db, sqlite } = openDb();
    const fixture = seedHomeTeamFixture(db);
    sqlite.close();
    return fixture;
  }

  it("records a note that is literally `--help` when it follows the delimiter", async () => {
    const fixture = seedFixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await dispatch(["player", "note", String(fixture.playerName), "--", "--help"]);
      expect(code).toBe(0);
      // The property that matters is the stored note, not the exit code: printing help ALSO exits 0,
      // so asserting only the code would pass against the very defect this test exists for.
      const { db, sqlite } = openDb();
      const notes = db.select().from(captainNotes).all();
      sqlite.close();
      expect(notes).toHaveLength(1);
      expect(notes[0]!.note).toBe("--help");
    } finally {
      log.mockRestore();
    }
  });

  it("still prints help for `--help` BEFORE any delimiter, and writes nothing", async () => {
    seedFixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await dispatch(["player", "note", "--help"]);
      expect(code).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toContain("tn <noun> <verb>");
      const { db, sqlite } = openDb();
      const notes = db.select().from(captainNotes).all();
      sqlite.close();
      expect(notes).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });
});

// Issue #150. `captain_notes.pair_player_id` has been in the schema since #17 PR A, with two
// renderers reading it (the dossier's own-team book and `format-lineup-build.ts:240`), but the ONLY
// writer that could set it was the `player_note` MCP tool — a surface `request_log` shows had never
// been used in 407 invocations. The optional trailing positional added here follows the same shape
// `player avail`/`lineup plan`/`report build` use for `[event]` and `player distinct` uses for
// `[<near-name>]` (#142): the note TEXT keeps a fixed position, so arity never decides what a
// positional MEANS — `tn player note Randy Mark` records a note reading "Mark" about Randy and
// cannot be misread as a pairing.
describe("tn player note — the pairing positional (#150)", () => {
  useTnDbPath();

  function seedFixture() {
    runMigrations();
    const { db, sqlite } = openDb();
    const fixture = seedHomeTeamFixture(db);
    sqlite.close();
    return fixture;
  }

  /** Adds another player to the SAME home team + event as the fixture's own. `backfillNameKeys` is
   * required because these tests resolve the partner BY NAME through the CLI (#32 made resolution
   * index-backed) — the service-level tests in `query-captain-notes.test.ts` pass ids and so do not
   * need it, which is exactly why this helper cannot be borrowed from there. */
  function addHomeRosterPlayer(fixture: { homeTeamId: number; eventId: number }, canonicalName: string) {
    const { db, sqlite } = openDb();
    try {
      const player = db.insert(players).values({ canonicalName }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: fixture.homeTeamId, eventId: fixture.eventId }).run();
      backfillNameKeys(db);
      return player;
    } finally {
      sqlite.close();
    }
  }

  it("records a pairing note with pair_player_id set to the partner", async () => {
    const fixture = seedFixture();
    const partner = addHomeRosterPlayer(fixture, "Bryan Partner");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "Strong ad side together.", partner.canonicalName]);

    expect(code).toBe(0);
    const { db, sqlite } = openDb();
    try {
      const rows = db.select().from(captainNotes).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        playerId: fixture.playerId,
        pairPlayerId: partner.id,
        note: "Strong ad side together.",
      });
    } finally {
      sqlite.close();
    }
  });

  // The regression that matters most: the solo form is the one every existing caller uses, and the
  // whole change is a widened positional count. Asserting `pairPlayerId` is NULL is what tells a
  // solo note apart from one that silently acquired a partner.
  it("the solo form still writes pair_player_id NULL", async () => {
    const fixture = seedFixture();
    addHomeRosterPlayer(fixture, "Bryan Partner");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "Plays doubles only."]);

    expect(code).toBe(0);
    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(captainNotes).all()[0]!.pairPlayerId).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("the summary line carries pair= on the pair form and OMITS it on the solo form", async () => {
    const fixture = seedFixture();
    const partner = addHomeRosterPlayer(fixture, "Bryan Partner");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["player", "note", fixture.playerName, "Together.", partner.canonicalName]);
    const paired = logSpy.mock.calls[0]?.[0] as string;
    await dispatch(["player", "note", fixture.playerName, "Alone."]);
    const solo = logSpy.mock.calls[1]?.[0] as string;

    expect(paired).toMatch(/^player note status=ok player=".+" pair="Bryan Partner" note=".+"$/);
    // An empty `pair=""` would read as "a pairing note whose partner has no name" rather than "not a
    // pairing note", which is the same distinction the dossier draws between `—` and `unavailable`.
    expect(solo).not.toContain("pair=");
  });

  it("--json carries the partner", async () => {
    const fixture = seedFixture();
    const partner = addHomeRosterPlayer(fixture, "Bryan Partner");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "Together.", partner.canonicalName, "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({ status: "ok", pair: "Bryan Partner" });
  });

  it("an unknown partner name exits 1, names the partner, and writes nothing", async () => {
    const fixture = seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "Together.", "Nobody Here"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("Nobody Here");
    // Without this the test passes against the PRE-change code for the wrong reason: a third
    // positional was an "unexpected extra argument" refusal, and that message quotes the offending
    // token — so `toContain("Nobody Here")` alone is satisfied by the arity error it is not testing.
    expect(printed).not.toContain("unexpected");
    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(captainNotes).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  // The diagnostic has to say which NAME was ambiguous. Copying the target's block and leaving its
  // `context:` string unchanged would report a partner collision as a target collision — the reader
  // then re-checks a name that was never in question.
  it("an ambiguous partner name says the PARTNER was ambiguous, not the target", async () => {
    const fixture = seedFixture();
    addHomeRosterPlayer(fixture, "Bryan Partner");
    addHomeRosterPlayer(fixture, "Bryan Partnex"); // edit distance 1 — fires the fuzzy tier
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "Together.", "Bryan Partne"]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("ambiguous");
    expect(printed).toContain("pairing partner");
    expect(printed).not.toContain("player name target");
  });

  // `SelfPairingCaptainNoteError` has been imported and classified in player-note.ts since #17 PR A
  // while being UNREACHABLE from the CLI — dead error-handling for a feature the command could not
  // reach. This is the test that makes it live.
  it("naming the player as their own partner refuses", async () => {
    const fixture = seedFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "Self.", fixture.playerName]);

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0] as string).toContain("themselves");
    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(captainNotes).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  // With two players in play a bare `player 47 is not on the home team's roster` cannot say WHICH of
  // them failed. These two tests pin the distinction in both directions.
  it("a partner off the home roster names the PARTNER", async () => {
    const fixture = seedFixture();
    const { db, sqlite } = openDb();
    const stranger = db.insert(players).values({ canonicalName: "Outside Partner" }).returning().get();
    backfillNameKeys(db);
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "Together.", stranger.canonicalName]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("roster");
    expect(printed).toContain("Outside Partner");
    expect(printed).not.toContain(fixture.playerName);
  });

  it("a target off the home roster still names the TARGET even when a partner is supplied", async () => {
    const fixture = seedFixture();
    const partner = addHomeRosterPlayer(fixture, "Bryan Partner");
    const { db, sqlite } = openDb();
    const stranger = db.insert(players).values({ canonicalName: "Outside Subject" }).returning().get();
    backfillNameKeys(db);
    sqlite.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", stranger.canonicalName, "Together.", partner.canonicalName]);

    expect(code).toBe(1);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("Outside Subject");
    expect(printed).not.toContain("Bryan Partner");
  });

  it("empty text still refuses when a partner is supplied — the partner does not rescue it", async () => {
    const fixture = seedFixture();
    const partner = addHomeRosterPlayer(fixture, "Bryan Partner");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "   ", partner.canonicalName]);

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0] as string).toContain("empty");
  });

  // The arity boundary in the other direction: two payload positionals is the maximum, so a third
  // is still the ordinary "unexpected extra argument" refusal rather than a silently dropped token.
  it("a THIRD payload positional is still an unexpected extra argument", async () => {
    const fixture = seedFixture();
    const partner = addHomeRosterPlayer(fixture, "Bryan Partner");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "Together.", partner.canonicalName, "extra"]);

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0] as string).toContain("unexpected");
    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(captainNotes).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  // Every existing delimiter test covers the TWO-positional form only. A note beginning with `--`
  // and a partner after it is the combination this change newly makes expressible.
  it("records a `--`-leading note AND a partner after the delimiter", async () => {
    const fixture = seedFixture();
    const partner = addHomeRosterPlayer(fixture, "Bryan Partner");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "note", fixture.playerName, "--", "--poach at net", partner.canonicalName]);

    expect(code).toBe(0);
    const { db, sqlite } = openDb();
    try {
      const rows = db.select().from(captainNotes).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ note: "--poach at net", pairPlayerId: partner.id });
    } finally {
      sqlite.close();
    }
  });

  it("two identical pairing notes append two rows — never an upsert", async () => {
    const fixture = seedFixture();
    const partner = addHomeRosterPlayer(fixture, "Bryan Partner");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["player", "note", fixture.playerName, "Same.", partner.canonicalName]);
    await dispatch(["player", "note", fixture.playerName, "Same.", partner.canonicalName]);

    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(captainNotes).all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });
});
