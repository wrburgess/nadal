// Issue #133 (the in-event scorecard dry run): the ONE behavioural claim the corrected runbook
// makes that nothing pinned end to end.
//
// The dry run measured it on the real database — a screenshot-ingested tie dated one day before the
// event's 12-month `since` bound moved every "prior meetings" row in the opponent dossier and moved
// NOTHING in the records or court-slot tendencies printed above them. That split is deliberate
// (`getTeamProfile`: `headToHead` reads the unwindowed `courtRows`, records and tendencies read
// `window.since`/`windowedCourtRows`), and `docs/runbooks/in-event-screenshot-ingest.md` now tells an
// operator to expect it at a venue. Existing coverage stops short of the join: `report-markdown.test.ts`
// pins the "(all meetings on file)" HEADING and the disclosure SENTENCE over a hand-built dossier, and
// `evidence-window.test.ts`/`cli-window.test.ts` pin the 12-month derivation — neither runs a real
// query in which one court match lands on one side of the boundary and is then checked in all three
// sections at once.
//
// The fixture deliberately leaves `leagueContext` NULL, which is exactly what `tn match add` writes
// (the scorecard payload carries no league field): `leagueScopeRetains(null, scope)` returns true, so
// the row's presence or absence below is decided by the WINDOW and by nothing else.

import { describe, expect, it } from "vitest";
import { evidenceWindow, windowSnapshot } from "../src/cli/window.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { courtMatchPlayers, courtMatches, players, teamMemberships, teams } from "../src/db/schema.js";
import { getTeamProfile } from "../src/query/team-profile.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

/** The event anchor Springfield actually uses, so `since` below is the real bound the binder prints. */
const ANCHOR_DAY = "2026-08-28";
/** `twelveMonthsBefore(ANCHOR_DAY)` — asserted rather than assumed, in the first test. */
const SINCE = "2025-08-28";
/** One day before the inclusive lower bound. */
const DAY_BEFORE_SINCE = "2025-08-27";

function freshDb() {
  runMigrations();
  return openDb();
}

function seedPlayer(db: Db, canonicalName: string) {
  return db.insert(players).values({ canonicalName, nameKey: nameKey(canonicalName) }).returning().get();
}

function seedTeam(db: Db, name: string) {
  return db.insert(teams).values({ name, nameKey: nameKey(name) }).returning().get();
}

/**
 * One singles court on `playedOn`, won by the OPPONENT (`side: "home"`) against one of our players.
 * `leagueContext` is left NULL on purpose — see this file's header.
 */
function seedMeeting(db: Db, playedOn: string, opponentId: number, ourPlayerId: number) {
  const court = db
    .insert(courtMatches)
    .values({ slot: "S1", discipline: "singles", winnerSide: "home", score: "6-3 6-4", playedOn })
    .returning()
    .get();
  db.insert(courtMatchPlayers).values({ courtMatchId: court.id, playerId: opponentId, side: "home" }).run();
  db.insert(courtMatchPlayers).values({ courtMatchId: court.id, playerId: ourPlayerId, side: "visiting" }).run();
  return court;
}

/** The opponent dossier `tn report build` renders: their roster, our roster as `versusTeamId`. */
function opponentDossier(db: Db, playedOn: string) {
  const ourTeam = seedTeam(db, "HOA/Ours/40&over3.5M");
  const theirTeam = seedTeam(db, "IA/Theirs/40&Over3.5M");
  const ourPlayer = seedPlayer(db, "Our Player");
  const theirPlayer = seedPlayer(db, "Their Player");
  db.insert(teamMemberships).values({ playerId: ourPlayer.id, teamId: ourTeam.id, eventId: null }).run();
  db.insert(teamMemberships).values({ playerId: theirPlayer.id, teamId: theirTeam.id, eventId: null }).run();

  seedMeeting(db, playedOn, theirPlayer.id, ourPlayer.id);

  const profile = getTeamProfile(db, theirTeam.id, {
    window: windowSnapshot(evidenceWindow(ANCHOR_DAY)),
    versusTeamId: ourTeam.id,
  });
  const member = profile.roster.find((r) => r.playerId === theirPlayer.id);
  if (member === undefined) throw new Error("fixture error: the opponent's own roster member is missing");
  const meeting = profile.headToHead?.find((h) => h.playerId === theirPlayer.id);
  return { profile, member, meeting };
}

describe("a court match's window position decides records and tendencies, never prior meetings", () => {
  useTnDbPath();

  it("derives the Springfield bound this file's fixtures are built around", () => {
    // Pinned so a change to the 12-month derivation reddens HERE, naming the reason, rather than
    // silently turning both cases below into the same case.
    expect(windowSnapshot(evidenceWindow(ANCHOR_DAY)).since).toBe(SINCE);
    expect(DAY_BEFORE_SINCE < SINCE).toBe(true);
  });

  it("counts a court match dated exactly on `since` in all three sections (the bound is inclusive)", () => {
    const { db, sqlite } = freshDb();
    try {
      const { member, meeting } = opponentDossier(db, SINCE);

      expect(member.singlesRecord.wins).toBe(1);
      expect(member.slotTendencies).toEqual([{ slot: "S1", count: 1 }]);
      expect(meeting?.matches).toBe(1);
      expect(meeting?.wins).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("drops the SAME court match from records and tendencies one day earlier, and keeps it in prior meetings", () => {
    const { db, sqlite } = freshDb();
    try {
      const { member, meeting } = opponentDossier(db, DAY_BEFORE_SINCE);

      // Out of the window: the two sections that disclose it.
      expect(member.singlesRecord.wins).toBe(0);
      expect(member.singlesRecord.losses).toBe(0);
      expect(member.slotTendencies).toEqual([]);

      // Still on file: the section whose own heading says "all meetings on file". This is the
      // assertion that would break if `headToHead` were ever windowed alongside its neighbours —
      // the runbook tells an operator a Friday ingest of an OLD card still shows up here.
      expect(meeting?.matches).toBe(1);
      expect(meeting?.wins).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
