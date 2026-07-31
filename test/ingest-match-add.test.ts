import { eq } from "drizzle-orm";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import {
  MAX_SCORECARD_IMAGE_BYTES,
  addMatchFromScorecard,
  addMatchFromScorecardWithArchive,
  archiveScorecardImage,
  describeMatchAddRefusal,
} from "../src/ingest/match-add.js";
import { scorecardPayloadSchema } from "../src/ingest/scorecard.js";
import type { ScorecardPayload } from "../src/ingest/scorecard.js";
import { pullTeam } from "../src/ingest/team-pull.js";
import { upsertTeamMatch } from "../src/ingest/upsert.js";
import { loadFixture } from "./helpers/fixtures.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";
import { useTnScorecardPhotosPath } from "./helpers/tn-scorecard-photos.js";

const tennisrecordTeamFixture = loadFixture("tennisrecord/team");

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

  // Codex adversarial review of PR #54, High findings 1-2.
  it("names an off-roster player flag distinctly from a plain unresolved one", () => {
    expect(
      describeMatchAddRefusal({
        ok: false,
        kind: "unresolved-players",
        flags: [{ name: "usta:99999", reason: "off-roster", candidates: ["Some Other Spelling"] }],
      }),
    ).toBe('unresolved player name(s): "usta:99999" resolved to Some Other Spelling, who is not on this team\'s roster');
  });

  it("names every duplicate court slot together", () => {
    expect(describeMatchAddRefusal({ ok: false, kind: "duplicate-slots", slots: ["S1", "D2"] })).toBe(
      "duplicate court slot(s) in one payload: S1, D2",
    );
  });

  it("names every ambiguous-parent-match candidate together", () => {
    expect(
      describeMatchAddRefusal({
        ok: false,
        kind: "ambiguous-parent-match",
        candidates: [
          { teamMatchId: 1, scheduledTime: null, site: "Court 1" },
          { teamMatchId: 2, scheduledTime: "9:00 AM", site: null },
        ],
      }),
    ).toBe(
      "ambiguous parent match — 2 existing team matches are each compatible: " +
        "id 1 (scheduledTime=blank, site=Court 1); id 2 (scheduledTime=9:00 AM, site=blank) — " +
        "supply the missing scheduledTime/site to disambiguate",
    );
  });

  it("names a conflicting-parent-event refusal, both event ids", () => {
    expect(
      describeMatchAddRefusal({
        ok: false,
        kind: "conflicting-parent-event",
        teamMatchId: 7,
        existingEventId: 1,
        incomingEventId: 2,
      }),
    ).toBe(
      "conflicting event for existing team match id 7: stored event id 1 vs incoming event id 2 — " +
        "supply the same event, or omit it, rather than a different one",
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

  // Codex adversarial review of PR #54, High finding 1: a prefix-ID used to resolve GLOBALLY,
  // ignoring roster scoping entirely — this test used to assert exactly that bypass. Rewritten to
  // assert the bounded behavior: an id naming a real player who is NOT on the payload's own team
  // roster must flag, never write them in as a participant of a team they aren't rostered to.
  it("REGRESSION (Codex High finding 1): a usta: prefix-ID naming a player on NO roster at all is flagged, DB unchanged", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const visiting = seedTeam(db, "Report Opponent");
      seedRosterPlayer(db, home.id, "Ada Ashby");
      seedRosterPlayer(db, home.id, "Cy Calder");
      seedRosterPlayer(db, visiting.id, "Opp One");
      seedRosterPlayer(db, visiting.id, "Opp Two");
      seedRosterPlayer(db, visiting.id, "Opp Three");

      // "Bo" exists in `players` with a real usta id — but is on NO roster at all.
      db.insert(players)
        .values({ canonicalName: "Bo B. Ashby-Bramwell", ustaUaid: "88888", nameKey: nameKey("Bo B. Ashby-Bramwell") })
        .run();

      const before = {
        teamMatches: db.select().from(teamMatches).all(),
        courtMatches: db.select().from(courtMatches).all(),
        courtMatchPlayers: db.select().from(courtMatchPlayers).all(),
        players: db.select().from(players).all(),
      };

      const payload = basePayload(home.name, visiting.name);
      payload.courts[1] = { ...payload.courts[1]!, homePlayers: ["usta:88888", "Cy Calder"] };

      const result = addMatchFromScorecard(db, payload);

      expect(result.ok).toBe(false);
      if (!result.ok && result.kind === "unresolved-players") {
        expect(result.flags.map((f) => f.name)).toEqual(["usta:88888"]);
        expect(result.flags[0]!.reason).toBe("off-roster");
      } else {
        throw new Error("expected an unresolved-players refusal with an off-roster flag");
      }

      expect(db.select().from(teamMatches).all()).toEqual(before.teamMatches);
      expect(db.select().from(courtMatches).all()).toEqual(before.courtMatches);
      expect(db.select().from(courtMatchPlayers).all()).toEqual(before.courtMatchPlayers);
      expect(db.select().from(players).all()).toEqual(before.players);
    } finally {
      sqlite.close();
    }
  });

  it("a usta: prefix-ID naming a player on ANOTHER team's roster is flagged, DB unchanged", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const visiting = seedTeam(db, "Report Opponent");
      seedRosterPlayer(db, home.id, "Ada Ashby");
      seedRosterPlayer(db, home.id, "Cy Calder");
      const oppOne = seedRosterPlayer(db, visiting.id, "Opp One");
      seedRosterPlayer(db, visiting.id, "Opp Two");
      seedRosterPlayer(db, visiting.id, "Opp Three");
      // "Opp One" is a real roster player — but on the VISITING team, not home's.
      db.update(players).set({ ustaUaid: "55555" }).where(eq(players.id, oppOne.id)).run();

      const before = {
        teamMatches: db.select().from(teamMatches).all(),
        courtMatches: db.select().from(courtMatches).all(),
        courtMatchPlayers: db.select().from(courtMatchPlayers).all(),
        players: db.select().from(players).all(),
      };

      const payload = basePayload(home.name, visiting.name);
      payload.courts[1] = { ...payload.courts[1]!, homePlayers: ["usta:55555", "Cy Calder"] };

      const result = addMatchFromScorecard(db, payload);

      expect(result.ok).toBe(false);
      if (!result.ok && result.kind === "unresolved-players") {
        expect(result.flags[0]!.reason).toBe("off-roster");
      } else {
        throw new Error("expected an unresolved-players refusal with an off-roster flag");
      }

      expect(db.select().from(teamMatches).all()).toEqual(before.teamMatches);
      expect(db.select().from(courtMatches).all()).toEqual(before.courtMatches);
      expect(db.select().from(courtMatchPlayers).all()).toEqual(before.courtMatchPlayers);
      expect(db.select().from(players).all()).toEqual(before.players);
    } finally {
      sqlite.close();
    }
  });

  it("a usta: prefix-ID naming a player ON the payload's own team roster still resolves — the correction workflow keeps working", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const visiting = seedTeam(db, "Report Opponent");
      const ada = seedRosterPlayer(db, home.id, "Ada Ashby");
      seedRosterPlayer(db, home.id, "Bo Bramwell");
      seedRosterPlayer(db, home.id, "Cy Calder");
      seedRosterPlayer(db, visiting.id, "Opp One");
      seedRosterPlayer(db, visiting.id, "Opp Two");
      seedRosterPlayer(db, visiting.id, "Opp Three");
      // A misread name corrected via id — "Ada Ashby" IS on home's roster.
      db.update(players).set({ ustaUaid: "88888" }).where(eq(players.id, ada.id)).run();

      const payload = basePayload(home.name, visiting.name);
      payload.courts[0] = { ...payload.courts[0]!, homePlayers: ["usta:88888"] }; // S1: singles, 1 player

      const result = addMatchFromScorecard(db, payload);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const s1 = db.select().from(courtMatches).all().find((c) => c.slot === "S1")!;
        const s1HomeIds = db
          .select()
          .from(courtMatchPlayers)
          .all()
          .filter((p) => p.courtMatchId === s1.id && p.side === "home")
          .map((p) => p.playerId);
        expect(s1HomeIds).toEqual([ada.id]);
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

    it("REGRESSION (Codex round-4 sweep follow-up): two DIFFERENT team rows whose exact names fold to the SAME nameKey (a differently-cased re-scrape) refuse as ambiguous, nothing written", () => {
      const { db, sqlite } = freshDb();
      try {
        // Two distinct rows, not one — `teams.name` is unique but these two strings differ, so both
        // legitimately exist (exactly how two differently-cased `team pull` scrapes of the same real
        // team could land two rows sharing a nameKey). findTeamByName's exact tier must refuse this
        // as ambiguous rather than silently picking whichever row sorts first.
        seedTeam(db, "Norbury, Nova");
        seedTeam(db, "NORBURY, NOVA");
        const visiting = seedTeam(db, "Report Opponent");
        seedRosterPlayer(db, visiting.id, "Opp One");
        seedRosterPlayer(db, visiting.id, "Opp Two");
        seedRosterPlayer(db, visiting.id, "Opp Three");

        const before = {
          teamMatches: db.select().from(teamMatches).all(),
          courtMatches: db.select().from(courtMatches).all(),
        };

        const result = addMatchFromScorecard(db, basePayload("Norbury, Nova", visiting.name));

        expect(result.ok).toBe(false);
        if (!result.ok && result.kind === "unknown-team") {
          expect(result.candidates.slice().sort()).toEqual(["NORBURY, NOVA", "Norbury, Nova"]);
        } else {
          throw new Error("expected an ambiguous unknown-team refusal naming both candidates");
        }

        expect(db.select().from(teamMatches).all()).toEqual(before.teamMatches);
        expect(db.select().from(courtMatches).all()).toEqual(before.courtMatches);
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

  // Codex adversarial review of PR #54, High finding 2: the schema requires only a non-empty
  // `slot`, but the id-less write key `upsertCourtMatch` uses is `(slot, playedOn, teamMatchId)` —
  // and WITHIN one payload, every court shares the same `playedOn` and the same freshly-resolved
  // `teamMatchId`, so `slot` alone is the only thing that can tell two courts apart. Two
  // schema-valid courts sharing a slot therefore silently collapse: the second `upsertCourtMatch`
  // call UPDATES the first court's row, and `upsertCourtMatchPlayers` only ever ADDS participants,
  // never removes — so the surviving row ends up with every player from BOTH courts and the SECOND
  // court's score, with no refusal at all. Same class as the duplicate-resolved-player guard above,
  // one level out: any two distinct payload entities that collide on a write key must refuse, not
  // silently merge.
  describe("duplicate court-slot guard", () => {
    it("REGRESSION (Codex High finding 2): two schema-valid courts sharing a slot refuse, and ALL FOUR match tables are unchanged", () => {
      const { db, sqlite } = freshDb();
      try {
        const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
        const visiting = seedTeam(db, "Report Opponent");
        seedRosterPlayer(db, home.id, "Ada Ashby");
        seedRosterPlayer(db, home.id, "Cy Calder");
        seedRosterPlayer(db, visiting.id, "Opp One");
        seedRosterPlayer(db, visiting.id, "Opp Three");

        const before = {
          teamMatches: db.select().from(teamMatches).all(),
          courtMatches: db.select().from(courtMatches).all(),
          courtMatchPlayers: db.select().from(courtMatchPlayers).all(),
          players: db.select().from(players).all(),
        };

        // Two DIFFERENT, individually schema-valid singles courts, both mislabeled "S1".
        const payload: ScorecardPayload = {
          playedOn: "2026-08-28",
          homeTeam: home.name,
          visitingTeam: visiting.name,
          courts: [
            { slot: "S1", discipline: "singles", homePlayers: ["Ada Ashby"], visitingPlayers: ["Opp One"] },
            { slot: "S1", discipline: "singles", homePlayers: ["Cy Calder"], visitingPlayers: ["Opp Three"] },
          ],
        };

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe("duplicate-slots");

        expect(db.select().from(teamMatches).all()).toEqual(before.teamMatches);
        expect(db.select().from(courtMatches).all()).toEqual(before.courtMatches);
        expect(db.select().from(courtMatchPlayers).all()).toEqual(before.courtMatchPlayers);
        expect(db.select().from(players).all()).toEqual(before.players);
      } finally {
        sqlite.close();
      }
    });

    it("two courts with DIFFERENT slots still ingest cleanly — the guard must not over-refuse", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);

        const result = addMatchFromScorecard(db, basePayload(home.name, visiting.name)); // S1 + D1

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.courts).toBe(2);
      } finally {
        sqlite.close();
      }
    });

    // Codex adversarial review (PR #54 round 7, rated Medium): `slot` was counted by raw string
    // equality here, so `"D1"` and `"D1 "` were two DIFFERENT keys in the duplicate-slot count —
    // evading this exact guard by a whitespace difference the schema now canonicalizes away
    // (src/ingest/scorecard.ts's `slot: z.string().trim().min(1)`). Payloads below are built through
    // `scorecardPayloadSchema.parse` rather than hand-typed as `ScorecardPayload` directly, so these
    // tests exercise the SAME pipeline the CLI/MCP presenters actually run — the fix lives in the
    // schema, not this service, and a test that skipped parsing would not exercise it at all.
    it("REGRESSION (Codex round 7, rated Medium): 'D1' and 'D1 ' in ONE payload refuse as a duplicate slot, not two different courts", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const parsed = scorecardPayloadSchema.parse({
          playedOn: "2026-08-28",
          homeTeam: home.name,
          visitingTeam: visiting.name,
          courts: [
            {
              slot: "D1",
              discipline: "doubles",
              homePlayers: ["Bo Bramwell", "Cy Calder"],
              visitingPlayers: ["Opp Two", "Opp Three"],
            },
            {
              slot: "D1 ",
              discipline: "doubles",
              homePlayers: ["Bo Bramwell", "Cy Calder"],
              visitingPlayers: ["Opp Two", "Opp Three"],
            },
          ],
        });

        const result = addMatchFromScorecard(db, parsed);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe("duplicate-slots");
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION (Codex round 7): a re-ingest correction spelled 'D1 ' updates the SAME court row 'D1' created, not a second one", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const courtBase = {
          discipline: "doubles" as const,
          homePlayers: ["Bo Bramwell", "Cy Calder"],
          visitingPlayers: ["Opp Two", "Opp Three"],
        };

        const first = addMatchFromScorecard(
          db,
          scorecardPayloadSchema.parse({
            playedOn: "2026-08-28",
            homeTeam: home.name,
            visitingTeam: visiting.name,
            courts: [{ ...courtBase, slot: "D1" }],
          }),
        );
        expect(first.ok).toBe(true);

        const second = addMatchFromScorecard(
          db,
          scorecardPayloadSchema.parse({
            playedOn: "2026-08-28",
            homeTeam: home.name,
            visitingTeam: visiting.name,
            courts: [{ ...courtBase, slot: "D1 " }],
          }),
        );
        expect(second.ok).toBe(true);
        if (first.ok && second.ok) expect(second.teamMatchId).toBe(first.teamMatchId);

        expect(db.select().from(courtMatches).all()).toHaveLength(1); // not a second row
      } finally {
        sqlite.close();
      }
    });
  });

  // Codex adversarial review of PR #54 round 2, High finding A: `upsertCourtMatch`'s id-less
  // branch reuses the existing court row on a re-ingest, but the participant write loop only ever
  // UPSERTS the names the NEW payload carries — and `upsertCourtMatchPlayers` deliberately never
  // deletes (docs/findings.md #15, a Phase-3 invariant `src/ingest/player-pull.ts`'s OWN re-pull
  // path relies on, and which `derive.ts` is written to tolerate by never assuming an exact
  // participant count). So a corrected extraction — the runbook's whole loop is photo → payload →
  // fix a misread name → re-submit — could not RETRACT the wrong-but-roster-valid player it
  // superseded: the stale participant stayed attached forever, a false match in that player's own
  // profile and in lineup data. The fix does NOT touch `upsertCourtMatchPlayers` (its "never
  // deletes" contract stays true for every OTHER caller) — this service explicitly clears the ONE
  // court it just resolved a fresh participant set for, immediately before writing that set,
  // because a scorecard payload IS a complete replacement for every court it names.
  describe("re-ingest correction replaces court participants", () => {
    it("REGRESSION (Codex High finding A, the reviewer's named case): correcting D1's home pair leaves EXACTLY the four right participants, not the old plus the new", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting, bo, cy, oppTwo, oppThree } = seedStandardRosters(db);
        const dev = seedRosterPlayer(db, home.id, "Dev Duxbury");

        const firstPayload: ScorecardPayload = {
          playedOn: "2026-08-28",
          homeTeam: home.name,
          visitingTeam: visiting.name,
          courts: [
            {
              slot: "D1",
              discipline: "doubles",
              homePlayers: ["Bo Bramwell", "Cy Calder"],
              visitingPlayers: ["Opp Two", "Opp Three"],
            },
          ],
        };
        const first = addMatchFromScorecard(db, firstPayload);
        expect(first.ok).toBe(true);

        // A vision misread ("Bo Bramwell") corrected to the actual player ("Dev Duxbury") — every
        // name here is a valid roster member, so nothing flags; this is exactly what a re-submitted
        // correction looks like.
        const correctedPayload: ScorecardPayload = {
          ...firstPayload,
          courts: [{ ...firstPayload.courts[0]!, homePlayers: ["Dev Duxbury", "Cy Calder"] }],
        };
        const second = addMatchFromScorecard(db, correctedPayload);
        expect(second.ok).toBe(true);
        if (first.ok && second.ok) expect(second.teamMatchId).toBe(first.teamMatchId);

        const d1 = db.select().from(courtMatches).all().find((c) => c.slot === "D1")!;
        const participants = db.select().from(courtMatchPlayers).all().filter((p) => p.courtMatchId === d1.id);

        // Identities, not just a count — a count-only assertion would pass if Bo were wrongly kept
        // and Dev wrongly dropped.
        expect(participants).toHaveLength(4);
        const byPlayerId = new Map(participants.map((p) => [p.playerId, p.side]));
        expect(byPlayerId.get(dev.id)).toBe("home");
        expect(byPlayerId.get(cy.id)).toBe("home");
        expect(byPlayerId.get(oppTwo.id)).toBe("visiting");
        expect(byPlayerId.get(oppThree.id)).toBe("visiting");
        // The whole point: the superseded player is GONE, not merely outnumbered by the correct one.
        expect(byPlayerId.has(bo.id)).toBe(false);
      } finally {
        sqlite.close();
      }
    });

    it("a court the second payload OMITS keeps its participants untouched", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);

        const firstPayload = basePayload(home.name, visiting.name); // S1 + D1
        const first = addMatchFromScorecard(db, firstPayload);
        expect(first.ok).toBe(true);

        const s1Before = db.select().from(courtMatches).all().find((c) => c.slot === "S1")!;
        const s1ParticipantsBefore = db
          .select()
          .from(courtMatchPlayers)
          .all()
          .filter((p) => p.courtMatchId === s1Before.id);

        // A second payload naming ONLY D1 — S1 is not mentioned at all.
        const d1OnlyPayload: ScorecardPayload = {
          ...firstPayload,
          courts: [{ ...firstPayload.courts[1]!, winnerSide: "visiting", score: "3-6 4-6" }],
        };
        const second = addMatchFromScorecard(db, d1OnlyPayload);
        expect(second.ok).toBe(true);

        const s1After = db.select().from(courtMatches).all().find((c) => c.slot === "S1")!;
        const s1ParticipantsAfter = db
          .select()
          .from(courtMatchPlayers)
          .all()
          .filter((p) => p.courtMatchId === s1After.id);
        expect(s1ParticipantsAfter).toEqual(s1ParticipantsBefore);
      } finally {
        sqlite.close();
      }
    });

    it("the existing identical-payload idempotency test still holds — replacement must not break idempotency", () => {
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

    it("a singles court corrects the same way — exactly 2 participants after, not 4", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting, oppOne } = seedStandardRosters(db);
        const dev = seedRosterPlayer(db, home.id, "Dev Duxbury");

        const firstPayload: ScorecardPayload = {
          playedOn: "2026-08-28",
          homeTeam: home.name,
          visitingTeam: visiting.name,
          courts: [{ slot: "S1", discipline: "singles", homePlayers: ["Ada Ashby"], visitingPlayers: ["Opp One"] }],
        };
        const first = addMatchFromScorecard(db, firstPayload);
        expect(first.ok).toBe(true);

        const correctedPayload: ScorecardPayload = {
          ...firstPayload,
          courts: [{ ...firstPayload.courts[0]!, homePlayers: ["Dev Duxbury"] }],
        };
        const second = addMatchFromScorecard(db, correctedPayload);
        expect(second.ok).toBe(true);

        const s1 = db.select().from(courtMatches).all().find((c) => c.slot === "S1")!;
        const participants = db.select().from(courtMatchPlayers).all().filter((p) => p.courtMatchId === s1.id);

        expect(participants).toHaveLength(2);
        const byPlayerId = new Map(participants.map((p) => [p.playerId, p.side]));
        expect(byPlayerId.get(dev.id)).toBe("home");
        expect(byPlayerId.get(oppOne.id)).toBe("visiting");
      } finally {
        sqlite.close();
      }
    });
  });

  // Codex adversarial review of PR #54 round 2, High finding B — HC decision: "fill in blanks",
  // scoped to `match-add` only. `upsertTeamMatch`'s own id-less branch requires `scheduledTime`/
  // `site` to compare EQUAL after normalization before treating two rows as the same fixture —
  // correct for `team-pull`'s scraped re-pulls, too strict for a photo-correction workflow where an
  // early, hurried capture commonly omits a detail (the time, say) a later, careful one supplies.
  // The rule must be SYMMETRIC: it must not matter which of the two ingests (first or second) is
  // the one missing the detail, and two GENUINELY DIFFERENT supplied values (the doubleheader guard
  // PR #31 added) must still refuse to merge.
  describe("lenient parent-match matching (HC decision, Finding B)", () => {
    it("REGRESSION (the reviewer's case): re-ingesting with a scheduledTime the first ingest omitted fills it in, one TeamMatch, courts not duplicated", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const firstPayload = basePayload(home.name, visiting.name); // no scheduledTime, no site

        const first = addMatchFromScorecard(db, firstPayload);
        expect(first.ok).toBe(true);

        const second = addMatchFromScorecard(db, { ...firstPayload, scheduledTime: "9:00 AM" });
        expect(second.ok).toBe(true);
        if (first.ok && second.ok) expect(second.teamMatchId).toBe(first.teamMatchId);

        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.scheduledTime).toBe("9:00 AM");
        expect(db.select().from(courtMatches).all()).toHaveLength(2); // S1 + D1, not duplicated
      } finally {
        sqlite.close();
      }
    });

    it("the reverse: re-ingesting WITHOUT a scheduledTime the first ingest supplied keeps the stored value — the case a one-sided fix would miss", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const firstPayload: ScorecardPayload = { ...basePayload(home.name, visiting.name), scheduledTime: "9:00 AM" };

        const first = addMatchFromScorecard(db, firstPayload);
        expect(first.ok).toBe(true);

        // The second submission simply omits scheduledTime — the field is absent, not blank text.
        const secondPayload: ScorecardPayload = { ...firstPayload };
        delete secondPayload.scheduledTime;
        const second = addMatchFromScorecard(db, secondPayload);
        expect(second.ok).toBe(true);
        if (first.ok && second.ok) expect(second.teamMatchId).toBe(first.teamMatchId);

        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.scheduledTime).toBe("9:00 AM"); // never nulled out
      } finally {
        sqlite.close();
      }
    });

    it("site-only fill-in: the same rule applies to `site` independently of `scheduledTime`", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const firstPayload = basePayload(home.name, visiting.name); // no site

        expect(addMatchFromScorecard(db, firstPayload).ok).toBe(true);
        expect(addMatchFromScorecard(db, { ...firstPayload, site: "Court 3" }).ok).toBe(true);

        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.site).toBe("Court 3");
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION (the mixed case, exactly as specified): stored (time blank, site set) + incoming (time set, site blank) merges to both set", () => {
      const { db, sqlite } = freshDb();
      try {
        const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
        const visiting = seedTeam(db, "Report Opponent");
        seedRosterPlayer(db, home.id, "Ada Ashby");
        seedRosterPlayer(db, visiting.id, "Opp One");

        const firstPayload: ScorecardPayload = {
          playedOn: "2026-08-28",
          homeTeam: home.name,
          visitingTeam: visiting.name,
          site: "Court 3",
          courts: [{ slot: "S1", discipline: "singles", homePlayers: ["Ada Ashby"], visitingPlayers: ["Opp One"] }],
        };
        expect(addMatchFromScorecard(db, firstPayload).ok).toBe(true);

        const secondPayload: ScorecardPayload = { ...firstPayload, scheduledTime: "9:00 AM" };
        delete secondPayload.site;
        expect(addMatchFromScorecard(db, secondPayload).ok).toBe(true);

        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.scheduledTime).toBe("9:00 AM");
        expect(rows[0]!.site).toBe("Court 3");
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION: the doubleheader guard still holds — two ingests with DIFFERENT supplied times insert TWO team matches, never merged", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const morningPayload = { ...basePayload(home.name, visiting.name), scheduledTime: "9:00 AM" };
        const eveningPayload = { ...basePayload(home.name, visiting.name), scheduledTime: "5:00 PM" };

        const morning = addMatchFromScorecard(db, morningPayload);
        const evening = addMatchFromScorecard(db, eveningPayload);

        expect(morning.ok).toBe(true);
        expect(evening.ok).toBe(true);
        if (morning.ok && evening.ok) expect(morning.teamMatchId).not.toBe(evening.teamMatchId);

        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.scheduledTime).sort()).toEqual(["5:00 PM", "9:00 AM"]);
      } finally {
        sqlite.close();
      }
    });

    // Found in `verify`'s own read of the Finding B fix, before the Reviewer saw it. Leniency is
    // meant to fill a gap when nothing better exists — it must never OUTRANK an exact match. With
    // both a blank-timed row and a row whose time equals the incoming one on file, a plain
    // find-first matcher merges into whichever the query returns first, which can be the blank row,
    // leaving the true fixture untouched and the blank one wrongly backfilled. This state is
    // reachable in production precisely because `team-pull` writes `team_matches` too: a scraped row
    // carrying a time can coexist with a match-add row that never captured one.
    it("REGRESSION: an EXACT discriminator match wins over a merely blank-compatible row", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const blankPayload = basePayload(home.name, visiting.name);

        // Row A — written by match-add, no time captured on the first hurried photo.
        const first = addMatchFromScorecard(db, blankPayload);
        if (!first.ok) throw new Error("the first (blank) ingest should have succeeded");

        // Row B — the same fixture as ANOTHER writer (e.g. `team-pull`) records it, WITH a time.
        const exactRow = db
          .insert(teamMatches)
          .values({
            eventId: null,
            homeTeamId: home.id,
            visitingTeamId: visiting.id,
            playedOn: blankPayload.playedOn,
            scheduledTime: "9:00 AM",
            site: null,
            sourceMatchId: null,
            homeCourtsWon: null,
            visitingCourtsWon: null,
          })
          .returning()
          .get();

        const timed = addMatchFromScorecard(db, { ...blankPayload, scheduledTime: "9:00 AM" });
        if (!timed.ok) throw new Error("the timed ingest should have succeeded");

        // Merged into the EXACT row, not the blank one.
        expect(timed.teamMatchId).toBe(exactRow.id);

        // And the blank row is left exactly as it was — never backfilled with another fixture's time.
        const blankAfter = db.select().from(teamMatches).where(eq(teamMatches.id, first.teamMatchId)).all()[0];
        expect(blankAfter?.scheduledTime).toBeNull();

        // No third row was invented either.
        expect(db.select().from(teamMatches).all()).toHaveLength(2);
      } finally {
        sqlite.close();
      }
    });

    it("the existing identical-payload idempotency test still holds under the lenient matcher", () => {
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
      } finally {
        sqlite.close();
      }
    });

    // Codex adversarial review of PR #54 round 3, High finding 2: after the exact pass finds
    // nothing, the lenient fallback used to take the FIRST blank-compatible candidate with no
    // ambiguity check. Two source-less rows for the SAME team pair and date — `(time=null,
    // site="Court 1")` and `(time="9:00 AM", site=null)` — can coexist today precisely because
    // `team-pull`'s STRICT matching never merges a blank-time row with a blank-site row (they are
    // not equal to each other, so upsertTeamMatch treats them as two distinct fixtures). An
    // incoming `(time="9:00 AM", site="Court 1")` is EXACT with neither (so the exact pass finds
    // nothing) and lenient-COMPATIBLE with BOTH — so a silent `.find()` would attach this payload's
    // courts to whichever row SQLite happened to return first, backfilling only that one and
    // leaving the other stranded, half-filled, forever. This must refuse instead.
    it("REGRESSION (Codex High finding 2): two pre-existing, lenient-compatible parent candidates refuse as ambiguous rather than picking one silently", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        // Simulates two rows `team-pull`'s own strict matching could plausibly have produced for
        // the same team pair and date — its equality is exact, so a blank-time row and a
        // blank-site row are never merged into one.
        const rowA = upsertTeamMatch(db, {
          homeTeamId: home.id,
          visitingTeamId: visiting.id,
          playedOn: "2026-08-28",
          scheduledTime: null,
          site: "Court 1",
          sourceMatchId: null,
          homeCourtsWon: null,
          visitingCourtsWon: null,
        });
        const rowB = upsertTeamMatch(db, {
          homeTeamId: home.id,
          visitingTeamId: visiting.id,
          playedOn: "2026-08-28",
          scheduledTime: "9:00 AM",
          site: null,
          sourceMatchId: null,
          homeCourtsWon: null,
          visitingCourtsWon: null,
        });
        expect(db.select().from(teamMatches).all()).toHaveLength(2); // sanity: genuinely two rows

        const payload: ScorecardPayload = {
          ...basePayload(home.name, visiting.name),
          scheduledTime: "9:00 AM",
          site: "Court 1",
        };

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(false);
        if (!result.ok && result.kind === "ambiguous-parent-match") {
          expect(result.candidates.map((c) => c.teamMatchId).sort()).toEqual([rowA.id, rowB.id].sort());
        } else {
          throw new Error("expected an ambiguous-parent-match refusal");
        }

        // Nothing new written — still exactly the two pre-existing rows, no courts/participants.
        expect(db.select().from(teamMatches).all()).toHaveLength(2);
        expect(db.select().from(courtMatches).all()).toHaveLength(0);
        expect(db.select().from(courtMatchPlayers).all()).toHaveLength(0);
      } finally {
        sqlite.close();
      }
    });

    it("an EXACT discriminator match still wins outright, even when a lenient-only candidate also exists — no ambiguity, since the exact pass runs first", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const exactRow = upsertTeamMatch(db, {
          homeTeamId: home.id,
          visitingTeamId: visiting.id,
          playedOn: "2026-08-28",
          scheduledTime: "9:00 AM",
          site: "Court 1",
          sourceMatchId: null,
          homeCourtsWon: null,
          visitingCourtsWon: null,
        });
        // A second, lenient-only candidate (blank site) that would ALSO be compatible were the
        // exact match not already decisive.
        upsertTeamMatch(db, {
          homeTeamId: home.id,
          visitingTeamId: visiting.id,
          playedOn: "2026-08-28",
          scheduledTime: "9:00 AM",
          site: null,
          sourceMatchId: null,
          homeCourtsWon: null,
          visitingCourtsWon: null,
        });

        const payload: ScorecardPayload = {
          ...basePayload(home.name, visiting.name),
          scheduledTime: "9:00 AM",
          site: "Court 1",
        };

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.teamMatchId).toBe(exactRow.id);
      } finally {
        sqlite.close();
      }
    });

    // Codex adversarial review of PR #54 round 4, High finding 2 — the FOURTH time this exact
    // class (a set that could hold more than one row, picked from via `.find()`/`[0]` with no
    // ambiguity check) has surfaced in this PR: within a court (round 2), across courts in one
    // payload (round 2), across CALLS for the same court (round 2's participant-replacement fix),
    // and now the exact-tier candidate search itself, one level out from the lenient tier the
    // PRIOR round already fixed. There is no DB uniqueness constraint on the id-less natural key
    // `(unordered team pair, playedOn, normalized time, normalized site)`, so two rows that are
    // BOTH an exact match for an incoming payload are representable, and `.find()` would silently
    // pick whichever SQLite returns first — attaching this payload's courts to ONE of them and
    // leaving the other stale, exactly the same failure shape the lenient-tier fix (finding 2 of
    // round 3) already closed one tier over.
    it("REGRESSION (Codex High finding 2, round 4): two EXACT duplicate parent rows also refuse as ambiguous, not just lenient-compatible ones", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        // Two rows that are EXACT duplicates of each other under normalization — representable
        // because there is no DB constraint preventing it. Inserted DIRECTLY (bypassing
        // `upsertTeamMatch`) because that function's OWN id-less matching would otherwise merge
        // these two calls into one row itself — the whole point here is a pre-existing anomaly
        // `upsertTeamMatch` never lets its own callers create, not one reachable through it.
        const rowA = db
          .insert(teamMatches)
          .values({
            homeTeamId: home.id,
            visitingTeamId: visiting.id,
            playedOn: "2026-08-28",
            scheduledTime: "9:00 AM",
            site: "Court 1",
            sourceMatchId: null,
            homeCourtsWon: null,
            visitingCourtsWon: null,
          })
          .returning()
          .get();
        const rowB = db
          .insert(teamMatches)
          .values({
            homeTeamId: home.id,
            visitingTeamId: visiting.id,
            playedOn: "2026-08-28",
            scheduledTime: "09:00 AM", // same time under normalization, different raw string
            site: "Court 1",
            sourceMatchId: null,
            homeCourtsWon: null,
            visitingCourtsWon: null,
          })
          .returning()
          .get();
        expect(db.select().from(teamMatches).all()).toHaveLength(2); // sanity: genuinely two rows

        const payload: ScorecardPayload = {
          ...basePayload(home.name, visiting.name),
          scheduledTime: "9:00 AM",
          site: "Court 1",
        };

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(false);
        if (!result.ok && result.kind === "ambiguous-parent-match") {
          expect(result.candidates.map((c) => c.teamMatchId).sort()).toEqual([rowA.id, rowB.id].sort());
        } else {
          throw new Error("expected an ambiguous-parent-match refusal");
        }

        expect(db.select().from(teamMatches).all()).toHaveLength(2);
        expect(db.select().from(courtMatches).all()).toHaveLength(0);
      } finally {
        sqlite.close();
      }
    });

    // Codex adversarial review of PR #54 round 7, rated HIGH: the candidate query above filtered
    // `isNull(teamMatches.sourceMatchId)`, so it skipped EVERY row `team-pull` already wrote with a
    // real `mid=` — reachable in the documented workflow, not a corner case: pull a schedule
    // containing a completed fixture, then submit a scorecard for that same fixture, and the
    // existing source-backed row was invisible to this function, which inserted a SECOND,
    // source-less parent for the identical real-world match. Fixed by dropping the `isNull` filter
    // from the candidate query entirely — a source-backed row is now just another candidate, subject
    // to the SAME exact-then-lenient precedence and the SAME ambiguity refusal as before. Preserving
    // `sourceMatchId` needed no new code: the UPDATE's `.set({...})` never mentions that column (a
    // scorecard payload has no `mid=` of its own to offer), so it is left exactly as stored on every
    // update, source-backed or not — the same "nothing to fill in with, so nothing changes" shape
    // `homeTeamId`/`visitingTeamId`/`homeCourtsWon`/`visitingCourtsWon` already have on this path.
    it("REGRESSION (Codex round 7, rated High): a scorecard attaches to an existing SOURCE-BACKED row for the same fixture rather than duplicating it", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const sourceBacked = db
          .insert(teamMatches)
          .values({
            eventId: null,
            homeTeamId: home.id,
            visitingTeamId: visiting.id,
            playedOn: "2026-08-28",
            scheduledTime: "9:00 AM",
            site: "Court 1",
            sourceMatchId: "181505",
            homeCourtsWon: 3,
            visitingCourtsWon: 2,
          })
          .returning()
          .get();

        const payload: ScorecardPayload = {
          ...basePayload(home.name, visiting.name),
          scheduledTime: "9:00 AM",
          site: "Court 1",
        };

        const result = addMatchFromScorecard(db, payload);

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.teamMatchId).toBe(sourceBacked.id);

        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1); // not duplicated
        expect(rows[0]!.sourceMatchId).toBe("181505"); // preserved, never nulled out

        expect(
          db
            .select()
            .from(courtMatches)
            .all()
            .filter((c) => c.teamMatchId === sourceBacked.id),
        ).toHaveLength(2); // S1 + D1 attached to the SAME (source-backed) row
      } finally {
        sqlite.close();
      }
    });

    // The reviewer's own named integration regression: through the REAL `pullTeam` path (a genuine
    // `mid=` parsed off the tennisrecord fixture, not a hand-seeded row), rather than assuming the
    // unit-level test above generalizes.
    it("REGRESSION (Codex round 7, integration): a scorecard for a fixture team-pull already recorded with a mid= attaches to it, not a duplicate", async () => {
      const { db, sqlite } = freshDb();
      try {
        const fetchPage = createStubFetcher({
          [tennisrecordTeamFixture.source.url]: { body: tennisrecordTeamFixture.html },
        });
        const pullResult = await pullTeam({ db, fetchPage, target: tennisrecordTeamFixture.source.url });
        expect(pullResult.kind).toBe("ok");

        const norbury = db.select().from(teams).all().find((t) => t.name === "Norbury, Nova")!;
        const granborough = db.select().from(teams).all().find((t) => t.name === "Granborough, Galen")!;

        // Sanity: the pull really did write a source-backed parent for this exact fixture, from the
        // fixture's own schedule row (04/09/2026, 8:00 PM, Clayview Country Club, mid=181505).
        const pulled = db
          .select()
          .from(teamMatches)
          .all()
          .filter((m) => m.playedOn === "2026-04-09" && m.homeTeamId === norbury.id && m.visitingTeamId === granborough.id);
        expect(pulled).toHaveLength(1);
        expect(pulled[0]?.sourceMatchId).toBe("181505");

        seedRosterPlayer(db, norbury.id, "Ada Ashby");
        seedRosterPlayer(db, norbury.id, "Bo Bramwell");
        seedRosterPlayer(db, granborough.id, "Opp One");
        seedRosterPlayer(db, granborough.id, "Opp Two");

        const payload: ScorecardPayload = {
          playedOn: "2026-04-09",
          homeTeam: "Norbury, Nova",
          visitingTeam: "Granborough, Galen",
          scheduledTime: "8:00 PM",
          site: "Clayview Country Club",
          courts: [{ slot: "S1", discipline: "singles", homePlayers: ["Ada Ashby"], visitingPlayers: ["Opp One"] }],
        };

        const result = addMatchFromScorecard(db, payload);
        expect(result.ok).toBe(true);

        const rows = db
          .select()
          .from(teamMatches)
          .all()
          .filter((m) => m.playedOn === "2026-04-09" && m.homeTeamId === norbury.id && m.visitingTeamId === granborough.id);
        expect(rows).toHaveLength(1); // still one row, not a duplicate parent
        expect(rows[0]?.sourceMatchId).toBe("181505"); // intact

        if (result.ok) {
          const courts = db
            .select()
            .from(courtMatches)
            .all()
            .filter((c) => c.teamMatchId === rows[0]!.id);
          expect(courts).toHaveLength(1);
          expect(courts[0]?.slot).toBe("S1");
        }
      } finally {
        sqlite.close();
      }
    });
  });

  // Codex adversarial review of PR #54 round 4, High finding 1: the update branch ignored
  // `eventId` entirely for MATCHING (correct — an event link is not a fixture discriminator) but
  // then wrote the incoming value UNCONDITIONALLY, so a correction submitted without an `event`
  // silently DETACHED an already-linked match (`event_id` overwritten with NULL), and a
  // correction naming a DIFFERENT event silently MOVED it. Fixed with the identical symmetric
  // fill-in-blanks idiom already used for `scheduledTime`/`site`: an omitted incoming event
  // PRESERVES the stored one, a stored-null is FILLED IN by a supplied one, and two DIFFERENT
  // supplied event ids are a genuine CONFLICT — refused, naming both, never silently decided.
  describe("conflicting/omitted parent event (Codex High finding 1)", () => {
    function seedEvent(db: TestDb, name: string) {
      return db
        .insert(events)
        .values({ name, kind: "tournament", startsOn: "2026-08-01", endsOn: "2026-08-31" })
        .returning()
        .get();
    }

    it("REGRESSION: a correction that OMITS the event preserves the stored event link rather than detaching it", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const eventA = seedEvent(db, "Event A");

        const first = addMatchFromScorecard(db, { ...basePayload(home.name, visiting.name), event: eventA.name });
        expect(first.ok).toBe(true);

        // The correction omits `event` entirely — same as a captain resubmitting to fix a score,
        // not thinking to repeat the event name every time.
        const second = addMatchFromScorecard(db, basePayload(home.name, visiting.name));

        expect(second.ok).toBe(true);
        if (first.ok && second.ok) expect(second.teamMatchId).toBe(first.teamMatchId);
        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.eventId).toBe(eventA.id); // NOT nulled out
      } finally {
        sqlite.close();
      }
    });

    it("a correction that SUPPLIES an event fills in a previously-null one", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const eventA = seedEvent(db, "Event A");

        const first = addMatchFromScorecard(db, basePayload(home.name, visiting.name)); // no event
        expect(first.ok).toBe(true);

        const second = addMatchFromScorecard(db, { ...basePayload(home.name, visiting.name), event: eventA.name });

        expect(second.ok).toBe(true);
        if (first.ok && second.ok) expect(second.teamMatchId).toBe(first.teamMatchId);
        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.eventId).toBe(eventA.id);
      } finally {
        sqlite.close();
      }
    });

    it("re-ingesting with the SAME event again is a no-op, not a conflict", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const eventA = seedEvent(db, "Event A");
        const payload: ScorecardPayload = { ...basePayload(home.name, visiting.name), event: eventA.name };

        const first = addMatchFromScorecard(db, payload);
        const second = addMatchFromScorecard(db, payload);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (first.ok && second.ok) expect(second.teamMatchId).toBe(first.teamMatchId);
        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.eventId).toBe(eventA.id);
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION: a correction naming a DIFFERENT event refuses rather than silently moving the match", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const eventA = seedEvent(db, "Event A");
        const eventB = seedEvent(db, "Event B");

        const first = addMatchFromScorecard(db, { ...basePayload(home.name, visiting.name), event: eventA.name });
        expect(first.ok).toBe(true);

        const second = addMatchFromScorecard(db, { ...basePayload(home.name, visiting.name), event: eventB.name });

        expect(second.ok).toBe(false);
        if (!second.ok) expect(second.kind).toBe("conflicting-parent-event");

        // Nothing moved: the stored row still points at Event A.
        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.eventId).toBe(eventA.id);
      } finally {
        sqlite.close();
      }
    });
  });
});

// Codex adversarial review (PR #54 round 5), rated CRITICAL under PROJECT.md's Review Severity
// Framework ("security hole" ⇒ Critical, raised from the reviewer's own High): `sourceImage` was
// validated only as a non-empty string, then `readFileSync`'d and archived BEFORE
// `addMatchFromScorecard` ever ran — a syntactically valid payload naming an arbitrary local file
// (an SSH key, `/etc/hosts`) got that file's bytes copied into `raw/scorecard/`, and a refused
// ingest still persisted them regardless. `archiveScorecardImage` now validates the source path
// (containment in a configured root, no symlinks anywhere in the chain), its size, and its actual
// content (a magic-byte sniff, never extension alone) before reading anything; the new
// `addMatchFromScorecardWithArchive` defers archiving until AFTER a successful service call, so a
// refused ingest persists nothing — see that function's own doc comment in src/ingest/match-add.ts
// for the ordering-interaction decision (a post-commit archive failure surfaces as `archiveError`
// rather than an opaque throw, since the DB write cannot be rolled back by that point).
describe("archiveScorecardImage / addMatchFromScorecardWithArchive (Codex round 5, sourceImage hardening, rated Critical)", () => {
  useTnDbPath();
  const rawPath = useTnRawPath();
  const photosPath = useTnScorecardPhotosPath();

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function writeFileAt(path: string, contents: Buffer): string {
    writeFileSync(path, contents);
    return path;
  }

  /** Every fixture below writes inside the configured scorecard-photos root by default — a source
   * path a test wants to fail containment writes elsewhere instead (see the "outside the root"
   * tests). */
  function writeIntakeFile(name: string, contents: Buffer): string {
    return writeFileAt(join(photosPath.path(), name), contents);
  }

  function writeOutsideRootFile(name: string, contents: Buffer): string {
    const outsideDir = mkdtempSync(join(tmpdir(), "tn-outside-scorecard-photos-"));
    return writeFileAt(join(outsideDir, name), contents);
  }

  /** `archivePage` only creates `raw/scorecard/` on an actual write, so "nothing archived" is
   * exactly "this directory does not exist" as much as "it exists and is empty". */
  function rawScorecardEntries(): string[] {
    const dir = join(rawPath.path(), "scorecard");
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  it("archives a valid PNG inside the configured root, with its provenance sidecar", () => {
    const sourceBytes = Buffer.concat([PNG_MAGIC, Buffer.from([1, 2, 3])]);
    const sourcePath = writeIntakeFile("court1.png", sourceBytes);

    const archivedPath = archiveScorecardImage(sourcePath);

    expect(existsSync(archivedPath)).toBe(true);
    expect(readFileSync(archivedPath)).toEqual(sourceBytes);
    expect(existsSync(`${archivedPath}.provenance.json`)).toBe(true);
  });

  it("refuses a source path outside the configured scorecard-photos root", () => {
    const outsidePath = writeOutsideRootFile("court1.png", Buffer.concat([PNG_MAGIC, Buffer.from([1])]));

    expect(() => archiveScorecardImage(outsidePath)).toThrow();
    expect(rawScorecardEntries()).toHaveLength(0);
  });

  it("refuses a symlink pointing outside the configured root", () => {
    const outsidePath = writeOutsideRootFile("real.png", Buffer.concat([PNG_MAGIC, Buffer.from([1])]));
    const linkPath = join(photosPath.path(), "link.png");
    symlinkSync(outsidePath, linkPath);

    expect(() => archiveScorecardImage(linkPath)).toThrow();
    expect(rawScorecardEntries()).toHaveLength(0);
  });

  it("refuses a non-image file with a .png name — the magic-byte sniff decides, not the extension", () => {
    const notAnImage = writeIntakeFile("scorecard.png", Buffer.from("just some ordinary text, not an image", "utf8"));

    expect(() => archiveScorecardImage(notAnImage)).toThrow();
    expect(rawScorecardEntries()).toHaveLength(0);
  });

  it("refuses a file over the size limit", () => {
    const oversized = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_SCORECARD_IMAGE_BYTES)]); // one byte over the cap
    const oversizedPath = writeIntakeFile("huge.png", oversized);

    expect(() => archiveScorecardImage(oversizedPath)).toThrow();
    expect(rawScorecardEntries()).toHaveLength(0);
  });

  // Codex round 6, rated CRITICAL: a pathname check (containment, symlink-component walk, magic-byte
  // sniff) proves nothing about a HARDLINK — `lstat` on a hardlinked path reports an ordinary regular
  // file, indistinguishable from the genuine article, because a hardlink IS the same inode under a
  // second name. The only thing that can catch it is the link count on the OPENED file descriptor.
  it("REGRESSION (Codex round 6, rated Critical): a hardlink inside the root to an outside file is refused", () => {
    const outsidePath = writeOutsideRootFile("real.png", Buffer.concat([PNG_MAGIC, Buffer.from([1])]));
    const linkPath = join(photosPath.path(), "hardlink.png");
    linkSync(outsidePath, linkPath);

    expect(() => archiveScorecardImage(linkPath)).toThrow();
    expect(rawScorecardEntries()).toHaveLength(0);
  });

  it("REGRESSION (Codex round 6): a file with nlink > 1 is refused generally, even when BOTH names sit inside the root — the check is unconditional on link count, not on where the other name happens to be", () => {
    const firstName = writeIntakeFile("original.png", Buffer.concat([PNG_MAGIC, Buffer.from([1])]));
    const secondName = join(photosPath.path(), "also-original.png");
    linkSync(firstName, secondName);

    expect(() => archiveScorecardImage(secondName)).toThrow();
    expect(rawScorecardEntries()).toHaveLength(0);
  });

  describe("addMatchFromScorecardWithArchive — ordering (a refused ingest persists nothing)", () => {
    it("an unknown-team refusal leaves nothing archived, even with a valid sourceImage", () => {
      const { db, sqlite } = freshDb();
      try {
        const visiting = seedTeam(db, "Report Opponent");
        seedRosterPlayer(db, visiting.id, "Opp One");
        seedRosterPlayer(db, visiting.id, "Opp Two");
        seedRosterPlayer(db, visiting.id, "Opp Three");
        const sourcePath = writeIntakeFile("court1.png", Buffer.concat([PNG_MAGIC, Buffer.from([1])]));
        const payload: ScorecardPayload = { ...basePayload("No Such Team", visiting.name), sourceImage: sourcePath };

        const outcome = addMatchFromScorecardWithArchive(db, payload);

        expect(outcome.serviceResult.ok).toBe(false);
        if (!outcome.serviceResult.ok) expect(outcome.serviceResult.kind).toBe("unknown-team");
        expect(outcome.archivedPath).toBeUndefined();
        expect(outcome.archiveError).toBeUndefined();
        expect(rawScorecardEntries()).toHaveLength(0);
      } finally {
        sqlite.close();
      }
    });

    it("an unresolved-player refusal leaves nothing archived, even with a valid sourceImage", () => {
      const { db, sqlite } = freshDb();
      try {
        const home = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
        const visiting = seedTeam(db, "Report Opponent");
        // Deliberately no roster seeded at all — every name in basePayload will flag as unresolved.
        const sourcePath = writeIntakeFile("court1.png", Buffer.concat([PNG_MAGIC, Buffer.from([1])]));
        const payload: ScorecardPayload = { ...basePayload(home.name, visiting.name), sourceImage: sourcePath };

        const outcome = addMatchFromScorecardWithArchive(db, payload);

        expect(outcome.serviceResult.ok).toBe(false);
        if (!outcome.serviceResult.ok) expect(outcome.serviceResult.kind).toBe("unresolved-players");
        expect(outcome.archivedPath).toBeUndefined();
        expect(outcome.archiveError).toBeUndefined();
        expect(rawScorecardEntries()).toHaveLength(0);
      } finally {
        sqlite.close();
      }
    });

    it("the happy path archives AFTER the DB write succeeds", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        const sourcePath = writeIntakeFile("court1.png", Buffer.concat([PNG_MAGIC, Buffer.from([1])]));
        const payload: ScorecardPayload = { ...basePayload(home.name, visiting.name), sourceImage: sourcePath };

        const outcome = addMatchFromScorecardWithArchive(db, payload);

        expect(outcome.serviceResult.ok).toBe(true);
        expect(outcome.archivedPath).toBeDefined();
        expect(outcome.archiveError).toBeUndefined();
        expect(rawScorecardEntries()).toHaveLength(2); // the archived leaf plus its provenance sidecar
      } finally {
        sqlite.close();
      }
    });

    it("an archive failure AFTER a successful DB write surfaces as archiveError rather than an opaque throw — the write already committed and is NOT rolled back", () => {
      const { db, sqlite } = freshDb();
      try {
        const { home, visiting } = seedStandardRosters(db);
        // A source path OUTSIDE the configured root: guaranteed to fail archiving, isolating the
        // "committed write, failed archive" interaction from anything else that could go wrong.
        const outsidePath = writeOutsideRootFile("court1.png", Buffer.concat([PNG_MAGIC, Buffer.from([1])]));
        const payload: ScorecardPayload = { ...basePayload(home.name, visiting.name), sourceImage: outsidePath };

        const outcome = addMatchFromScorecardWithArchive(db, payload);

        expect(outcome.serviceResult.ok).toBe(true);
        expect(outcome.archivedPath).toBeUndefined();
        expect(outcome.archiveError).toBeDefined();
        expect(rawScorecardEntries()).toHaveLength(0);

        // The DB write is NOT rolled back — the match rows genuinely exist despite the archive
        // failure, which is the whole reason this is surfaced rather than thrown as one opaque error.
        const rows = db.select().from(teamMatches).all();
        expect(rows).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    });
  });
});
