// `tn lineup plan` (#17 PR B). The heuristic is specified in `query-derive-lineup.test.ts` and the
// assembly in `query-lineup.test.ts`; these tests cover the presenter, and in particular the one
// property the whole feature turns on: **the rendered output has to keep saying it is a guess.**
// Spec § Deliverables 1 asks for a "predicted lineup honestly labeled a guess", and a table that
// looks like a lineup card is the largest risk here — so the label, the per-slot confidence, the
// rating scale, the slot-set provenance and the not-placed list are each asserted, not assumed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { players, ratingObservations, teamMemberships, teams } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

let nextMid = 0;

function play(db: Db, slot: string, discipline: "singles" | "doubles", ours: number[], times: number): void {
  for (let i = 0; i < times; i++) {
    nextMid += 1;
    const cm = upsertCourtMatch(db, {
      teamMatchId: null,
      slot,
      discipline,
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: `cli-lineup-${nextMid}`,
    });
    for (const playerId of ours) upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId, side: "home" });
  }
}

const ROSTER = ["Ada Ashby", "Bo Bramwell", "Cy Calder", "Del Duxbury", "Emory Ellerby", "Ira Inglewood", "Juno Jarrow"];

/** A team with a clean four-court history: S1 to Ada, and three settled partnerships. */
function seedVersteeg(options: { withRatings?: boolean; extraPlayers?: string[] } = {}): Record<string, number> {
  runMigrations();
  const { db, sqlite } = openDb();
  const team = db.insert(teams).values({ name: "IA/Versteeg/40&Over3.5M" }).returning().get();
  const ids: Record<string, number> = {};
  for (const name of [...ROSTER, ...(options.extraPlayers ?? [])]) {
    const p = db.insert(players).values({ canonicalName: name }).returning().get();
    ids[name] = p.id;
    db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
  }

  play(db, "S1", "singles", [ids["Ada Ashby"]!], 6);
  play(db, "D1", "doubles", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 5);
  play(db, "D2", "doubles", [ids["Del Duxbury"]!, ids["Emory Ellerby"]!], 3);
  play(db, "D3", "doubles", [ids["Ira Inglewood"]!, ids["Juno Jarrow"]!], 1);

  if (options.withRatings === true) {
    for (const [name, value] of [
      ["Ada Ashby", 4.2],
      ["Bo Bramwell", 4.1],
      ["Cy Calder", 4.0],
      ["Del Duxbury", 3.9],
      ["Emory Ellerby", 3.8],
      ["Ira Inglewood", 3.7],
    ] as const) {
      db.insert(ratingObservations)
        .values({ playerId: ids[name]!, source: "ntrp", value, ratingType: "C", observedOn: "2026-05-01" })
        .run();
    }
  }

  backfillNameKeys(db);
  sqlite.close();
  return ids;
}

describe("tn lineup plan (end-to-end via dispatch)", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("renders the lineup and labels it a guess, exit 0", async () => {
    seedVersteeg({ withRatings: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M"]);

    expect(code).toBe(0);
    const output = logSpy.mock.calls.at(-1)?.[0] as string;

    expect(output).toContain("PREDICTED LINEUP — IA/Versteeg/40&Over3.5M");
    expect(output, "the honesty label spec § Deliverables 1 requires").toContain("This is a guess, not a lineup card");
    expect(output).toContain("15 observed court matches");

    // The placements themselves.
    expect(output).toMatch(/S1\s+Ada Ashby/);
    expect(output).toMatch(/D1\s+Bo Bramwell/);
    expect(output).toContain("Cy Calder");
    expect(output).toMatch(/D2\s+Del Duxbury/);

    // Provenance: the rating scale it ranked within, and where the court set came from.
    expect(output).toContain("ranked within NTRP");
    expect(output).toContain("unrated: Juno Jarrow");
    expect(output).toContain("from this team's observed match history (not the event format)");
  });

  it("distinguishes a confident placement from a rating-only guess in the rendered text", async () => {
    seedVersteeg({ withRatings: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M"]);
    const output = logSpy.mock.calls.at(-1)?.[0] as string;

    // D1's pair has five matches together; D3's has one, which is below the partnership bar, so it
    // is a rating placement and must not read like the same kind of claim.
    expect(output).toMatch(/D1[^\n]*conf: high[^\n]*5 matches together/);
    expect(output).toMatch(/D3[^\n]*placed by rating — no shared history/);
  });

  it("names everyone it could not place, with their evidence", async () => {
    seedVersteeg({ withRatings: true, extraPlayers: ["Kit Kestrel"] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M"]);
    const output = logSpy.mock.calls.at(-1)?.[0] as string;

    expect(output).toContain("not placed: Kit Kestrel (0 court matches)");
  });

  it("says so plainly when nobody on the roster is rated", async () => {
    seedVersteeg({ withRatings: false });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M"]);
    const output = logSpy.mock.calls.at(-1)?.[0] as string;

    expect(output).toContain("ratings: none on file");
  });

  it("--json emits the structured plan with its confidence and basis fields", async () => {
    seedVersteeg({ withRatings: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M", "--json"]);

    expect(code).toBe(0);
    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      teamName: string;
      ratingSource: string;
      slotSource: string;
      slots: { slot: string; confidence: string; basis: string; support: number; players: { canonicalName: string }[] }[];
    };

    expect(payload.teamName).toBe("IA/Versteeg/40&Over3.5M");
    expect(payload.ratingSource).toBe("ntrp");
    expect(payload.slotSource).toBe("observed");
    expect(payload.slots.map((s) => s.slot)).toEqual(["S1", "D1", "D2", "D3"]);
    expect(payload.slots.find((s) => s.slot === "D1")).toMatchObject({
      confidence: "high",
      basis: "history",
      support: 5,
    });
    expect(payload.slots.find((s) => s.slot === "D3")).toMatchObject({ basis: "rating", support: 0 });
  });

  // The end-to-end half of the --json sanitization fix (Codex review of PR #47, rated medium):
  // the emitJson unit tests prove the helper works, this proves the command actually uses it.
  it("--json strips a bidi override out of a scraped player name", async () => {
    const RTL_OVERRIDE = String.fromCharCode(0x202e);
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "IA/Versteeg/40&Over3.5M" }).returning().get();
    const hostile = `Ada${RTL_OVERRIDE}Ashby`;
    const p1 = db.insert(players).values({ canonicalName: hostile }).returning().get();
    const p2 = db.insert(players).values({ canonicalName: "Bo Bramwell" }).returning().get();
    for (const p of [p1, p2]) {
      db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
    }
    play(db, "D1", "doubles", [p1.id, p2.id], 3);
    backfillNameKeys(db);
    sqlite.close();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M", "--json"]);

    expect(code).toBe(0);
    const line = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(line, "a bidi override must not reach the terminal through --json").not.toContain(RTL_OVERRIDE);
    // Still valid JSON carrying the same record, just with the hostile character neutralized.
    const payload = JSON.parse(line) as { slots: { players: { canonicalName: string }[] }[] };
    expect(payload.slots[0]!.players.map((pl) => pl.canonicalName).some((n) => n.startsWith("Ada"))).toBe(true);
  });

  it("--quiet suppresses stdout but still exits 0", async () => {
    seedVersteeg({ withRatings: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M", "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  describe("refusals", () => {
    it("refuses a team with no court-match history and says what to run instead", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      db.insert(teams).values({ name: "NE/Penland/40&Over3.5M" }).run();
      backfillNameKeys(db);
      sqlite.close();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["lineup", "plan", "NE/Penland/40&Over3.5M"]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("no court-match history on file"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("tn team pull --players"));
    });

    it("refuses an unknown target", async () => {
      seedVersteeg();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["lineup", "plan", "Nobody FC"]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown target"));
    });

    it("refuses an ambiguous target by listing the candidates rather than guessing", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      db.insert(teams).values({ name: "Versteeg A" }).run();
      db.insert(teams).values({ name: "Versteeg B" }).run();
      backfillNameKeys(db);
      sqlite.close();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["lineup", "plan", "Versteeg"]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("ambiguous target"));
    });

    it("refuses a missing target", async () => {
      seedVersteeg();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["lineup", "plan"]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("missing target"));
    });

    it("refuses an unrecognized flag rather than ignoring it", async () => {
      seedVersteeg();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M", "--jsno"]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --jsno"));
    });
  });
});
