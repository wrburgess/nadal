import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { courtMatchPlayers, courtMatches, players, ratingObservations } from "../src/db/schema.js";
import { parseMatchHistory } from "../src/parsers/index.js";
import { pullPlayer } from "../src/ingest/player-pull.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";

const matchHistory = loadFixture("tennisrecord/match-history");
const empty = loadFixture("tennisrecord/match-history-empty");

describe("pullPlayer", () => {
  useTnDbPath();

  it("writes court matches, court-match players, and rating observations, hand-verified against the fixture", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const fetcher = createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } });
      const result = await pullPlayer({ db, fetchPage: fetcher, url: matchHistory.source.url });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");

      // Ground truth from the same parser the parser test suite already verifies exhaustively —
      // aggregating it independently here checks the PIPELINE wrote what the parser produced,
      // not a number invented separately from the fixture.
      const expectedRecords = parseMatchHistory(matchHistory.html, matchHistory.source);
      expect(result.courtMatchCount).toBe(expectedRecords.length);
      expect(expectedRecords).toHaveLength(14);

      const courtMatchRows = db.select().from(courtMatches).all();
      expect(courtMatchRows).toHaveLength(14);

      const expectedParticipants = expectedRecords.reduce(
        (sum, r) => sum + 1 /* the profiled player */ + (r.partner === null ? 0 : 1) + r.opponents.length,
        0,
      );
      const participantRows = db.select().from(courtMatchPlayers).all();
      expect(participantRows).toHaveLength(expectedParticipants);

      // Spot-check the first record in full (doubles, both sides populated).
      const firstCourtMatch = courtMatchRows.find((c) => c.sourceMatchId === "20336");
      expect(firstCourtMatch).toMatchObject({ slot: "D2", discipline: "doubles", score: "7-6 6-3" });
      const firstParticipants = participantRows.filter((p) => p.courtMatchId === firstCourtMatch?.id);
      expect(firstParticipants).toHaveLength(4); // profiled player + partner + 2 opponents

      const ratingRows = db.select().from(ratingObservations).all();
      expect(ratingRows).toHaveLength(2);
      expect(ratingRows.find((r) => r.source === "ntrp")).toMatchObject({
        value: 4.0,
        ratingType: "C",
        observedOn: "2025-12-31",
      });
      expect(ratingRows.find((r) => r.source === "tr_dynamic")).toMatchObject({
        value: 3.6663,
        observedOn: "2026-07-27",
      });

      const playerRows = db.select().from(players).all();
      const profiled = playerRows.find((p) => p.canonicalName === "Avery Ashby");
      expect(profiled).toBeDefined();
      expect(profiled?.tennisrecordUrl).toBe(matchHistory.source.url);
    } finally {
      sqlite.close();
    }
  });

  it("a season with no matches writes zero court matches and still succeeds", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const fetcher = createStubFetcher({ [empty.source.url]: { body: empty.html } });
      const result = await pullPlayer({ db, fetchPage: fetcher, url: empty.source.url });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.courtMatchCount).toBe(0);
      expect(db.select().from(courtMatches).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("SAD: a structurally broken page returns an error and writes ZERO rows (asserted, not assumed)", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const broken = matchHistory.html.replace(/<div class="large">/, '<div class="gone">');
      expect(broken).not.toBe(matchHistory.html);

      const fetcher = createStubFetcher({ [matchHistory.source.url]: { body: broken } });
      const result = await pullPlayer({ db, fetchPage: fetcher, url: matchHistory.source.url });

      expect(result.kind).toBe("error");
      expect(db.select().from(players).all()).toHaveLength(0);
      expect(db.select().from(courtMatches).all()).toHaveLength(0);
      expect(db.select().from(courtMatchPlayers).all()).toHaveLength(0);
      expect(db.select().from(ratingObservations).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});
