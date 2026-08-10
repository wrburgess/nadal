import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { captainNotes, players, teamMemberships, teams } from "../src/db/schema.js";
import {
  EmptyCaptainNoteError,
  NoHomeTeamError,
  PlayerNotOnHomeRosterError,
  SelfPairingCaptainNoteError,
  addCaptainNote,
  getCaptainNotes,
} from "../src/query/captain-notes.js";
import { seedHomeTeamFixture } from "./helpers/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

function rows(db: Db) {
  return db.select().from(captainNotes).all();
}

describe("addCaptainNote", () => {
  useTnDbPath();

  it("adds a player note, recording createdAt", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const before = new Date().toISOString();
      const note = addCaptainNote(db, { playerId: fixture.playerId, text: "Serves big on big points." });
      expect(note.note).toBe("Serves big on big points.");
      expect(note.pairPlayerId).toBeNull();
      expect(note.createdAt >= before).toBe(true);

      const all = rows(db);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ playerId: fixture.playerId, note: "Serves big on big points." });
    } finally {
      sqlite.close();
    }
  });

  it("adds a pairing note with pairPlayerId set", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const partner = db.insert(players).values({ canonicalName: "Partner Player" }).returning().get();
      db.insert(teamMemberships)
        .values({ playerId: partner.id, teamId: fixture.homeTeamId, eventId: fixture.eventId })
        .run();

      const note = addCaptainNote(db, {
        playerId: fixture.playerId,
        pairPlayerId: partner.id,
        text: "Strong at the net together.",
      });
      expect(note.pairPlayerId).toBe(partner.id);
    } finally {
      sqlite.close();
    }
  });

  it("append-only: two notes on one player produce two rows (contrast with availability's upsert)", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      addCaptainNote(db, { playerId: fixture.playerId, text: "First note." });
      addCaptainNote(db, { playerId: fixture.playerId, text: "Second note." });

      const all = rows(db);
      expect(all).toHaveLength(2);
      expect(all.map((r) => r.note).sort()).toEqual(["First note.", "Second note."]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects empty text (EmptyCaptainNoteError) and writes nothing", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      expect(() => addCaptainNote(db, { playerId: fixture.playerId, text: "" })).toThrow(EmptyCaptainNoteError);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("rejects whitespace-only text — stripped BEFORE the guard, so it reads as absent, not present", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      expect(() => addCaptainNote(db, { playerId: fixture.playerId, text: "   \t\n  " })).toThrow(
        EmptyCaptainNoteError,
      );
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("rejects a pairing note where the pair equals the player (SelfPairingCaptainNoteError)", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      expect(() =>
        addCaptainNote(db, { playerId: fixture.playerId, pairPlayerId: fixture.playerId, text: "Self pair." }),
      ).toThrow(SelfPairingCaptainNoteError);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("rejects a note on a non-home-team player (PlayerNotOnHomeRosterError)", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const otherTeam = db.insert(teams).values({ name: "Opponent" }).returning().get();
      const otherPlayer = db.insert(players).values({ canonicalName: "Opponent Player" }).returning().get();
      db.insert(teamMemberships)
        .values({ playerId: otherPlayer.id, teamId: otherTeam.id, eventId: fixture.eventId })
        .run();

      expect(() => addCaptainNote(db, { playerId: otherPlayer.id, text: "About an opponent." })).toThrow(
        PlayerNotOnHomeRosterError,
      );
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  // Issue #49. Both call sites in `captain-notes.ts` (the subject player AND the pairing partner)
  // go through the SAME `isOnHomeRoster` helper, but a test that only covers one of the two call
  // sites would pass under a fix that filtered just one of them — so both are asserted here,
  // separately, each pinned by error CLASS rather than message text.
  it("rejects a note ABOUT a retired subject (PlayerNotOnHomeRosterError)", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, fixture.playerId))
        .run();

      expect(() => addCaptainNote(db, { playerId: fixture.playerId, text: "About a former player." })).toThrow(
        PlayerNotOnHomeRosterError,
      );
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("rejects a pairing note whose PARTNER is retired, even though the subject player is current", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const partner = db.insert(players).values({ canonicalName: "Retired Partner" }).returning().get();
      db.insert(teamMemberships)
        .values({ playerId: partner.id, teamId: fixture.homeTeamId, eventId: fixture.eventId, retiredAt: "2026-07-01T00:00:00.000Z" })
        .run();

      expect(() =>
        addCaptainNote(db, { playerId: fixture.playerId, pairPlayerId: partner.id, text: "About a retired partner." }),
      ).toThrow(PlayerNotOnHomeRosterError);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("refuses when no home team is designated at all (NoHomeTeamError)", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = db.insert(players).values({ canonicalName: "Nobody's Home" }).returning().get();
      expect(() => addCaptainNote(db, { playerId: player.id, text: "Anything." })).toThrow(NoHomeTeamError);
      expect(rows(db)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("does not inject markup or break a rendered summary line regardless of note text content (property, not mechanism)", () => {
    // #16 shipped a live <script> from a player name because a prior test asserted the MECHANISM
    // named in a plan (escape pipes and backticks) instead of the PROPERTY: no text this system
    // accepts can inject markup or break the CLI's summary-line format. This does not re-implement
    // an HTML/markdown escaper here — that already exists (src/report/html.ts, src/report/
    // markdown.ts, src/sanitize.ts) and is exercised at ITS OWN boundary. What this test pins is
    // that `addCaptainNote` itself never mangles or rejects arbitrary text on write — sanitization
    // for a given OUTPUT boundary is that boundary's job, not the write service's, and the write
    // service must not silently corrupt the stored value before it ever reaches one.
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const hostile = '<script>alert(1)</script>\nkey="value" pipe|backtick`quote"  ';
      const note = addCaptainNote(db, { playerId: fixture.playerId, text: hostile });
      // Stored verbatim (leading/trailing whitespace aside — none here) — no character class is
      // stripped, escaped, or rejected by the WRITE service itself.
      expect(note.note).toBe(hostile);
      const stored = rows(db)[0]!;
      expect(stored.note).toBe(hostile);
    } finally {
      sqlite.close();
    }
  });
});

// #126 — the READ side, the counterpart to `getAvailabilityForEvent`. As with availability, nothing
// read these rows back as CONTENT before this issue.
describe("getCaptainNotes", () => {
  useTnDbPath();

  it("returns player notes newest first", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const older = addCaptainNote(db, { playerId: fixture.playerId, text: "older" });
      const newer = addCaptainNote(db, { playerId: fixture.playerId, text: "newer" });

      // `addCaptainNote` stamps `createdAt` itself from the wall clock, so two appends inside one
      // millisecond would tie and the ordering assertion would pass or fail by luck. Pin the two
      // timestamps AFTER the real writer has run — the insert path under test stays the production
      // one; only the clock is made deterministic (rules/testing.md: never race a real clock).
      db.update(captainNotes).set({ createdAt: "2026-08-01T00:00:00.000Z" }).where(eq(captainNotes.id, older.id)).run();
      db.update(captainNotes).set({ createdAt: "2026-08-09T00:00:00.000Z" }).where(eq(captainNotes.id, newer.id)).run();

      const view = getCaptainNotes(db, { teamId: fixture.homeTeamId });

      expect(view.player.map((n) => n.note)).toEqual(["newer", "older"]);
    } finally {
      sqlite.close();
    }
  });

  it("separates a pairing note from a player note and names both partners", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      const partner = db.insert(players).values({ canonicalName: "Bryan Partner" }).returning().get();
      db.insert(teamMemberships).values({ playerId: partner.id, teamId: fixture.homeTeamId, eventId: fixture.eventId }).run();

      addCaptainNote(db, { playerId: fixture.playerId, text: "solo note" });
      addCaptainNote(db, { playerId: fixture.playerId, pairPlayerId: partner.id, text: "strong together" });

      const view = getCaptainNotes(db, { teamId: fixture.homeTeamId });

      // A pairing note is about the PAIR — it belongs in neither player's own list, or it reads as
      // two separate observations.
      expect(view.player.map((n) => n.note)).toEqual(["solo note"]);
      expect(view.pairing).toHaveLength(1);
      expect(view.pairing[0]).toMatchObject({
        canonicalName: fixture.playerName,
        pairCanonicalName: "Bryan Partner",
        note: "strong together",
      });
    } finally {
      sqlite.close();
    }
  });

  it("returns empty lists when nothing is recorded, rather than refusing", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);

      // The state the feature ships in until #129 runs.
      const view = getCaptainNotes(db, { teamId: fixture.homeTeamId });

      expect(view.player).toEqual([]);
      expect(view.pairing).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("excludes a note about a player on another team", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      addCaptainNote(db, { playerId: fixture.playerId, text: "ours" });

      // A note that exists in the table but belongs to a roster this dossier is not about. Written
      // directly because `addCaptainNote` correctly refuses a non-home player — the row shape is
      // still reachable via an earlier home-team designation, so the READ must scope too.
      const otherTeam = db.insert(teams).values({ name: "OK/Dickason/40&over3.5M" }).returning().get();
      const stranger = db.insert(players).values({ canonicalName: "Not Ours" }).returning().get();
      db.insert(teamMemberships).values({ playerId: stranger.id, teamId: otherTeam.id }).run();
      db.insert(captainNotes)
        .values({ playerId: stranger.id, pairPlayerId: null, note: "theirs", createdAt: "2026-08-09T00:00:00.000Z" })
        .run();

      const view = getCaptainNotes(db, { teamId: fixture.homeTeamId });

      expect(view.player.map((n) => n.note)).toEqual(["ours"]);
    } finally {
      sqlite.close();
    }
  });

  it("omits notes about a soft-retired roster member", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedHomeTeamFixture(db);
      addCaptainNote(db, { playerId: fixture.playerId, text: "was ours" });

      // Issue #49, same rule the availability read follows: retired is not on the CURRENT roster,
      // and `addCaptainNote` would now refuse for this player.
      db.update(teamMemberships)
        .set({ retiredAt: "2026-08-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, fixture.playerId))
        .run();

      const view = getCaptainNotes(db, { teamId: fixture.homeTeamId });

      expect(view.player).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
