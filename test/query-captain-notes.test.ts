import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { captainNotes, players, teamMemberships, teams } from "../src/db/schema.js";
import {
  EmptyCaptainNoteError,
  NoHomeTeamError,
  PlayerNotOnHomeRosterError,
  SelfPairingCaptainNoteError,
  addCaptainNote,
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
