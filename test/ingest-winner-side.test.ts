// Defect 1 (#17 PR B): `pullPlayer` hardcoded `winnerSide: null` for every court match it wrote,
// while the match-history parser had already produced `result: "W" | "L"` and nothing consumed it.
// `windowedRecord` and `headToHead` both treat `winnerSide === null` as *undecided* by design
// (src/query/derive.ts), so every W/L figure in every shipped dossier read 0W-0L with all matches
// undecided. The derive layer was correct; it had never been given a winner.
//
// These tests assert the derived record, not only the column — asserting `winner_side` alone would
// pass while the user-visible symptom (a dossier reading 0-0) stayed broken.

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, runMigrations } from "../src/db/client.js";
import { courtMatchPlayers, courtMatches, players } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { pullPlayer } from "../src/ingest/player-pull.js";
import { parseMatchHistory } from "../src/parsers/index.js";
import { windowedRecord } from "../src/query/derive.js";
import type { CourtMatchRow, Side } from "../src/query/types.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const matchHistory = loadFixture("tennisrecord/match-history");

/** The shape `windowedRecord` consumes, assembled from real DB rows rather than hand-built — so
 * these tests exercise the same read path `getPlayerProfile` uses. */
function courtMatchRowsFor(db: ReturnType<typeof openDb>["db"], playerId: number): CourtMatchRow[] {
  const participantRows = db.select().from(courtMatchPlayers).all();
  const ownMatchIds = new Set(participantRows.filter((p) => p.playerId === playerId).map((p) => p.courtMatchId));
  return db
    .select()
    .from(courtMatches)
    .all()
    .filter((c) => ownMatchIds.has(c.id))
    .map((c) => ({
      id: c.id,
      slot: c.slot,
      discipline: c.discipline as CourtMatchRow["discipline"],
      winnerSide: c.winnerSide as Side | null,
      playedOn: c.playedOn,
      participants: participantRows
        .filter((p) => p.courtMatchId === c.id)
        .map((p) => ({ playerId: p.playerId, side: p.side as Side })),
    }));
}

describe("pullPlayer writes winner_side from the parsed result", () => {
  useTnDbPath();
  useTnRawPath();

  it("records a W as the profiled player's own side and an L as the opposing side", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const fetcher = createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } });
      const result = await pullPlayer({ db, fetchPage: fetcher, url: matchHistory.source.url });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");

      // Ground truth from the same parser, so the expectation is derived from the fixture rather
      // than transcribed beside it.
      const records = parseMatchHistory(matchHistory.html, matchHistory.source);
      const wins = records.filter((r) => r.result === "W");
      const losses = records.filter((r) => r.result === "L");
      // Guard the fixture itself: a fixture that were all-W would let a hardcoded "home" pass.
      expect(wins.length).toBeGreaterThan(0);
      expect(losses.length).toBeGreaterThan(0);

      // The profiled player is always written on side "home" by this ingest path, so a W means the
      // winner is "home" and an L means it is "visiting".
      for (const record of wins) {
        const row = db.select().from(courtMatches).where(eq(courtMatches.sourceMatchId, record.sourceMatchId!)).all()[0];
        expect(row?.winnerSide, `mid=${record.sourceMatchId} (a W)`).toBe("home");
      }
      for (const record of losses) {
        const row = db.select().from(courtMatches).where(eq(courtMatches.sourceMatchId, record.sourceMatchId!)).all()[0];
        expect(row?.winnerSide, `mid=${record.sourceMatchId} (an L)`).toBe("visiting");
      }

      // The symptom this defect actually produced: the derived record, which is what a dossier
      // renders. Before the fix this read { wins: 0, losses: 0, undecided: 14 }.
      const profiled = db.select().from(players).all()[0]!;
      const record = windowedRecord(courtMatchRowsFor(db, profiled.id), profiled.id);
      expect(record).toEqual({
        wins: wins.length,
        losses: losses.length,
        undecided: 0,
        excludedUndated: 0,
      });
    } finally {
      sqlite.close();
    }
  });
});

// NAMED FOR WHAT IT ACTUALLY COVERS, after the independent Codex review of PR #47 pointed out
// (rated medium) that the earlier name — "survives a pull from the opposing perspective" — claimed
// pull-layer coverage this block does not have: it drives `upsertCourtMatch` / `upsertCourtMatchPlayers`
// directly, so reverting `player-pull.ts` to `winnerSide: null` leaves it green.
//
// Two remedies were available. Building two opposing player-page fixtures would make it a genuine
// dual-pull, but it means authoring TennisRecord pages through this repo's fixture capture and
// redaction policy for one assertion — and the pull layer is ALREADY protected: the first test in
// this file drives `pullPlayer` against the real fixture and goes red on exactly that revert, for
// both a W and an L. So the accurate fix is to stop the name overclaiming rather than to fabricate
// a fixture, which is the repo's own rule about a docstring claiming coverage the code does not
// enforce (`rules/testing.md`), applied to a test title.
//
// What this block DOES cover, and nothing else does: the upsert-layer invariant underneath the
// pull. Sides in `court_match_players` are PULL-PERSPECTIVE — `upsertCourtMatchPlayers` conflicts
// on (courtMatchId, playerId) and SETS `side`, so pulling an opposing player rewrites every
// participant from that player's perspective. The flip is symmetric and `windowedRecord` is
// perspective-invariant only because `winner_side` flips WITH the sides. This fails if a later
// refactor hoists the winner out of the loop that assigns them.
describe("upsert layer: winner_side stays consistent when a court match is rewritten from the other side", () => {
  useTnDbPath();

  it("keeps both players' records correct after the same court match is rewritten from the other side", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const ours = db.insert(players).values({ canonicalName: "Alex Winner" }).returning().get();
      const theirs = db.insert(players).values({ canonicalName: "Blair Loser" }).returning().get();

      // Pull 1 — from Alex's page. Alex won, so Alex's own side ("home") is the winner.
      const first = upsertCourtMatch(db, {
        teamMatchId: null,
        slot: "S1",
        discipline: "singles",
        winnerSide: "home",
        score: "6-3 6-4",
        leagueContext: "40+ 3.5",
        playedOn: "2026-05-01",
        sourceMatchId: "9001",
      });
      upsertCourtMatchPlayers(db, { courtMatchId: first.id, playerId: ours.id, side: "home" });
      upsertCourtMatchPlayers(db, { courtMatchId: first.id, playerId: theirs.id, side: "visiting" });

      expect(windowedRecord(courtMatchRowsFor(db, ours.id), ours.id)).toMatchObject({ wins: 1, losses: 0 });
      expect(windowedRecord(courtMatchRowsFor(db, theirs.id), theirs.id)).toMatchObject({ wins: 0, losses: 1 });

      // Pull 2 — the SAME court match (same mid + slot) from Blair's page. Blair lost, so from that
      // perspective the profiled player is "home" and the winner is "visiting". Every side flips.
      const second = upsertCourtMatch(db, {
        teamMatchId: null,
        slot: "S1",
        discipline: "singles",
        winnerSide: "visiting",
        score: "6-3 6-4",
        leagueContext: "40+ 3.5",
        playedOn: "2026-05-01",
        sourceMatchId: "9001",
      });
      expect(second.id, "the same court match, not a duplicate row").toBe(first.id);
      upsertCourtMatchPlayers(db, { courtMatchId: second.id, playerId: theirs.id, side: "home" });
      upsertCourtMatchPlayers(db, { courtMatchId: second.id, playerId: ours.id, side: "visiting" });

      // Both records are unchanged: the flip is symmetric because the winner flipped with the sides.
      expect(windowedRecord(courtMatchRowsFor(db, ours.id), ours.id)).toMatchObject({ wins: 1, losses: 0 });
      expect(windowedRecord(courtMatchRowsFor(db, theirs.id), theirs.id)).toMatchObject({ wins: 0, losses: 1 });
    } finally {
      sqlite.close();
    }
  });
});
