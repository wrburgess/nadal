// `tn lineup build` (#127), end to end through `dispatch`. The rules are specified exhaustively in
// `query-derive-lineup-build.test.ts` and the assembly in `query-lineup-build.test.ts`; what these
// tests cover is the part neither layer can see — **the page a captain actually reads.**
//
// The risk this feature carries is the one `format-lineup.ts` was written against, one step worse: a
// built lineup looks like a lineup card, because it is one. So every disclosure is asserted
// INDIVIDUALLY rather than by matching a blob — the eligibility ledger with its three distinct
// absence states, each court's evidence, who sits, the rating scale, the roster source, the excluded
// evidence, the shortfall, the strategy rules, the collapse of identical scenarios, and the standing
// limits. If one of those lines silently disappeared, one of these tests goes red.

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { isLineupBuildRefusal } from "../src/cli/commands/lineup-build.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import {
  availability,
  events,
  players,
  requestLog,
  teamMatches,
  teamMemberships,
  teams,
} from "../src/db/schema.js";
import { setEventRoster } from "../src/ingest/roster-set.js";
import { upsertCourtMatch, upsertCourtMatchPlayers, upsertRatingObservation } from "../src/ingest/upsert.js";
import { UnknownEventError as UnknownEventForDayError } from "../src/query/availability.js";
import { addCaptainNote } from "../src/query/captain-notes.js";
import { EmptySlotSetError } from "../src/query/derive-lineup-build.js";
import { addEvent } from "../src/query/events.js";
import { setHomeTeam } from "../src/query/home-team.js";
import { UnknownEventError } from "../src/query/lineup.js";
import { seedAvailabilityMatrix } from "./helpers/availability-matrix.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

const TEAM = "HOA/Burgess-Zingg/40&over3.5M";
const EVENT = "Springfield Sectionals 2026";
const FORMAT = "S1:singles,D1:doubles,D2:doubles,D3:doubles";
const FRIDAY = "2026-08-28";
const SATURDAY = "2026-08-29";
const SUNDAY = "2026-08-30";

/** Eight who say yes, named so alphabetical order, insertion order and rating order all agree —
 * which is what lets every expected placement below be reasoned about rather than copied from a run. */
const AVAILABLE = [
  "Ada Ashby",
  "Bo Bramwell",
  "Cy Calder",
  "Del Duxbury",
  "Emory Ellerby",
  "Fay Fenwick",
  "Gil Garrow",
  "Hana Hollis",
];
/** Assigned POSITIONALLY over whatever `available` list a test supplies, so a test may rename a
 * player (e.g. to carry a hostile character) without also having to re-key a ratings map. */
const RATING_VALUES = [4.5, 4.4, 4.3, 4.2, 4.1, 4.0, 3.9, 3.8];

const UNAVAILABLE = "Ira Inglewood";
const UNCERTAIN = "Jo Jarrow";
const UNRECORDED = "Kit Kestrel";
const SEASON_ONLY = "Lou Larkin";

type SeedOptions = {
  /** Who answers "available" on SATURDAY. Defaults to all eight. */
  available?: string[];
  /** Rating values, positional over `available`. `null` seeds none at all (the degenerate scale). */
  ratings?: number[] | null;
  ratingSource?: string;
  /** `null` records the event with NO format column, the `EventHasNoFormatError` fixture. */
  format?: string | null;
  /** `false` skips `setEventRoster`, leaving the season roster as the field. */
  register?: boolean;
};

type Fixture = { teamId: number; ourMatchId: number; ids: Record<string, number> };

/**
 * A home team, an event with a court list, a roster whose members answer differently on the target
 * day, and one `team_matches` row so a court match can be linked to THIS team.
 *
 * Seeded through the real writers (`setHomeTeam`, `addEvent`, `setEventRoster`, `setAvailability`
 * via `seedAvailabilityMatrix`, `upsertRatingObservation`) rather than by inserting rows, so no test
 * below can pass against a database state production could not produce.
 */
function seedDay(options: SeedOptions = {}): Fixture {
  const available = options.available ?? AVAILABLE;
  const ratings = options.ratings === undefined ? RATING_VALUES : options.ratings;
  const format = options.format === undefined ? FORMAT : options.format;

  runMigrations();
  const { db, sqlite } = openDb();
  try {
    const team = db.insert(teams).values({ name: TEAM }).returning().get();
    setHomeTeam(db, team.id);
    addEvent(db, {
      name: EVENT,
      kind: "tournament",
      startsOn: FRIDAY,
      endsOn: SUNDAY,
      ...(format === null ? {} : { format }),
    });

    const roster = [...available, UNAVAILABLE, UNCERTAIN, UNRECORDED, SEASON_ONLY];
    const ids: Record<string, number> = {};
    for (const name of roster) {
      const player = db.insert(players).values({ canonicalName: name }).returning().get();
      ids[name] = player.id;
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    }

    const opponent = db.insert(teams).values({ name: "Opponent Team" }).returning().get();
    const ourMatch = db
      .insert(teamMatches)
      .values({ homeTeamId: team.id, visitingTeamId: opponent.id, sourceMatchId: "own-1" })
      .returning()
      .get();

    // Before the name-resolving writer below, never after.
    backfillNameKeys(db);

    if (options.register !== false) {
      // Everyone but SEASON_ONLY registers, so `registered` and `season` differ by exactly one and
      // the roster-source line has two distinct counts to state.
      const result = setEventRoster(db, {
        team: TEAM,
        event: EVENT,
        players: [...available, UNAVAILABLE, UNCERTAIN, UNRECORDED],
      });
      if (!result.ok) throw new Error(`fixture: setEventRoster refused (${result.kind})`);
    }

    if (ratings !== null) {
      available.forEach((name, index) => {
        const value = ratings[index];
        if (value === undefined) return;
        upsertRatingObservation(db, {
          playerId: ids[name]!,
          source: options.ratingSource ?? "ntrp",
          value,
          ratingType: null,
          observedOn: "2026-01-01",
        });
      });
    }

    // The four answer states, on the target day only. UNRECORDED gets no row at all — the state a
    // fixture that could only express "unavailable" would make untestable.
    const answering = [...available, UNAVAILABLE, UNCERTAIN, UNRECORDED];
    seedAvailabilityMatrix(db, {
      players: answering.map((n) => ids[n]!),
      days: [SATURDAY],
      statuses: answering.map((name) => {
        if (name === UNAVAILABLE) return ["unavailable" as const];
        if (name === UNCERTAIN) return ["uncertain" as const];
        if (name === UNRECORDED) return [null];
        return ["available" as const];
      }),
    });

    return { teamId: team.id, ourMatchId: ourMatch.id, ids };
  } finally {
    sqlite.close();
  }
}

let nextMid = 0;

/** `times` doubles court matches with `pair` on the same side, linked to `teamMatchId` (ours) or to
 * some other team's match (evidence that must NOT count). */
function playDoubles(
  db: Db,
  pair: [number, number],
  times: number,
  teamMatchId: number,
  /** Which side the pair sat on; `"home"` is OUR side on `ourMatchId`. */
  side: "home" | "visiting" = "home",
): void {
  for (let i = 0; i < times; i++) {
    nextMid += 1;
    const court = upsertCourtMatch(db, {
      teamMatchId,
      slot: "D1",
      discipline: "doubles",
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: `cli-build-${nextMid}`,
    });
    for (const playerId of pair) upsertCourtMatchPlayers(db, { courtMatchId: court.id, playerId, side });
  }
}

function withDb<T>(fn: (db: Db) => T): T {
  const { db, sqlite } = openDb();
  try {
    return fn(db);
  } finally {
    sqlite.close();
  }
}

/** Where the evidence column starts on every filled court row of the whole page. One entry means one
 * column layout across every scenario's table; more than one means the tables do not line up. */
function ratingColumnOffsets(output: string): Set<number> {
  return new Set(
    output
      .split("\n")
      .filter((line) => /(NTRP|WTN-S) \d/.test(line))
      .map((line) => line.search(/(NTRP|WTN-S) \d/)),
  );
}

async function render(argv: string[] = ["lineup", "build", SATURDAY]): Promise<{ code: number; output: string }> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const code = await dispatch(argv);
  return { code, output: (logSpy.mock.calls.at(-1)?.[0] as string) ?? "" };
}

describe("tn lineup build — the page a captain reads", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("heads the page with the day, the event and the team", async () => {
    seedDay();
    const { code, output } = await render();

    expect(code).toBe(0);
    expect(output).toContain(`LINEUP BUILD — ${SATURDAY} — ${TEAM}`);
    expect(output).toContain(`event "${EVENT}"`);
  });

  it("names every roster member in exactly one of FOUR eligibility buckets, each worded distinctly", async () => {
    seedDay();
    const { output } = await render();

    // The whole point of four buckets: `uncertain` and "never answered" are different states a
    // captain acts on differently, and a page that collapsed them into "not available" would pass a
    // laxer assertion than these four.
    expect(output).toContain(
      "available (8) — eligible to field today: Ada Ashby, Bo Bramwell, Cy Calder, Del Duxbury, " +
        "Emory Ellerby, Fay Fenwick, Gil Garrow, Hana Hollis",
    );
    expect(output).toContain(`unavailable (1) — said no, not fielded: ${UNAVAILABLE}`);
    expect(output).toContain(`uncertain (1) — said maybe, not fielded: ${UNCERTAIN}`);
    expect(output).toContain(`no answer on file (1) — nobody recorded an answer, not fielded: ${UNRECORDED}`);
    // The season-only member is not on the registered field, so he is on no line at all.
    expect(output).not.toContain(SEASON_ONLY);
  });

  it("states the court list and how many bodies it needs", async () => {
    seedDay();
    const { output } = await render();

    expect(output).toContain("courts (4): S1 (singles), D1 (doubles), D2 (doubles), D3 (doubles)");
    expect(output).toContain("bodies needed: 7 — eligible today: 8");
  });

  it("prints each scenario's strategy rule VERBATIM, and its courts, evidence and sitting list", async () => {
    seedDay();
    const { output } = await render();

    // The rules are printed from the exported STRATEGY_RULES, never paraphrased — the export exists
    // so the page states the rule the code ran.
    expect(output).toContain(
      "rule (strength-first): singles takes the strongest available player, then each doubles court " +
        "in format order takes the two strongest left — stacks the top courts",
    );
    expect(output).toContain(
      "rule (balanced): singles as strength-first, then the remaining players are re-partitioned " +
        "across the doubles courts to make the courts as even as possible — spreads strength rather " +
        "than stacking it",
    );

    // strength-first: the strongest at S1, then the two strongest left per court, in format order.
    expect(output).toMatch(/S1 +Ada Ashby +NTRP 4\.5/);
    expect(output).toMatch(/D1 +Bo Bramwell \/ Cy Calder +NTRP 8\.7 +no shared history/);
    expect(output).toMatch(/D2 +Del Duxbury \/ Emory Ellerby +NTRP 8\.3 +no shared history/);
    expect(output).toMatch(/D3 +Fay Fenwick \/ Gil Garrow +NTRP 7\.9 +no shared history/);

    // balanced re-partitions the same six into three courts of equal strength — 4.4+3.9, 4.3+4.0,
    // 4.2+4.1 — which is the provably minimal spread (0.0) over all 15 pairings of those six.
    expect(output).toMatch(/D1 +Bo Bramwell \/ Gil Garrow +NTRP 8\.3/);
    expect(output).toMatch(/D2 +Cy Calder \/ Fay Fenwick +NTRP 8\.3/);
    expect(output).toMatch(/D3 +Del Duxbury \/ Emory Ellerby +NTRP 8\.3/);

    // Who sits is printed with the same weight as who plays.
    expect(output).toContain("sitting: Hana Hollis");
  });

  it("prints `no shared history` for a real zero rather than omitting the count", async () => {
    seedDay();
    const { output } = await render();

    // 0 is an ANSWER — these two have never played together for us — and a captain reads it
    // differently from a court whose count is simply absent. Every doubles court says so here.
    expect(output.match(/no shared history/g)?.length).toBeGreaterThanOrEqual(3);
    // A singles court has no such question, so it carries no shared-history text at all.
    const singlesLine = output.split("\n").find((l) => /S1 +Ada Ashby/.test(l))!;
    expect(singlesLine).not.toContain("shared history");
    expect(singlesLine).not.toContain("0 matches");
  });

  it("names the rating scale and how much of the field carries a value in it", async () => {
    seedDay();
    const { output } = await render();

    expect(output).toContain("ratings: ranked within NTRP (rated: 8 of 8 eligible)");
  });

  it("says a partly-rated court is partly rated, rather than letting it read as a weak one", async () => {
    // Six of the eight available carry an NTRP value; Gil and Hana carry none. The comparison is
    // therefore made over fewer numbers than there are players, and both the scale line and the
    // court that mixes a rated player with an unrated one have to say so — a court showing a bare
    // "NTRP 4.0" for two people reads as a weak court rather than as a half-measured one.
    seedDay({ ratings: RATING_VALUES.slice(0, 6) });
    const { output } = await render();

    expect(output).toContain("ratings: ranked within NTRP (rated: 6 of 8 eligible)");
    expect(output).toMatch(/D3 +Fay Fenwick \/ Gil Garrow +NTRP 4\.0 \(1 of 2 rated\)/);
    // The unrated player is still fielded and still named — unrated is a gap in the evidence, not a
    // reason to leave somebody who said yes off the page.
    expect(output).toContain("Gil Garrow");
  });

  it("states the roster source, the evidence it had, and the standing limits", async () => {
    seedDay();
    const { output } = await render();

    expect(output).toContain(`roster: registered 11 for event "${EVENT}" (season roster: 12)`);
    expect(output).toContain("evidence: 0 court matches of this team's own across this roster");
    expect(output).toContain(
      "limit: the event's court list is one list for all its days — nadal stores no per-day court set",
    );
    expect(output).toContain("limit: deliberate double-duty (one player on two courts) is out of scope for v1");
  });

  it("reads the TARGET day only — unavailable Saturday is still eligible Sunday", async () => {
    const fixture = seedDay();
    withDb((db) => {
      seedAvailabilityMatrix(db, {
        players: [fixture.ids["Ada Ashby"]!],
        days: [SUNDAY],
        statuses: [["available"]],
      });
    });

    const saturday = await render(["lineup", "build", SATURDAY]);
    vi.restoreAllMocks();
    const sunday = await render(["lineup", "build", SUNDAY]);

    expect(saturday.output).toContain("available (8)");
    // Only Ada answered for Sunday; everyone else's Saturday answer does not carry over.
    expect(sunday.output).toContain("available (1) — eligible to field today: Ada Ashby");
    expect(sunday.output).toContain("no answer on file (10)");
  });
});

describe("tn lineup build — identical scenarios collapse", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("prints two agreeing strategies as ONE table under both names, not as two options", async () => {
    seedDay();
    const { output } = await render();

    // With no shared history on file, history-first has nothing to prefer and falls through to the
    // same strength ordering strength-first uses — so the two agree.
    expect(output).toContain("scenarios: 2 distinct lineups from 3 strategies");
    expect(output).toContain("SCENARIO 1 — strength-first, history-first");
    expect(output).toContain("(these 2 strategies produced the same lineup — printed once, not as 2 options)");
    expect(output).toContain("SCENARIO 2 — balanced");
    expect(output).not.toContain("SCENARIO 3");
    // Both names are on the page, and each carries its own rule.
    expect(output).toContain("rule (history-first):");
  });

  it("with nothing rated, all three collapse and the page says the ordering was not strength", async () => {
    seedDay({ ratings: null });
    const { output } = await render();

    expect(output).toContain("scenarios: 1 distinct lineup from 3 strategies");
    expect(output).toContain("SCENARIO 1 — strength-first, history-first, balanced");
    expect(output).toContain("(these 3 strategies produced the same lineup — printed once, not as 3 options)");
    expect(output).not.toContain("SCENARIO 2");
    // Byte-identical to the sentence `format-lineup.ts` already prints for this state — one wording
    // for one fact, across both lineup presenters.
    expect(output).toContain(
      "ratings: none on file — every tie fell through to a stable ordering, not to strength",
    );
    // All three rules are still stated: the reader has to be able to see that three rules agreed.
    expect(output).toContain("rule (strength-first):");
    expect(output).toContain("rule (history-first):");
    expect(output).toContain("rule (balanced):");
    // And each court says it carries no rating rather than printing a number that would be made up.
    expect(output).toMatch(/D1 +Bo Bramwell \/ Cy Calder +unrated +no shared history/);
  });
});

describe("tn lineup build — this team's own evidence", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("counts only our own matches together, and reports what it set aside", async () => {
    const fixture = seedDay();
    withDb((db) => {
      // A real partnership of ours...
      playDoubles(db, [fixture.ids["Fay Fenwick"]!, fixture.ids["Gil Garrow"]!], 3, fixture.ourMatchId);
      // ...and a longer one somewhere else, which must not become evidence.
      const otherTeam = db.insert(teams).values({ name: "Their Other Team" }).returning().get();
      const theirOpponent = db.insert(teams).values({ name: "Their Other Opponent" }).returning().get();
      const theirMatch = db
        .insert(teamMatches)
        .values({ homeTeamId: otherTeam.id, visitingTeamId: theirOpponent.id, sourceMatchId: "theirs-1" })
        .returning()
        .get();
      playDoubles(db, [fixture.ids["Ada Ashby"]!, fixture.ids["Bo Bramwell"]!], 4, theirMatch.id);
      backfillNameKeys(db);
    });

    const { output } = await render();

    expect(output).toContain("evidence: 3 court matches of this team's own across this roster");
    expect(output).toContain("excluded: 4 court matches these players played for other teams");
    // history-first puts the only partnership we have actually seen on D1, and prints its count.
    expect(output).toMatch(/D1 +Fay Fenwick \/ Gil Garrow +NTRP 7\.9 +3 matches together/);
    // The borrowed partnership never surfaces as shared history anywhere on the page.
    expect(output).not.toContain("4 matches together");
    // Three strategies now genuinely disagree, so nothing collapses.
    expect(output).toContain("scenarios: 3 distinct lineups from 3 strategies");
  });

  it("reads correctly when every count is exactly one", async () => {
    // Not cosmetics for its own sake: these three counts are the numbers a captain weighs a
    // placement by, and "1 court matches together" is the kind of line that makes a reader distrust
    // the rest of the page. One fixture exercises the singular of all three at once.
    const fixture = seedDay();
    withDb((db) => {
      playDoubles(db, [fixture.ids["Fay Fenwick"]!, fixture.ids["Gil Garrow"]!], 1, fixture.ourMatchId);
      const otherTeam = db.insert(teams).values({ name: "Their Other Team" }).returning().get();
      const theirOpponent = db.insert(teams).values({ name: "Their Other Opponent" }).returning().get();
      const theirMatch = db
        .insert(teamMatches)
        .values({ homeTeamId: otherTeam.id, visitingTeamId: theirOpponent.id, sourceMatchId: "theirs-1" })
        .returning()
        .get();
      playDoubles(db, [fixture.ids["Ada Ashby"]!, fixture.ids["Bo Bramwell"]!], 1, theirMatch.id);
      backfillNameKeys(db);
    });

    const { output } = await render();

    expect(output).toContain("evidence: 1 court match of this team's own across this roster");
    expect(output).toContain("excluded: 1 court match these players played for other teams");
    expect(output).toMatch(/D1 +Fay Fenwick \/ Gil Garrow +NTRP 7\.9 +1 match together/);
    expect(output).not.toContain("1 matches together");
    expect(output).not.toContain("1 court matches");
  });

  it("names courts that were OURS but on which these players sat opposite, in their own sentence", async () => {
    // The two exclusions are different facts and must not read as one. `excludedOtherTeamMatches`
    // means "this match was not ours"; this one means "this match WAS ours and these players were on
    // the other half of it" — a roster member who played that court against us before changing
    // teams. Codex final pass, class A: the side filter that made the shared counts honest left the
    // evidence line counting courts that contributed nothing, which offered them as support for
    // counts they took no part in.
    const fixture = seedDay();
    withDb((db) => {
      playDoubles(db, [fixture.ids["Fay Fenwick"]!, fixture.ids["Gil Garrow"]!], 3, fixture.ourMatchId, "home");
      playDoubles(db, [fixture.ids["Ada Ashby"]!, fixture.ids["Bo Bramwell"]!], 2, fixture.ourMatchId, "visiting");
      backfillNameKeys(db);
    });

    const { output } = await render();

    // Three, not five: the evidence line counts what survived the side filter.
    expect(output).toContain("evidence: 3 court matches of this team's own across this roster");
    expect(output).toContain("excluded: 2 court matches of ours in which these players were on the opposing side");
    // And it is NOT folded into the other-team sentence, which has nothing to report here.
    expect(output).not.toContain("these players played for other teams");
    // The against-us pair never surfaces as a partnership.
    expect(output).not.toContain("2 matches together");
  });

  it("omits the excluded line entirely when there is nothing to exclude", async () => {
    seedDay();
    const { output } = await render();

    expect(output).not.toContain("excluded:");
  });
});

describe("tn lineup build — shortfall", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("counts the shortfall in BODIES and the unfilled court in SEATS, and double-books nobody", async () => {
    seedDay({ available: AVAILABLE.slice(0, 6), ratings: RATING_VALUES.slice(0, 6) });
    const { code, output } = await render();

    expect(code).toBe(0);
    // Six eligible for seven bodies: one body short — but the court it cannot fill is a DOUBLES
    // court, so TWO seats go empty and the leftover body sits rather than being double-booked.
    expect(output).toContain(
      "shortfall: 1 body short of the 7 this court list needs — a court is left unfilled rather " +
        "than double-booking anyone",
    );
    expect(output).toContain("short: D3 unfilled — 2 seats empty");
    expect(output).toMatch(/D3 +\(unfilled — 2 seats, nobody eligible left\)/);
    expect(output).toContain("sitting: Fay Fenwick");
    // The leftover body is on exactly one line of the scenario — the sitting line — never on a court.
    expect(output).not.toMatch(/D[123] +[^\n]*Fay Fenwick/);
  });

  it("--json carries the body/seat distinction structurally", async () => {
    seedDay({ available: AVAILABLE.slice(0, 6), ratings: RATING_VALUES.slice(0, 6) });
    const { code, output } = await render(["lineup", "build", SATURDAY, "--json"]);

    expect(code).toBe(0);
    const payload = JSON.parse(output) as {
      shortfall: number;
      bodiesNeeded: number;
      eligibleCount: number;
      scenarios: { unfilledSlots: string[]; unfilledSeats: number; sitting: { canonicalName: string }[] }[];
    };
    expect(payload.bodiesNeeded).toBe(7);
    expect(payload.eligibleCount).toBe(6);
    expect(payload.shortfall).toBe(1);
    for (const scenario of payload.scenarios) {
      expect(scenario.unfilledSlots).toEqual(["D3"]);
      expect(scenario.unfilledSeats).toBe(2);
      expect(scenario.sitting).toHaveLength(1);
    }
  });

  it("nobody available at all: every slot unfilled, everyone still named, exit 0", async () => {
    seedDay({ available: [] });
    const { code, output } = await render();

    expect(code).toBe(0);
    expect(output).toContain("available (0) — eligible to field today: none");
    expect(output).toContain(
      "shortfall: 7 bodies short of the 7 this court list needs — a court is left unfilled rather " +
        "than double-booking anyone",
    );
    expect(output).toContain("short: S1, D1, D2, D3 unfilled — 7 seats empty");
    expect(output).toContain("sitting: nobody");
  });
});

describe("tn lineup build — an inverted rating scale", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("prints the RAW value in the named scale, never the direction-normalized ordering number", async () => {
    seedDay({
      available: AVAILABLE.slice(0, 7),
      ratings: [10.5, 11.0, 11.5, 12.0, 12.5, 13.0, 13.5],
      ratingSource: "wtn_singles",
    });
    const { output } = await render();

    expect(output).toContain("ratings: ranked within WTN-S (rated: 7 of 7 eligible)");
    // On WTN, LOWER is stronger — so the lowest value takes S1...
    expect(output).toMatch(/S1 +Ada Ashby +WTN-S 10\.50/);
    // ...and the printed court number is the raw sum in WTN's own scale. `courtStrength` (the
    // negated value the orderings used) is -22.50 here and must never reach the page: a captain
    // reading a negative WTN would have learned something false about the scale.
    expect(output).toMatch(/D1 +Bo Bramwell \/ Cy Calder +WTN-S 22\.50/);
    expect(output).not.toContain("-22.50");
    expect(output).not.toMatch(/WTN-S -/);
  });
});

describe("tn lineup build — captain notes", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("shows a player note and a pairing note about placed people, and counts the ones it withheld", async () => {
    const fixture = seedDay();
    withDb((db) => {
      addCaptainNote(db, { playerId: fixture.ids["Ada Ashby"]!, text: "serves big under pressure" });
      addCaptainNote(db, {
        playerId: fixture.ids["Bo Bramwell"]!,
        pairPlayerId: fixture.ids["Cy Calder"]!,
        text: "great net chemistry",
      });
      // About somebody who said no: not placed in any scenario, so it is withheld — and SAID to be
      // withheld, rather than silently dropped.
      addCaptainNote(db, { playerId: fixture.ids[UNAVAILABLE]!, text: "never plays the early slot" });
    });

    const { output } = await render();

    expect(output).toContain("captain notes on placed players:");
    expect(output).toContain("Ada Ashby: serves big under pressure");
    expect(output).toContain("Bo Bramwell + Cy Calder: great net chemistry");
    expect(output).toContain("(displayed, never scored — no strategy above used them)");
    expect(output).toContain("captain notes: 1 more on file about players not placed today");
    expect(output).not.toContain("never plays the early slot");
  });

  it("prints no captain-note section at all when there are none", async () => {
    seedDay();
    const { output } = await render();

    expect(output).not.toContain("captain notes");
  });
});

describe("tn lineup build — output boundaries", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  // RIGHT-TO-LEFT OVERRIDE, written as an explicit escape rather than pasted: a pasted invisible
  // character has the same failure mode as the bug it probes (it can be lost or normalized by an
  // editor, a diff, or a tool boundary), and that has already inverted a review outcome in this repo.
  const RTL_OVERRIDE = String.fromCharCode(0x202e);
  // MUSICAL SYMBOL BEGIN BEAM — category Cf like the override above, but ASTRAL: two UTF-16 code
  // units that sanitize down to one space. That is what makes it the right probe for the column
  // width: a name carrying it is one character WIDER in the raw string than on screen, so a
  // renderer that measured before sanitizing lays its columns out against a width nothing sees.
  const ASTRAL_FORMAT_CHAR = String.fromCodePoint(0x1d173);

  it("--json emits the structured build and strips a bidi override out of a scraped name", async () => {
    seedDay({ available: [`Ada${RTL_OVERRIDE}Ashby`, ...AVAILABLE.slice(1)], register: false });
    const { code, output } = await render(["lineup", "build", SATURDAY, "--json"]);

    expect(code).toBe(0);
    expect(output, "a bidi override must not reach the terminal through --json").not.toContain(RTL_OVERRIDE);
    const payload = JSON.parse(output) as {
      day: string;
      teamName: string;
      event: { name: string };
      ratingSource: string;
      ledger: { available: { canonicalName: string }[] };
      scenarios: { strategies: string[]; courts: { slot: string; players: { canonicalName: string }[] }[] }[];
    };
    expect(payload.day).toBe(SATURDAY);
    expect(payload.teamName).toBe(TEAM);
    expect(payload.event.name).toBe(EVENT);
    expect(payload.ratingSource).toBe("ntrp");
    expect(payload.scenarios[0]!.strategies).toContain("strength-first");
    expect(payload.scenarios[0]!.courts.map((c) => c.slot)).toEqual(["S1", "D1", "D2", "D3"]);
    // The record still names the same person, with the hostile character neutralized rather than
    // the row dropped.
    expect(payload.ledger.available.some((p) => p.canonicalName === "Ada Ashby")).toBe(true);
  });

  it("keeps the columns aligned when a name carries an invisible formatting character", async () => {
    seedDay({ available: [`Ada${ASTRAL_FORMAT_CHAR}Ashby`, ...AVAILABLE.slice(1)], register: false });
    const { output } = await render();

    // This is the assertion that makes "sanitize BEFORE measuring" observable. Every cell is padded
    // to one width, so the only way a column can land somewhere a human does not expect is for an
    // invisible character to survive INTO the cell — costing a code unit in the padded string and no
    // column on screen. Nothing invisible surviving is therefore exactly the guarantee that the
    // padded offsets below are the columns a captain actually sees.
    expect(output).not.toContain(ASTRAL_FORMAT_CHAR);
    expect(output).toContain("Ada Ashby");
    expect(ratingColumnOffsets(output).size, "every court's rating column starts in the same place").toBe(1);
  });

  it("lays out ONE column grid across every scenario's table, not one grid per table", async () => {
    // The names are chosen so the two scenarios' longest cells genuinely DIFFER — strength-first
    // pairs the two longest names together (a 40-column cell) while balanced splits them across
    // courts (27). Every other fixture in this file happens to give both tables the same longest
    // cell, so a width re-measured inside the per-scenario loop would survive them all; here it
    // cannot. Two stacked tables on different grids are harder to compare than the one wide table
    // they replaced, which is the whole reason they are stacked.
    seedDay({
      available: ["Ada Ashby", "Bramwell Bartholomew", "Calder Cunningham", "Del D", "Em E", "Fay Fenwick"],
      ratings: [4.5, 4.4, 4.3, 4.2, 4.1, 4.0],
      register: false,
    });
    const { output } = await render();

    expect(output).toMatch(/D1 +Bramwell Bartholomew \/ Calder Cunningham +NTRP 8\.7/);
    expect(output).toMatch(/D1 +Bramwell Bartholomew \/ Em E +NTRP 8\.5/);
    expect(ratingColumnOffsets(output).size, "one grid for the whole page").toBe(1);
  });

  it("states the season-roster fallback as positively as it states a registered field", async () => {
    seedDay({ register: false });
    const { output } = await render();

    expect(output).toContain(`roster: season roster (event "${EVENT}") — no registered members`);
  });

  it("--quiet prints nothing on success but still exits 0", async () => {
    seedDay();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["lineup", "build", SATURDAY, "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("--quiet still reports a refusal on stderr, exit 1", async () => {
    seedDay();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["lineup", "build", "2099-01-01", "--quiet"]);

    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("lineup build status=error"));
  });
});

describe("tn lineup build — argument refusals", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("refuses a missing day positional rather than building for today", async () => {
    seedDay();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["lineup", "build"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("missing target"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("tn lineup build <YYYY-MM-DD> [event]"));
  });

  it("refuses an unrecognized flag rather than ignoring it", async () => {
    seedDay();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["lineup", "build", SATURDAY, "--jsno"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --jsno"));
  });

  it("refuses a third positional — there are only two", async () => {
    seedDay();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["lineup", "build", SATURDAY, EVENT, "extra"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected extra argument"));
  });
});

/**
 * One test per caller-fixable refusal class, each driven by the FIXTURE that produces that class
 * rather than by matching the message it happens to carry today — a message is presentation and may
 * be rewritten; the class is the contract.
 */
describe("tn lineup build — every refusal exits 1 with a diagnostic", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  async function expectRefusal(argv: string[]): Promise<string[]> {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(argv);
    expect(code).toBe(1);
    expect(logSpy, "a refusal writes nothing to stdout").not.toHaveBeenCalled();
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("lineup build status=error"))).toBe(true);
    return lines;
  }

  it("NoHomeTeamError — no team is designated ours", async () => {
    runMigrations();
    withDb((db) => {
      addEvent(db, { name: EVENT, kind: "tournament", startsOn: FRIDAY, endsOn: SUNDAY, format: FORMAT });
    });

    const lines = await expectRefusal(["lineup", "build", SATURDAY]);
    expect(lines.join("\n")).toContain("tn team home");
  });

  it("InvalidAvailabilityDayError — a well-shaped day that is not a real date", async () => {
    seedDay();
    const lines = await expectRefusal(["lineup", "build", "2026-02-31"]);
    expect(lines.join("\n")).toContain("2026-02-31");
  });

  it("InvalidAvailabilityDayError — a day that is not a date at all", async () => {
    seedDay();
    await expectRefusal(["lineup", "build", "banana"]);
  });

  it("NoEventForDayError — a day inside no event", async () => {
    seedDay();
    const lines = await expectRefusal(["lineup", "build", "2099-01-01"]);
    expect(lines.join("\n")).toContain("2099-01-01");
  });

  it("AmbiguousEventForDayError — a day inside two events, reported through the one ambiguity formatter", async () => {
    seedDay();
    withDb((db) => {
      addEvent(db, {
        name: "Overlapping League",
        kind: "league",
        startsOn: "2026-08-01",
        endsOn: "2026-09-30",
        format: FORMAT,
      });
    });

    const lines = await expectRefusal(["lineup", "build", SATURDAY]);
    // The three facts #94 requires, rendered by `ambiguousMessage` rather than hand-rolled here:
    // the incoming value, where it came from, and what it was near.
    const joined = lines.join("\n");
    expect(joined).toContain("ambiguous identity");
    expect(joined).toContain(SATURDAY);
    expect(joined).toContain("event for day");
    expect(joined).toContain(EVENT);
    expect(joined).toContain("Overlapping League");

    // ...and naming one resolves it, which is what makes the refusal a disambiguator.
    vi.restoreAllMocks();
    const { code, output } = await render(["lineup", "build", SATURDAY, "Overlapping League"]);
    expect(code).toBe(0);
    expect(output).toContain('event "Overlapping League"');
  });

  it("EventDoesNotCoverDayError — a named event whose range excludes the day", async () => {
    seedDay();
    withDb((db) => {
      addEvent(db, {
        name: "May League",
        kind: "league",
        startsOn: "2026-05-01",
        endsOn: "2026-05-02",
        format: FORMAT,
      });
    });

    const lines = await expectRefusal(["lineup", "build", SATURDAY, "May League"]);
    expect(lines.join("\n")).toContain("May League");
  });

  it("UnknownEventError (day resolution) — a named event nothing on file carries", async () => {
    seedDay();
    const lines = await expectRefusal(["lineup", "build", SATURDAY, "No Such Event"]);
    expect(lines.join("\n")).toContain("No Such Event");
  });

  it("EventHasNoFormatError — the resolved event has no court list", async () => {
    seedDay({ format: null });
    const lines = await expectRefusal(["lineup", "build", SATURDAY]);
    expect(lines.join("\n")).toContain("tn event add");
  });

  it("InvalidEventFormatError — a hand-corrupted format column", async () => {
    seedDay();
    withDb((db) => {
      db.update(events).set({ format: "{not json" }).where(eq(events.name, EVENT)).run();
    });

    await expectRefusal(["lineup", "build", SATURDAY]);
  });

  it("InvalidLeagueScopeError — a hand-corrupted league-scope column this command does not even read", async () => {
    seedDay();
    withDb((db) => {
      db.update(events).set({ leagueScope: "{not json" }).where(eq(events.name, EVENT)).run();
    });

    await expectRefusal(["lineup", "build", SATURDAY]);
  });

  it("InvalidAvailabilityStatusError — a stored status our own writer could not have produced", async () => {
    const fixture = seedDay();
    withDb((db) => {
      db.update(availability)
        .set({ status: "maybe" })
        .where(eq(availability.playerId, fixture.ids["Ada Ashby"]!))
        .run();
    });

    await expectRefusal(["lineup", "build", SATURDAY]);
  });
});

/**
 * The two classes that are genuinely unreachable through this command — a race between the day
 * lookup and the resolution, and a court list our own format reader already refuses to produce — are
 * pinned on the GUARD itself rather than through a fixture that cannot exist. That is also the only
 * place the name collision below can be observed.
 */
describe("isLineupBuildRefusal", () => {
  useTnDbPath();
  afterEach(() => vi.restoreAllMocks());

  it("recognizes BOTH classes literally named UnknownEventError, which are two different classes", () => {
    // `src/query/availability.ts` and `src/query/lineup.ts` each export a class with this name, and
    // both are reachable from one `getLineupBuild` call. Aliasing one on import is what keeps the
    // guard from listing the same class twice and silently missing the other — this is the assertion
    // that would fail if the alias were dropped.
    expect(UnknownEventError, "the two classes must not be the same class").not.toBe(UnknownEventForDayError);
    expect(isLineupBuildRefusal(new UnknownEventError("from lineup.ts"))).toBe(true);
    expect(isLineupBuildRefusal(new UnknownEventForDayError("from availability.ts"))).toBe(true);
  });

  it("recognizes the empty-slot-set refusal the pure layer carries", () => {
    expect(isLineupBuildRefusal(new EmptySlotSetError("no courts"))).toBe(true);
  });

  it("does NOT claim an ordinary error — a genuine bug must not be laundered into a tidy refusal", () => {
    expect(isLineupBuildRefusal(new Error("boom"))).toBe(false);
    expect(isLineupBuildRefusal(new TypeError("undefined is not a function"))).toBe(false);
    expect(isLineupBuildRefusal("not even an error")).toBe(false);
  });

  it("a non-refusal is rethrown, not reported as a refusal line", async () => {
    seedDay();
    // A dropped table is the shape of a genuine bug: nothing the caller typed can fix it. It must
    // NOT arrive as `lineup build status=error`, which is this command's vocabulary for "your input
    // is fixable" — `dispatch`'s telemetry wrapper records the real class instead.
    const { sqlite } = openDb();
    try {
      sqlite.exec("DROP TABLE rating_observations");
    } finally {
      sqlite.close();
    }

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["lineup", "build", SATURDAY]);

    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("lineup build status=error"))).toBe(
      false,
    );
    const outcome = withDb((db) => db.select().from(requestLog).all().at(-1)?.outcome ?? "");
    expect(outcome).toMatch(/^error:/);
    expect(outcome, "an exit-code outcome would mean the command reported it as a refusal").not.toBe("error:exit-1");
  });
});
