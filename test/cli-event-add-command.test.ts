import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { availability, events, players, teamMemberships, teams } from "../src/db/schema.js";
import { setHomeTeam } from "../src/query/home-team.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("tn event add (end-to-end via dispatch)", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("creates an event and prints a deterministic summary line, exit 0", async () => {
    runMigrations();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["event", "add", "Springfield Sectionals 2026", "tournament", "2026-08-28", "2026-08-30"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      'event add status=ok event="Springfield Sectionals 2026" kind="tournament" startsOn="2026-08-28" endsOn="2026-08-30" created="true"',
    );

    const { db, sqlite } = openDb();
    try {
      const rows = db.select().from(events).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
      });
    } finally {
      sqlite.close();
    }
  });

  it("a repeat under the same name updates in place and reports created=false", async () => {
    runMigrations();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["event", "add", "Springfield Sectionals 2026", "tournament", "2026-08-28", "2026-08-30"]);
    const code = await dispatch(["event", "add", "Springfield Sectionals 2026", "tournament", "2026-08-28", "2026-08-31"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining('created="false"'));

    const { db, sqlite } = openDb();
    try {
      const rows = db.select().from(events).all();
      expect(rows, "a repeat must not grow the table").toHaveLength(1);
      expect(rows[0]).toMatchObject({ endsOn: "2026-08-31" });
    } finally {
      sqlite.close();
    }
  });

  it("accepts an optional trailing format positional and reports the courts in the summary line", async () => {
    runMigrations();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "event",
      "add",
      "Springfield Sectionals 2026",
      "tournament",
      "2026-08-28",
      "2026-08-30",
      "S1:singles,D1:doubles",
    ]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('format="S1:singles,D1:doubles"'));

    const { db, sqlite } = openDb();
    try {
      const row = db.select().from(events).all()[0]!;
      expect(row.format).toEqual([
        { slot: "S1", discipline: "singles" },
        { slot: "D1", discipline: "doubles" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("omitting the format leaves the summary line BYTE IDENTICAL to before this feature existed", async () => {
    runMigrations();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["event", "add", "Springfield Sectionals 2026", "tournament", "2026-08-28", "2026-08-30"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      'event add status=ok event="Springfield Sectionals 2026" kind="tournament" startsOn="2026-08-28" endsOn="2026-08-30" created="true"',
    );
  });

  it("refuses an invalid format, naming the syntax, exit 1, nothing written", async () => {
    runMigrations();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch([
      "event",
      "add",
      "Springfield Sectionals 2026",
      "tournament",
      "2026-08-28",
      "2026-08-30",
      "garbage",
    ]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));

    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(events).all(), "an invalid format must write nothing").toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("a repeat that OMITS the format preserves the one already stored, end to end", async () => {
    runMigrations();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch([
      "event",
      "add",
      "Springfield Sectionals 2026",
      "tournament",
      "2026-08-28",
      "2026-08-30",
      "S1:singles,D1:doubles",
    ]);
    await dispatch(["event", "add", "Springfield Sectionals 2026", "tournament", "2026-08-28", "2026-08-31"]);

    const { db, sqlite } = openDb();
    try {
      const row = db.select().from(events).all()[0]!;
      expect(row.endsOn).toBe("2026-08-31");
      expect(row.format, "an omitted format on a repeat must not clobber the stored one").toEqual([
        { slot: "S1", discipline: "singles" },
        { slot: "D1", discipline: "doubles" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("--json replaces the summary line with the same fields", async () => {
    runMigrations();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "event", "add", "Springfield Sectionals 2026", "tournament", "2026-08-28", "2026-08-30", "--json",
    ]);

    expect(code).toBe(0);
    const line = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(JSON.parse(line)).toEqual({
      status: "ok",
      event: "Springfield Sectionals 2026",
      kind: "tournament",
      startsOn: "2026-08-28",
      endsOn: "2026-08-30",
      created: "true",
    });
  });

  it("--quiet suppresses stdout but still exits 0 and still writes", async () => {
    runMigrations();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "event", "add", "Springfield Sectionals 2026", "tournament", "2026-08-28", "2026-08-30", "--quiet",
    ]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();

    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(events).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  describe("refusals — non-zero exit, diagnostic on stderr, nothing written", () => {
    it.each([
      ["an unknown kind", ["Springfield", "sectionals", "2026-08-28", "2026-08-30"]],
      ["an impossible starts-on", ["Springfield", "tournament", "2026-02-31", "2026-08-30"]],
      ["an impossible ends-on", ["Springfield", "tournament", "2026-08-28", "2026-13-01"]],
      ["an inverted range", ["Springfield", "tournament", "2026-08-30", "2026-08-28"]],
    ])("refuses %s", async (_label, args) => {
      runMigrations();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["event", "add", ...args]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));

      const { db, sqlite } = openDb();
      try {
        expect(db.select().from(events).all(), "a refusal must write nothing").toHaveLength(0);
      } finally {
        sqlite.close();
      }
    });

    it("refuses moving an event's range off availability already recorded against it", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      const team = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
      setHomeTeam(db, team.id);
      const player = db.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
      backfillNameKeys(db);
      sqlite.close();

      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await dispatch(["event", "add", "Springfield Sectionals 2026", "tournament", "2026-08-28", "2026-08-30"]);
      await dispatch(["player", "avail", "Randy Rostered", "2026-08-29", "available"]);

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const code = await dispatch([
        "event", "add", "Springfield Sectionals 2026", "tournament", "2026-09-01", "2026-09-03",
      ]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("2026-08-29"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("widen the range"));

      const check = openDb();
      try {
        expect(check.db.select().from(events).all()[0]).toMatchObject({ endsOn: "2026-08-30" });
      } finally {
        check.sqlite.close();
      }
    });

    it("refuses a short invocation with the usage line", async () => {
      runMigrations();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["event", "add", "Springfield", "tournament"]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("usage: tn event add"));
    });

    it("refuses an unrecognized flag rather than ignoring it", async () => {
      runMigrations();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch([
        "event", "add", "Springfield", "tournament", "2026-08-28", "2026-08-30", "--jsno",
      ]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --jsno"));
    });

    it("refuses an extra positional rather than silently dropping it", async () => {
      runMigrations();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      // Six positionals: name + kind + starts-on + ends-on + format (the now-documented fifth) +
      // one genuinely extra token beyond that.
      const code = await dispatch([
        "event", "add", "Springfield", "tournament", "2026-08-28", "2026-08-30", "S1:singles", "extra",
      ]);

      expect(code).toBe(1);
      // The summary line quotes every value and escapes inner quotes, so the message reaches
      // stderr as `message="unexpected extra argument \"extra\""` — asserted in that exact form
      // rather than on a loose prefix, so a change to the escaping is not silently absorbed.
      expect(errSpy).toHaveBeenCalledWith('event add status=error message="unexpected extra argument \\"extra\\""');
    });
  });

  // The user-visible reason this command exists: before it, `tn player avail` had no reachable path
  // to an event and always failed. Exercised through `dispatch` on both commands, so it covers the
  // real CLI sequence rather than the service pair the query-level test already covers.
  it("makes tn player avail reachable end to end", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    setHomeTeam(db, team.id);
    const player = db.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    backfillNameKeys(db);
    sqlite.close();

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const availBefore = await dispatch(["player", "avail", "Randy Rostered", "2026-08-29", "available"]);
    expect(availBefore, "no event on file yet, so this must still refuse").toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));

    await dispatch(["event", "add", "Springfield Sectionals 2026", "tournament", "2026-08-28", "2026-08-30"]);

    const availAfter = await dispatch(["player", "avail", "Randy Rostered", "2026-08-29", "available"]);
    expect(availAfter).toBe(0);

    const check = openDb();
    try {
      const rows = check.db.select().from(availability).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playerId: player.id, day: "2026-08-29", status: "available" });
    } finally {
      check.sqlite.close();
    }
  });
});
