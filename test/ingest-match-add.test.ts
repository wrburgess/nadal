import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import {
  courtMatchPlayers,
  courtMatches,
  events,
  playerAliases,
  players,
  teamMatches,
  teamMemberships,
  teams,
} from "../src/db/schema.js";
import { addMatchFromScorecard, describeMatchAddRefusal } from "../src/ingest/match-add.js";
import type { ScorecardPayload } from "../src/ingest/scorecard.js";
import { useTnDbPath } from "./helpers/tn-db.js";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "scorecard");

function loadTulsaFixture(): ScorecardPayload {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, "tulsa-2025-redacted.json"), "utf8")) as ScorecardPayload;
}

// Task 3, #18 — the heart of the suite: the transactional service every court/player/team-match
// write goes through, and the roster-scoped, never-create, "flag-never-guess" invariant that makes
// this safe to run against agent-vision output.

type TestDb = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

function seedTeam(db: TestDb, name: string) {
  db.insert(teams).values({ name, nameKey: nameKey(name) }).run();
  return db.select().from(teams).all().find((t) => t.name === name)!;
}

function seedRosterPlayer(db: TestDb, teamId: number, name: string) {
  db.insert(players).values({ canonicalName: name, nameKey: nameKey(name) }).run();
  const player = db.select().from(players).all().find((p) => p.canonicalName === name)!;
  db.insert(teamMemberships).values({ playerId: player.id, teamId, eventId: null }).run();
  return player;
}

/** S1 (singles) + D1 (doubles, with a result) — the minimal payload every test builds from. */
function basePayload(home: string, visiting: string): ScorecardPayload {
  return {
    playedOn: "2026-08-28",
    homeTeam: home,
    visitingTeam: visiting,
    courts: [
      { slot: "S1", discipline: "singles", homePlayers: ["Ada Ashby"], visitingPlayers: ["Opp One"] },
      {
        slot: "D1",
        discipline: "doubles",
        homePlayers: ["Bo Bramwell", "Cy Calder"],
        visitingPlayers: ["Opp Two", "Opp Three"],
        winnerSide: "home",
        score: "6-3 6-4",
      },
    ],
  };
}

function seedStandardRosters(db: TestDb) {
  const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
  const visiting = seedTeam(db, "Report Opponent");
  const ada = seedRosterPlayer(db, home.id, "Ada Ashby");
  const bo = seedRosterPlayer(db, home.id, "Bo Bramwell");
  const cy = seedRosterPlayer(db, home.id, "Cy Calder");
  const oppOne = seedRosterPlayer(db, visiting.id, "Opp One");
  const oppTwo = seedRosterPlayer(db, visiting.id, "Opp Two");
  const oppThree = seedRosterPlayer(db, visiting.id, "Opp Three");
  return { home, visiting, ada, bo, cy, oppOne, oppTwo, oppThree };
}

describe("describeMatchAddRefusal", () => {
  it("names the candidates for an ambiguous team, and the bare name for a genuinely unknown one", () => {
    expect(
      describeMatchAddRefusal({ ok: false, kind: "unknown-team", team: "IA/Versteeg", candidates: ["A", "B"] }),
    ).toBe('ambiguous team "IA/Versteeg": A, B');
    expect(describeMatchAddRefusal({ ok: false, kind: "unknown-team", team: "No Such Team", candidates: [] })).toBe(
      'unknown team "No Such Team"',
    );
  });

  it("names an unknown event", () => {
    expect(describeMatchAddRefusal({ ok: false, kind: "unknown-event", event: "No Such Event" })).toBe(
      'unknown event "No Such Event"',
    );
  });

  it("lists every unresolved/ambiguous player flag together", () => {
    expect(
      describeMatchAddRefusal({
        ok: false,
        kind: "unresolved-players",
        flags: [
          { name: "Ghost Player", reason: "unresolved", candidates: [] },
          { name: "Alex Ston", reason: "ambiguous", candidates: ["Alex Stone", "Alex Stove"] },
        ],
      }),
    ).toBe('unresolved player name(s): "Ghost Player" unresolved; "Alex Ston" ambiguous (Alex Stone, Alex Stove)');
  });

  // PR #54 verify findings 1-2: a same-team refusal and a duplicate-resolved-player refusal each
  // need their own wording, same as every other refusal kind.
  it("names a same-team refusal", () => {
    expect(describeMatchAddRefusal({ ok: false, kind: "same-team", team: "IA/Versteeg/40&Over3.5M" })).toBe(
      'homeTeam and visitingTeam both resolve to the same team ("IA/Versteeg/40&Over3.5M") — a team cannot play itself',
    );
  });

  it("names every duplicate-players violation together", () => {
    expect(
      describeMatchAddRefusal({
        ok: false,
        kind: "duplicate-players",
        duplicates: [
          {
            slot: "D1",
            playerId: 7,
            occurrences: [
              { side: "home", name: "Bo Bramwell" },
              { side: "home", name: "Bo Bramwell" },
            ],
          },
          {
            slot: "D2",
            playerId: 9,
            occurrences: [
              { side: "home", name: "Transfer Player" },
              { side: "visiting", name: "Transfer Player" },
            ],
          },
        ],
      }),
    ).toBe(
      'duplicate participant(s): court "D1": the same player (id 7) listed as home:"Bo Bramwell" and home:"Bo Bramwell"; ' +
        'court "D2": the same player (id 9) listed as home:"Transfer Player" and visiting:"Transfer Player"',
    );
  });
});

describe("addMatchFromScorecard", () => {
  useTnDbPath();

  it("happy: writes one team_matches row, N court_matches, and the right column values", () => {
    const { db, sqlite } = freshDb();
    try {
      const { home, visiting, bo, cy } = seedStandardRosters(db);

      const result = addMatchFromScorecard(db, basePayload(home.name, visiting.name));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.courts).toBe(2);

      const teamMatchRows = db.select().from(teamMatches).all();
      expect(teamMatchRows).toHaveLength(1);
      expect(teamMatchRows[0]).toMatchObject({
        homeTeamId: home.id,
        visitingTeamId: visiting.id,
        playedOn: "2026-08-28",
        eventId: null,
      });
      expect(result.teamMatchId).toBe(teamMatchRows[0]!.id);

      const courtRows = db.select().from(courtMatches).all();
      expect(courtRows).toHaveLength(2);

      const d1 = courtRows.find((c) => c.slot === "D1")!;
      expect(d1).toMatchObject({
        teamMatchId: teamMatchRows[0]!.id,
        discipline: "doubles",
        winnerSide: "home",
        score: "6-3 6-4",
        playedOn: "2026-08-28",
      });
      const s1 = courtRows.find((c) => c.slot === "S1")!;
      expect(s1).toMatchObject({ discipline: "singles", winnerSide: null, score: null });

      const participantRows = db.select().from(courtMatchPlayers).all();
      expect(participantRows).toHaveLength(6); // 2 (S1) + 4 (D1)
      const d1Home = participantRows
        .filter((p) => p.courtMatchId === d1.id && p.side === "home")
        .map((p) => p.playerId)
        .sort();
      expect(d1Home).toEqual([bo.id, cy.id].sort());
    } finally {
      sqlite.close();
    }
  });

  it("idempotency: running the identical payload twice leaves row counts unchanged and creates no duplicate players", () => {
    const { db, sqlite } = freshDb();
    try {
      const { home, visiting } = seedStandardRosters(db);
      const payload = basePayload(home.name, visiting.name);

      const first = addMatchFromScorecard(db, payload);
      const second = addMatchFromScorecard(db, payload);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) expect(second.teamMatchId).toBe(first.teamMatchId);

      expect(db.select().from(teamMatches).all()).toHaveLength(1);
      expect(db.select().from(courtMatches).all()).toHaveLength(2);
      expect(db.select().from(courtMatchPlayers).all()).toHaveLength(6);
      expect(db.select().from(players).all()).toHaveLength(6);
    } finally {
      sqlite.close();
    }
  });

  it("collision guard: two different team matches on the same date, each with a D1, stay two distinct court rows", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const visitingA = seedTeam(db, "Report Opponent A");
      const visitingB = seedTeam(db, "Report Opponent B");
      seedRosterPlayer(db, home.id, "Bo Bramwell");
      seedRosterPlayer(db, home.id, "Cy Calder");
      seedRosterPlayer(db, visitingA.id, "Opp Two");
      seedRosterPlayer(db, visitingA.id, "Opp Three");
      seedRosterPlayer(db, visitingB.id, "Opp Four");
      seedRosterPlayer(db, visitingB.id, "Opp Five");

      const payloadA: ScorecardPayload = {
        playedOn: "2026-08-28",
        homeTeam: home.name,
        visitingTeam: visitingA.name,
        courts: [
          {
            slot: "D1",
            discipline: "doubles",
            homePlayers: ["Bo Bramwell", "Cy Calder"],
            visitingPlayers: ["Opp Two", "Opp Three"],
          },
        ],
      };
      const payloadB: ScorecardPayload = {
        playedOn: "2026-08-28",
        homeTeam: home.name,
        visitingTeam: visitingB.name,
        courts: [
          {
            slot: "D1",
            discipline: "doubles",
            homePlayers: ["Bo Bramwell", "Cy Calder"],
            visitingPlayers: ["Opp Four", "Opp Five"],
          },
        ],
      };

      const resultA = addMatchFromScorecard(db, payloadA);
      const resultB = addMatchFromScorecard(db, payloadB);

      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      if (resultA.ok && resultB.ok) expect(resultA.teamMatchId).not.toBe(resultB.teamMatchId);
      expect(db.select().from(teamMatches).all()).toHaveLength(2);
      expect(db.select().from(courtMatches).all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("an unresolved player name refuses, ALL bad names reported together, and the DB is byte-for-byte unchanged", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const visiting = seedTeam(db, "Report Opponent");
      seedRosterPlayer(db, home.id, "Ada Ashby");
      // "Bo Bramwell" and "Cy Calder" deliberately NOT seeded on home's roster — both must flag.
      seedRosterPlayer(db, visiting.id, "Opp One");
      seedRosterPlayer(db, visiting.id, "Opp Two");
      seedRosterPlayer(db, visiting.id, "Opp Three");

      const before = {
        teamMatches: db.select().from(teamMatches).all(),
        courtMatches: db.select().from(courtMatches).all(),
        courtMatchPlayers: db.select().from(courtMatchPlayers).all(),
        players: db.select().from(players).all(),
      };

      const result = addMatchFromScorecard(db, basePayload(home.name, visiting.name));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("unresolved-players");
        if (result.kind === "unresolved-players") {
          expect(result.flags.map((f) => f.name).sort()).toEqual(["Bo Bramwell", "Cy Calder"]);
          expect(result.flags.every((f) => f.reason === "unresolved")).toBe(true);
        }
      }

      expect(db.select().from(teamMatches).all()).toEqual(before.teamMatches);
      expect(db.select().from(courtMatches).all()).toEqual(before.courtMatches);
      expect(db.select().from(courtMatchPlayers).all()).toEqual(before.courtMatchPlayers);
      expect(db.select().from(players).all()).toEqual(before.players);
    } finally {
      sqlite.close();
    }
  });

  it("an ambiguous player name refuses, listing every candidate it saw", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const visiting = seedTeam(db, "Report Opponent");
      seedRosterPlayer(db, home.id, "Ada Ashby");
      seedRosterPlayer(db, home.id, "Cy Calder");
      // Two near-identical roster names — "Alex Ston" is one edit from Stone, two from Stove.
      seedRosterPlayer(db, home.id, "Alex Stone");
      seedRosterPlayer(db, home.id, "Alex Stove");
      seedRosterPlayer(db, visiting.id, "Opp One");
      seedRosterPlayer(db, visiting.id, "Opp Two");
      seedRosterPlayer(db, visiting.id, "Opp Three");

      const payload = basePayload(home.name, visiting.name);
      payload.courts[1] = { ...payload.courts[1]!, homePlayers: ["Alex Ston", "Cy Calder"] };

      const result = addMatchFromScorecard(db, payload);

      expect(result.ok).toBe(false);
      if (!result.ok && result.kind === "unresolved-players") {
        expect(result.flags).toHaveLength(1);
        expect(result.flags[0]!.name).toBe("Alex Ston");
        expect(result.flags[0]!.reason).toBe("ambiguous");
        expect(result.flags[0]!.candidates.sort()).toEqual(["Alex Stone", "Alex Stove"]);
      } else {
        throw new Error("expected an unresolved-players refusal");
      }
    } finally {
      sqlite.close();
    }
  });

  it("a usta: prefix-ID overrides a name that would otherwise flag — resolved globally, not by roster", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const visiting = seedTeam(db, "Report Opponent");
      seedRosterPlayer(db, home.id, "Ada Ashby");
      const cy = seedRosterPlayer(db, home.id, "Cy Calder");
      seedRosterPlayer(db, visiting.id, "Opp One");
      seedRosterPlayer(db, visiting.id, "Opp Two");
      seedRosterPlayer(db, visiting.id, "Opp Three");

      // "Bo" is NOT on any roster at all — only a usta: id can resolve them.
      db.insert(players)
        .values({ canonicalName: "Bo B. Ashby-Bramwell", ustaUaid: "88888", nameKey: nameKey("Bo B. Ashby-Bramwell") })
        .run();
      const bo = db.select().from(players).all().find((p) => p.ustaUaid === "88888")!;

      const payload = basePayload(home.name, visiting.name);
      payload.courts[1] = { ...payload.courts[1]!, homePlayers: ["usta:88888", "Cy Calder"] };

      const result = addMatchFromScorecard(db, payload);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const d1 = db.select().from(courtMatches).all().find((c) => c.slot === "D1")!;
        const d1HomeIds = db
          .select()
          .from(courtMatchPlayers)
          .all()
          .filter((p) => p.courtMatchId === d1.id && p.side === "home")
          .map((p) => p.playerId)
          .sort();
        expect(d1HomeIds).toEqual([bo.id, cy.id].sort());
      }
    } finally {
      sqlite.close();
    }
  });

  // REGRESSION guard for the design choice: an unscoped lookup would find this player by exact
  // name and match — the whole point of `resolveRosterPlayer` (Task 2) is that it must NOT.
  it("roster scoping: a player who exists in `players` on the OPPOSING team's roster flags rather than matching", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const visiting = seedTeam(db, "Report Opponent");
      seedRosterPlayer(db, home.id, "Ada Ashby");
      seedRosterPlayer(db, home.id, "Cy Calder");
      seedRosterPlayer(db, visiting.id, "Opp One");
      seedRosterPlayer(db, visiting.id, "Opp Two");
      seedRosterPlayer(db, visiting.id, "Opp Three");
      // "Bo Bramwell" exists — but only on the VISITING roster, not home's.
      seedRosterPlayer(db, visiting.id, "Bo Bramwell");

      const result = addMatchFromScorecard(db, basePayload(home.name, visiting.name));

      expect(result.ok).toBe(false);
      if (!result.ok && result.kind === "unresolved-players") {
        expect(result.flags.map((f) => f.name)).toEqual(["Bo Bramwell"]);
        expect(result.flags[0]!.reason).toBe("unresolved");
      } else {
        throw new Error("expected an unresolved-players refusal");
      }
    } finally {
      sqlite.close();
    }
  });

  it("an unknown team refuses, nothing written", () => {
    const { db, sqlite } = freshDb();
    try {
      const visiting = seedTeam(db, "Report Opponent");
      seedRosterPlayer(db, visiting.id, "Opp One");
      seedRosterPlayer(db, visiting.id, "Opp Two");
      seedRosterPlayer(db, visiting.id, "Opp Three");

      const result = addMatchFromScorecard(db, basePayload("No Such Team", visiting.name));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe("unknown-team");
      expect(db.select().from(teamMatches).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("an ambiguous (near-miss) team name refuses as unknown-team, listing every candidate it saw", () => {
    const { db, sqlite } = freshDb();
    try {
      // Two near-identical team names — a home-team lookup of "IA/Versteeg/40&Over3.5" (missing the
      // final "M") is one edit from each, forcing the fuzzy tier to report both as candidates.
      seedTeam(db, "IA/Versteeg/40&Over3.5M");
      seedTeam(db, "IA/Versteeg/40&Over3.5N");
      const visiting = seedTeam(db, "Report Opponent");
      seedRosterPlayer(db, visiting.id, "Opp One");
      seedRosterPlayer(db, visiting.id, "Opp Two");
      seedRosterPlayer(db, visiting.id, "Opp Three");

      const result = addMatchFromScorecard(db, basePayload("IA/Versteeg/40&Over3.5", visiting.name));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("unknown-team");
        if (result.kind === "unknown-team") {
          expect(result.candidates.sort()).toEqual(["IA/Versteeg/40&Over3.5M", "IA/Versteeg/40&Over3.5N"]);
        }
      }
      expect(db.select().from(teamMatches).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("an unknown named event refuses, nothing written", () => {
    const { db, sqlite } = freshDb();
    try {
      const { home, visiting } = seedStandardRosters(db);

      const result = addMatchFromScorecard(db, { ...basePayload(home.name, visiting.name), event: "No Such Event" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe("unknown-event");
      expect(db.select().from(teamMatches).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("a payload naming a known event links the parent TeamMatch to it", () => {
    const { db, sqlite } = freshDb();
    try {
      const { home, visiting } = seedStandardRosters(db);
      const event = db
        .insert(events)
        .values({ name: "Springfield Sectionals 2026", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
        .returning()
        .get();

      const result = addMatchFromScorecard(db, { ...basePayload(home.name, visiting.name), event: event.name });

      expect(result.ok).toBe(true);
      const row = db.select().from(teamMatches).all()[0]!;
      expect(row.eventId).toBe(event.id);
    } finally {
      sqlite.close();
    }
  });

  it("a payload naming no event writes a parent with event_id null, and still dedupes on re-run", () => {
    const { db, sqlite } = freshDb();
    try {
      const { home, visiting } = seedStandardRosters(db);
      const payload = basePayload(home.name, visiting.name);
      expect(payload.event).toBeUndefined();

      addMatchFromScorecard(db, payload);
      addMatchFromScorecard(db, payload);

      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.eventId).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  // Fixtures: test/fixtures/scorecard/tulsa-2025-redacted.json — structure from a real Tulsa 2025
  // scorecard (S1 + D1-D4, a match-tiebreak deciding set), names replaced from this repo's existing
  // synthetic name pool. No scorecard photograph is committed (test/fixtures/README.md).
  describe("the Tulsa 2025-shaped fixture", () => {
    const HOME_ROSTER = [
      "Nova Norbury",
      "Rowan Rushworth",
      "Rowan Kestrel",
      "Kai Bramwell",
      "Kai Linfield",
      "Blake Calder",
      "Lane Oakhurst",
      "Casey Melbourne",
      "Orin Ashby",
    ];
    const VISITING_ROSTER = [
      "Harper Duxbury",
      "Juniper Eastwick",
      "Delaney Duxbury",
      "Delaney Eastwick",
      "Ellis Inglewood",
      "Emory Ellerby",
      "Emory Yarrowby",
      "Ellis Eastwick",
      "Juniper Duxbury",
    ];

    it("ingests cleanly when every name is on the right roster — 5 courts, 18 participants, a match-tiebreak score preserved verbatim", () => {
      const { db, sqlite } = freshDb();
      try {
        const payload = loadTulsaFixture();
        const home = seedTeam(db, payload.homeTeam);
        const visiting = seedTeam(db, payload.visitingTeam);
        for (const name of HOME_ROSTER) seedRosterPlayer(db, home.id, name);
        for (const name of VISITING_ROSTER) seedRosterPlayer(db, visiting.id, name);

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("expected ok");
        expect(result.courts).toBe(5);
        expect(db.select().from(courtMatches).all()).toHaveLength(5);
        expect(db.select().from(courtMatchPlayers).all()).toHaveLength(18); // 2 + 4*4

        const d1 = db.select().from(courtMatches).all().find((c) => c.slot === "D1")!;
        expect(d1.score).toBe("4-6 6-3 [10-8]"); // the match-tiebreak notation, preserved verbatim
        expect(d1.winnerSide).toBe("visiting");
      } finally {
        sqlite.close();
      }
    });

    // rules/testing.md: the fixture is built so the asserted behavior is the ONLY thing that can
    // produce the expected value — the roster below is deliberately missing exactly one name
    // ("Kai Linfield") rather than a complete roster that would satisfy the resolver before the
    // guard runs, so a green result here can only mean the flag-never-guess path actually fired.
    it("REGRESSION: a roster missing exactly one fixture name flags that one name, and only that one", () => {
      const { db, sqlite } = freshDb();
      try {
        const payload = loadTulsaFixture();
        const home = seedTeam(db, payload.homeTeam);
        const visiting = seedTeam(db, payload.visitingTeam);
        for (const name of HOME_ROSTER) {
          if (name === "Kai Linfield") continue; // deliberately absent
          seedRosterPlayer(db, home.id, name);
        }
        for (const name of VISITING_ROSTER) seedRosterPlayer(db, visiting.id, name);

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(false);
        if (!result.ok && result.kind === "unresolved-players") {
          expect(result.flags.map((f) => f.name)).toEqual(["Kai Linfield"]);
          expect(result.flags[0]!.reason).toBe("unresolved");
        } else {
          throw new Error("expected an unresolved-players refusal");
        }
        expect(db.select().from(teamMatches).all()).toHaveLength(0);
      } finally {
        sqlite.close();
      }
    });
  });

  // PR #54 verify findings 1-2: `upsertCourtMatchPlayers` conflicts on `(court_match_id,
  // player_id)` and does `onConflictDoUpdate({ set: { side } })` (upsert.ts:355-365) — so writing
  // the SAME resolved player twice for one court silently leaves ONE row, with the later `side`
  // winning, no error anywhere. The schema's cardinality invariant (Task 1) guarantees the right
  // COUNT of names but never distinctness of the RESOLVED player, so every path below reaches the
  // service with a schema-valid payload that would otherwise write fewer participants than the
  // schema just promised. The check must compare resolved `playerId`, never the input strings —
  // that's what makes the alias/prefix-ID/both-sides cases (which cannot be caught by string
  // comparison) actually distinguishable from a genuine two-distinct-player court.
  describe("duplicate-participant and same-team guards", () => {
    it("REGRESSION (finding 1a): the same name listed twice on one side of a doubles court refuses, DB unchanged", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const before = {
          teamMatches: db.select().from(teamMatches).all(),
          courtMatches: db.select().from(courtMatches).all(),
          courtMatchPlayers: db.select().from(courtMatchPlayers).all(),
          players: db.select().from(players).all(),
        };

        const payload = basePayload(home.name, visiting.name);
        payload.courts[1] = { ...payload.courts[1]!, homePlayers: ["Bo Bramwell", "Bo Bramwell"] };

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe("duplicate-players");

        expect(db.select().from(teamMatches).all()).toEqual(before.teamMatches);
        expect(db.select().from(courtMatches).all()).toEqual(before.courtMatches);
        expect(db.select().from(courtMatchPlayers).all()).toEqual(before.courtMatchPlayers);
        expect(db.select().from(players).all()).toEqual(before.players);
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION (finding 1b): two distinct names aliasing to the SAME player on one side refuses — not catchable by string comparison", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting, bo } = seedStandardRosters(db);
        db.insert(playerAliases)
          .values({ playerId: bo.id, alias: "Robert Bramwell", nameKey: nameKey("Robert Bramwell") })
          .run();

        const payload = basePayload(home.name, visiting.name);
        payload.courts[1] = { ...payload.courts[1]!, homePlayers: ["Bo Bramwell", "Robert Bramwell"] };

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(false);
        if (!result.ok && result.kind === "duplicate-players") {
          expect(result.duplicates).toHaveLength(1);
          expect(result.duplicates[0]!.playerId).toBe(bo.id);
        } else {
          throw new Error("expected a duplicate-players refusal");
        }
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION (finding 1c): the same player on BOTH sides of a court refuses — reachable via bug #49's append-only team_memberships", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        // A transferred player: on file for BOTH teams' rosters, since team_memberships never
        // deletes the old row when a player moves teams (#49).
        const transferred = seedRosterPlayer(db, home.id, "Transfer Player");
        db.insert(teamMemberships).values({ playerId: transferred.id, teamId: visiting.id, eventId: null }).run();

        const payload = basePayload(home.name, visiting.name);
        payload.courts[1] = {
          ...payload.courts[1]!,
          homePlayers: ["Bo Bramwell", "Transfer Player"],
          visitingPlayers: ["Transfer Player", "Opp Three"],
        };

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(false);
        if (!result.ok && result.kind === "duplicate-players") {
          expect(result.duplicates).toHaveLength(1);
          expect(result.duplicates[0]!.playerId).toBe(transferred.id);
          expect(result.duplicates[0]!.occurrences.map((o) => o.side).sort()).toEqual(["home", "visiting"]);
        } else {
          throw new Error("expected a duplicate-players refusal");
        }
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION (finding 1d): a usta: prefix-ID duplicating a bare name already on that side refuses", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting, bo } = seedStandardRosters(db);
        db.update(players).set({ ustaUaid: "77777" }).where(eq(players.id, bo.id)).run();

        const payload = basePayload(home.name, visiting.name);
        payload.courts[1] = { ...payload.courts[1]!, homePlayers: ["Bo Bramwell", "usta:77777"] };

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe("duplicate-players");
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION (finding 2): homeTeam and visitingTeam naming the same team refuses, DB unchanged", () => {
      const { db, sqlite } = freshDb();
      try {
        const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
        seedRosterPlayer(db, team.id, "Ada Ashby");
        seedRosterPlayer(db, team.id, "Bo Bramwell");
        seedRosterPlayer(db, team.id, "Cy Calder");
        const before = {
          teamMatches: db.select().from(teamMatches).all(),
          courtMatches: db.select().from(courtMatches).all(),
          courtMatchPlayers: db.select().from(courtMatchPlayers).all(),
          players: db.select().from(players).all(),
        };

        const result = addMatchFromScorecard(db, basePayload(team.name, team.name));

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe("same-team");

        expect(db.select().from(teamMatches).all()).toEqual(before.teamMatches);
        expect(db.select().from(courtMatches).all()).toEqual(before.courtMatches);
        expect(db.select().from(courtMatchPlayers).all()).toEqual(before.courtMatchPlayers);
        expect(db.select().from(players).all()).toEqual(before.players);
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION (finding 2, variant): two DIFFERENT spellings resolving to the SAME team also refuse — compares the resolved id, not the strings", () => {
      const { db, sqlite } = freshDb();
      try {
        const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
        seedRosterPlayer(db, team.id, "Ada Ashby");
        seedRosterPlayer(db, team.id, "Bo Bramwell");
        seedRosterPlayer(db, team.id, "Cy Calder");

        // Different casing, same nameKey-folded team — findTeamByName's exact tier matches both to
        // the identical row, so the two payload STRINGS differ while the resolved ids do not.
        const result = addMatchFromScorecard(
          db,
          basePayload("HOA/Burgess-Zingg/40&over3.5M", "hoa/burgess-zingg/40&over3.5m"),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe("same-team");
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION: ALL duplicate-participant violations across multiple courts are reported together, not just the first", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        seedRosterPlayer(db, home.id, "Dev Duxbury");
        seedRosterPlayer(db, visiting.id, "Opp Four");
        seedRosterPlayer(db, visiting.id, "Opp Five");

        const payload = basePayload(home.name, visiting.name);
        payload.courts[1] = { ...payload.courts[1]!, homePlayers: ["Bo Bramwell", "Bo Bramwell"] }; // D1
        payload.courts.push({
          slot: "D2",
          discipline: "doubles",
          homePlayers: ["Dev Duxbury", "Dev Duxbury"], // D2, a SECOND, independent violation
          visitingPlayers: ["Opp Four", "Opp Five"],
        });

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(false);
        if (!result.ok && result.kind === "duplicate-players") {
          expect(result.duplicates.map((d) => d.slot).sort()).toEqual(["D1", "D2"]);
        } else {
          throw new Error("expected a duplicate-players refusal listing both courts");
        }
      } finally {
        sqlite.close();
      }
    });

    it("a genuine two-distinct-player doubles court still ingests cleanly — the guard must not over-refuse", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);

        const result = addMatchFromScorecard(db, basePayload(home.name, visiting.name));

        expect(result.ok).toBe(true);
      } finally {
        sqlite.close();
      }
    });
  });
});
