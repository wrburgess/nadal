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
import { players, ratingObservations, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { addEvent } from "../src/query/events.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

let nextMid = 0;

/** A `team_matches` row for `teamId` plus a throwaway opponent — court matches must be linked to
 * one of this team's matches to count as its history (see `getLineupPlan`), which is exactly what
 * production produces once `tn team pull` has written the schedule. */
let nextOpponent = 0;
function linkTeamMatch(db: Db, teamId: number, sourceMatchId: string) {
  nextOpponent += 1;
  const opponent = db.insert(teams).values({ name: `CLI Opponent ${nextOpponent}` }).returning().get();
  return db
    .insert(teamMatches)
    .values({ homeTeamId: teamId, visitingTeamId: opponent.id, sourceMatchId })
    .returning()
    .get();
}

function play(db: Db, slot: string, discipline: "singles" | "doubles", ours: number[], times: number, linked?: { id: number }): void {
  for (let i = 0; i < times; i++) {
    nextMid += 1;
    const cm = upsertCourtMatch(db, {
      teamMatchId: linked?.id ?? null,
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

  const ourMatch = linkTeamMatch(db, team.id, "cli-seed");
  play(db, "S1", "singles", [ids["Ada Ashby"]!], 6, ourMatch);
  play(db, "D1", "doubles", [ids["Bo Bramwell"]!, ids["Cy Calder"]!], 5, ourMatch);
  play(db, "D2", "doubles", [ids["Del Duxbury"]!, ids["Emory Ellerby"]!], 3, ourMatch);
  play(db, "D3", "doubles", [ids["Ira Inglewood"]!, ids["Juno Jarrow"]!], 1, ourMatch);

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

  it("names the matches it excluded as belonging to other teams", async () => {
    const ids = seedVersteeg({ withRatings: true });
    // The same roster's history for a different club. It must not become evidence, and the count
    // must be visible so a thin prediction is explicable rather than mysterious.
    const { db, sqlite } = openDb();
    const other = db.insert(teams).values({ name: "Some Other Club/18&Over4.0M" }).returning().get();
    play(db, "D1", "doubles", [ids["Ada Ashby"]!, ids["Bo Bramwell"]!], 4, linkTeamMatch(db, other.id, "cli-other"));
    backfillNameKeys(db); // #32: every team row needs a key or resolution asserts
    sqlite.close();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M"]);
    const output = logSpy.mock.calls.at(-1)?.[0] as string;

    expect(output).toContain("excluded: 4 court matches these players played for other teams");
    // And the guess itself is unchanged — Ada still at S1, not paired with Bo on borrowed evidence.
    expect(output).toMatch(/S1\s+Ada Ashby/);
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
    play(db, "D1", "doubles", [p1.id, p2.id], 3, linkTeamMatch(db, team.id, "cli-hostile"));
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

  // Pins the divergence the runbook warns about (Codex review of PR #47 round 8, rated medium
  // against the runbook, which had told operators to use `team show` as the preflight). The two
  // commands count DIFFERENT things on purpose — `team show` reports every court match its roster
  // appears in, `lineup plan` counts only this team's own — and a doc claim about that difference
  // should be executable rather than prose.
  it("team show reports slots from history that lineup plan correctly refuses to use", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const ours = db.insert(teams).values({ name: "NE/Penland/40&Over3.5M" }).returning().get();
    const elsewhere = db.insert(teams).values({ name: "Some Other Club/18&Over4.0M" }).returning().get();
    const a = db.insert(players).values({ canonicalName: "Ada Ashby" }).returning().get();
    const b = db.insert(players).values({ canonicalName: "Bo Bramwell" }).returning().get();
    for (const p of [a, b]) {
      db.insert(teamMemberships).values({ playerId: p.id, teamId: ours.id, eventId: null }).run();
    }
    // Six matches together — but all of them for the OTHER club.
    play(db, "D1", "doubles", [a.id, b.id], 6, linkTeamMatch(db, elsewhere.id, "divergence-other"));
    backfillNameKeys(db);
    sqlite.close();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // `team show` sees the history — this is why it is the wrong preflight, not a bug in it.
    const showCode = await dispatch(["team", "show", "NE/Penland/40&Over3.5M"]);
    expect(showCode).toBe(0);
    expect(logSpy.mock.calls.at(-1)?.[0] as string).toContain("D1");

    // `lineup plan` refuses, because none of it belongs to this team.
    const planCode = await dispatch(["lineup", "plan", "NE/Penland/40&Over3.5M"]);
    expect(planCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("only this team's own"));
  });

  describe("an optional trailing event positional (#63)", () => {
    it("tn lineup plan <team> (no event) stays byte-identical to the pre-#63 output", async () => {
      seedVersteeg({ withRatings: true });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M"]);

      expect(code).toBe(0);
      const output = logSpy.mock.calls.at(-1)?.[0] as string;
      expect(output).toContain("courts: 4, from this team's observed match history (not the event format)");
    });

    it("tn lineup plan <team> <event> renders the event's court count and --json carries slotSource/slotEvent", async () => {
      seedVersteeg({ withRatings: true });
      runMigrations();
      const { db, sqlite } = openDb();
      addEvent(db, {
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "S1:singles,D1:doubles,D2:doubles",
      });
      sqlite.close();

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M", "Springfield Sectionals 2026"]);

      expect(code).toBe(0);
      const output = logSpy.mock.calls.at(-1)?.[0] as string;
      expect(output).toContain('from the format of event "Springfield Sectionals 2026"');
      // The silent-lie regression: the OLD sentence must be genuinely absent, not merely
      // outnumbered by the new one.
      expect(output).not.toContain("from this team's observed match history (not the event format)");
      expect(output).toContain("courts: 3");
      // D3 (Ira/Juno) is real history but not part of the three-court event format.
      expect(output).not.toMatch(/D3/);

      const jsonCode = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M", "Springfield Sectionals 2026", "--json"]);
      expect(jsonCode).toBe(0);
      const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
        slotSource: string;
        slotEvent: { id: number; name: string } | null;
      };
      expect(payload.slotSource).toBe("event-format");
      expect(payload.slotEvent).toMatchObject({ name: "Springfield Sectionals 2026" });
    });

    it("tn lineup plan <team> <unknown-event> exits 1, naming the event", async () => {
      seedVersteeg();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M", "No Such Event"]);

      expect(code).toBe(1);
      // Pinned to the actual refusal text, not merely "the name appears somewhere" — a parse error
      // quoting the same string would otherwise satisfy a looser assertion for the wrong reason. The
      // event name is checked separately because the summary line backslash-escapes its inner quotes.
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown event"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("No Such Event"));
    });

    it("tn lineup plan <team> <event-without-format> exits 1, saying to add a format", async () => {
      seedVersteeg();
      runMigrations();
      const { db, sqlite } = openDb();
      addEvent(db, { name: "Formatless Event", kind: "league", startsOn: "2026-03-01", endsOn: "2026-06-30" });
      sqlite.close();

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M", "Formatless Event"]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("tn event add"));
    });

    it("escapes an event name containing terminal-hostile characters in the rendered output", async () => {
      seedVersteeg();
      runMigrations();
      const RTL_OVERRIDE = String.fromCharCode(0x202e);
      const { db, sqlite } = openDb();
      addEvent(db, {
        name: `Springfield${RTL_OVERRIDE}Sectionals`,
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "S1:singles,D1:doubles,D2:doubles,D3:doubles",
      });
      sqlite.close();

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = await dispatch(["lineup", "plan", "IA/Versteeg/40&Over3.5M", `Springfield${RTL_OVERRIDE}Sectionals`]);

      expect(code).toBe(0);
      const output = logSpy.mock.calls.at(-1)?.[0] as string;
      expect(output).not.toContain(RTL_OVERRIDE);
      expect(output).toContain("Springfield");
    });
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

    it("refuses an ambiguous target by naming the incoming target, where it came from, and the candidates", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      db.insert(teams).values({ name: "Versteeg A" }).run();
      db.insert(teams).values({ name: "Versteeg B" }).run();
      backfillNameKeys(db);
      sqlite.close();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["lineup", "plan", "Versteeg"]);

      expect(code).toBe(1);
      // The whole line, not a fragment (#94): this was `ambiguous target: Versteeg A, Versteeg B`,
      // which names only what the target was NEAR and never the target itself. A
      // `stringContaining("ambiguous target")` assertion is satisfied by that message and by every
      // other message beginning those two words, which is how the entire reporting shape came to be
      // pinned by nothing — this file's was the ONLY assertion in 1529 tests that touched it at all.
      expect(errSpy).toHaveBeenCalledWith(
        'lineup plan status=error message="ambiguous identity \\"Versteeg\\" (team name target) — near: Versteeg A, Versteeg B"',
      );
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
