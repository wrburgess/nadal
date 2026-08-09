import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { evidenceWindow, windowSnapshot } from "../src/cli/window.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import {
  availability,
  captainNotes,
  courtMatchPlayers,
  courtMatches,
  events,
  players,
  playerAliases,
  ratingObservations,
  teamMemberships,
  teams,
} from "../src/db/schema.js";
import { setEventRoster } from "../src/ingest/roster-set.js";
import { getPlayerProfile, resolvePlayerTarget } from "../src/query/player-profile.js";
import { seedTeamWithRosters } from "./helpers/roster.js";
import { useTnDbPath } from "./helpers/tn-db.js";

/** #122 round-1 Finding 1: `getPlayerProfile` takes a `window` (an `EvidenceWindowDisclosure`), not
 * a bare `since` — constructed via `windowSnapshot(evidenceWindow(anchorDay))`, never a hand-assembled
 * triple. `anchorDay` is one year after the fixture's intended `since` bound (the textual 12-month
 * subtraction this module documents in `src/cli/window.ts`), so each existing fixture's `since` value
 * is preserved exactly. */
function windowSince(anchorDay: string) {
  return windowSnapshot(evidenceWindow(anchorDay));
}

type Db = ReturnType<typeof openDb>["db"];

function freshDb() {
  runMigrations();
  return openDb();
}

function seedPlayer(db: Db, values: Partial<typeof players.$inferInsert> & { canonicalName: string }) {
  return db.insert(players).values({ nameKey: nameKey(values.canonicalName), ...values }).returning().get();
}

function seedCourtMatch(
  db: Db,
  values: Partial<typeof courtMatches.$inferInsert> & { slot: string; discipline: string },
  participants: { playerId: number; side: "home" | "visiting" }[],
) {
  const row = db.insert(courtMatches).values({ winnerSide: null, playedOn: null, ...values }).returning().get();
  for (const p of participants) {
    db.insert(courtMatchPlayers).values({ courtMatchId: row.id, playerId: p.playerId, side: p.side }).run();
  }
  return row;
}

describe("getPlayerProfile", () => {
  useTnDbPath();

  // #122 round 2 (Codex fix-verification): the disclosure triple is VALIDATED at entry, not
  // trusted — a hand-assembled triple whose `since` does not derive from its `anchorDay` must
  // refuse, because the profile would otherwise filter by one bound while disclosing another
  // (the reviewer's exact trace: all history admitted, page claims a 12-month window).
  it("refuses a window disclosure whose fields do not derive from their own anchorDay", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Nova Norbury" });
      expect(() =>
        getPlayerProfile(db, player.id, {
          window: { anchorDay: "2026-08-28", since: "0000-01-01", label: "12mo to 2026-08-28" },
        }),
      ).toThrow(/inconsistent evidence window disclosure/i);
    } finally {
      sqlite.close();
    }
  });

  it("full data across all four rating sources renders every section", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Nova Norbury" });
      const opponent = seedPlayer(db, { canonicalName: "Rowan Rushworth" });
      const partner = seedPlayer(db, { canonicalName: "Kai Kestrel" });
      const team = db.insert(teams).values({ name: "Team A" }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();

      db.insert(ratingObservations)
        .values([
          { playerId: player.id, source: "ntrp", value: 4.0, ratingType: "C", observedOn: "2026-01-01" },
          { playerId: player.id, source: "wtn_singles", value: 21.5, observedOn: "2026-01-01" },
          { playerId: player.id, source: "wtn_doubles", value: 19.2, observedOn: "2026-01-01" },
          { playerId: player.id, source: "tr_dynamic", value: 4.1, observedOn: "2026-06-01" },
        ])
        .run();

      // Singles win inside the window.
      seedCourtMatch(
        db,
        { slot: "S1", discipline: "singles", winnerSide: "home", playedOn: "2026-06-10" },
        [{ playerId: player.id, side: "home" }, { playerId: opponent.id, side: "visiting" }],
      );
      // Doubles loss inside the window, with a partner.
      seedCourtMatch(
        db,
        { slot: "D1", discipline: "doubles", winnerSide: "visiting", playedOn: "2026-06-11" },
        [
          { playerId: player.id, side: "home" },
          { playerId: partner.id, side: "home" },
          { playerId: opponent.id, side: "visiting" },
        ],
      );

      const profile = getPlayerProfile(db, player.id, { window: windowSince("2027-06-01") });

      expect(profile.identity.canonicalName).toBe("Nova Norbury");
      expect(profile.ratingTrajectory).toHaveLength(4);
      const bySource = new Map(profile.ratingTrajectory.map((r) => [r.source, r]));
      expect(bySource.get("ntrp")!.latest.ratingType).toBe("C");
      expect(bySource.get("tr_dynamic")!.latest.value).toBe(4.1);

      expect(profile.singlesRecord.windowed).toEqual({ wins: 1, losses: 0, undecided: 0, excludedUndated: 0 });
      expect(profile.doublesRecord.windowed).toEqual({ wins: 0, losses: 1, undecided: 0, excludedUndated: 0 });
      expect(profile.slotTendencies).toEqual(
        expect.arrayContaining([{ slot: "S1", count: 1 }, { slot: "D1", count: 1 }]),
      );
      expect(profile.partnerFrequency).toEqual([{ partnerId: partner.id, count: 1, canonicalName: "Kai Kestrel" }]);
      expect(profile.teamMemberships).toEqual([
        { teamId: team.id, teamName: "Team A", eventId: null, retiredAt: null },
      ]);
    } finally {
      sqlite.close();
    }
  });

  // Issue #122, Task 3: the defect this whole issue records as "the second failure" — the window
  // reached `singlesRecord`/`doublesRecord` but not `slotTendencies`/`partnerFrequency`, so a
  // player's block could print a windowed "0-0" beside tendencies drawn from matches entirely
  // outside it. Both are now filtered through the SAME `since` boundary as the records beside them.
  it("slotTendencies and partnerFrequency count only in-window rows, the same boundary singlesRecord/doublesRecord use", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Anthony Richardson" });
      const partnerInWindow = seedPlayer(db, { canonicalName: "In Window Partner" });
      const partnerOutOfWindow = seedPlayer(db, { canonicalName: "Out Of Window Partner" });
      const opponent = seedPlayer(db, { canonicalName: "Some Opponent" });

      // Two matches BEFORE `since`: real evidence, but outside the window — must not reach
      // tendencies or partner counts, exactly as they already do not reach the record.
      seedCourtMatch(
        db,
        { slot: "D3", discipline: "doubles", winnerSide: "home", playedOn: "2025-09-02" },
        [
          { playerId: player.id, side: "home" },
          { playerId: partnerOutOfWindow.id, side: "home" },
          { playerId: opponent.id, side: "visiting" },
        ],
      );
      seedCourtMatch(
        db,
        { slot: "D4", discipline: "doubles", winnerSide: "home", playedOn: "2025-10-01" },
        [
          { playerId: player.id, side: "home" },
          { playerId: partnerOutOfWindow.id, side: "home" },
          { playerId: opponent.id, side: "visiting" },
        ],
      );
      // One match ON `since` (inclusive) and one AFTER it — both in-window.
      seedCourtMatch(
        db,
        { slot: "S1", discipline: "singles", winnerSide: "home", playedOn: "2026-06-01" },
        [{ playerId: player.id, side: "home" }, { playerId: opponent.id, side: "visiting" }],
      );
      seedCourtMatch(
        db,
        { slot: "D1", discipline: "doubles", winnerSide: "home", playedOn: "2026-06-15" },
        [
          { playerId: player.id, side: "home" },
          { playerId: partnerInWindow.id, side: "home" },
          { playerId: opponent.id, side: "visiting" },
        ],
      );

      const profile = getPlayerProfile(db, player.id, { window: windowSince("2027-06-01") });

      // Two in-window matches, D3/D4 excluded entirely.
      expect(profile.slotTendencies).toEqual(
        expect.arrayContaining([{ slot: "S1", count: 1 }, { slot: "D1", count: 1 }]),
      );
      expect(profile.slotTendencies).toHaveLength(2);
      expect(profile.slotTendencies.find((s) => s.slot === "D3" || s.slot === "D4")).toBeUndefined();

      // Only the in-window partner counts — the out-of-window partner (2 shared matches) is
      // invisible here even though those matches are real and on file.
      expect(profile.partnerFrequency).toEqual([
        { partnerId: partnerInWindow.id, count: 1, canonicalName: "In Window Partner" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  // Issue #49: "teams this player has been on" is a legitimately HISTORICAL statement — a retired
  // membership must still be LISTED here (never filtered, unlike the current-roster reads in
  // team-profile.ts/lineup.ts/availability.ts/captain-notes.ts), carrying its `retiredAt` so a
  // presenter can label it distinctly (`tn player show`'s "(former)" suffix).
  it("teamMemberships still lists a retired team, carrying retiredAt — history is preserved, not hidden", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Departed Player" });
      const team = db.insert(teams).values({ name: "Former Team" }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, player.id))
        .run();

      const profile = getPlayerProfile(db, player.id, { window: windowSince("2027-01-01") });

      expect(profile.teamMemberships).toEqual([
        { teamId: team.id, teamName: "Former Team", eventId: null, retiredAt: "2026-07-01T00:00:00.000Z" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  // The sharp edge of "retired ≠ deleted": a player's own court-match history and partner
  // frequencies must be untouched by a retirement — `court_match_players` is a separate table this
  // change never reads or writes.
  it("court-match history and partner frequency are unchanged by a retirement", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Departed Player" });
      const partner = seedPlayer(db, { canonicalName: "Steady Partner" });
      const opponent = seedPlayer(db, { canonicalName: "Some Opponent" });
      const team = db.insert(teams).values({ name: "Former Team" }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
      seedCourtMatch(
        db,
        { slot: "D1", discipline: "doubles", winnerSide: "home", playedOn: "2026-06-01" },
        [
          { playerId: player.id, side: "home" },
          { playerId: partner.id, side: "home" },
          { playerId: opponent.id, side: "visiting" },
        ],
      );

      const before = getPlayerProfile(db, player.id, { window: windowSince("2027-01-01") });

      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, player.id))
        .run();

      const after = getPlayerProfile(db, player.id, { window: windowSince("2027-01-01") });
      expect(after.doublesRecord).toEqual(before.doublesRecord);
      expect(after.partnerFrequency).toEqual(before.partnerFrequency);
      expect(after.partnerFrequency).toEqual([{ partnerId: partner.id, count: 1, canonicalName: "Steady Partner" }]);
    } finally {
      sqlite.close();
    }
  });

  it("TennisRecord-only (realistic pre-login state): WTN/NTRP sections report absent, not zero", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Ira Inglewood" });
      db.insert(ratingObservations)
        .values({ playerId: player.id, source: "tr_dynamic", value: 3.8, observedOn: "2026-01-01" })
        .run();

      const profile = getPlayerProfile(db, player.id, { window: windowSince("2027-01-01") });

      expect(profile.ratingTrajectory).toHaveLength(1);
      expect(profile.ratingTrajectory[0]!.source).toBe("tr_dynamic");
      expect(profile.ratingTrajectory.find((r) => r.source === "ntrp")).toBeUndefined();
      expect(profile.ratingTrajectory.find((r) => r.source === "wtn_singles")).toBeUndefined();
      expect(profile.ratingTrajectory.find((r) => r.source === "wtn_doubles")).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("a player with no match history: zero records, no crash, every section present", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Blake Bramwell" });

      const profile = getPlayerProfile(db, player.id, { window: windowSince("2027-01-01") });

      expect(profile.singlesRecord.allTime).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 0 });
      expect(profile.doublesRecord.allTime).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 0 });
      expect(profile.slotTendencies).toEqual([]);
      expect(profile.partnerFrequency).toEqual([]);
      expect(profile.ratingTrajectory).toEqual([]);
      expect(profile.teamMemberships).toEqual([]);
      // dataGaps still reports even with nothing else on file. All three sections now have writers
      // (#113 gave `events` one — `tn roster set` — joining `availability`/`captainNotes` from #17
      // PR A), so a player with nothing on file reads as "empty" everywhere, never "not-collected".
      expect(profile.dataGaps.events).toBe("empty");
      expect(profile.dataGaps.availability).toBe("empty");
      expect(profile.dataGaps.captainNotes).toBe("empty");
    } finally {
      sqlite.close();
    }
  });

  it("dataGaps reports all three sections as empty (never not-collected) once every section has a writer (#113)", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Casey Calder" });
      const profile = getPlayerProfile(db, player.id, { window: windowSince("2027-01-01") });
      expect(profile.dataGaps).toEqual({
        events: "empty",
        availability: "empty",
        captainNotes: "empty",
      });
    } finally {
      sqlite.close();
    }
  });

  // The defect this guards against (docs/findings.md's "silent-lie risk"): `hasWriter: false`
  // hardcoded for availability/captainNotes would keep reporting "not collected yet" even once
  // Tasks 3-4 gave both sections real writers and real data sits in the table — reading as correct
  // while being false. `count === 0` alone cannot distinguish "no writer" from "writer, zero rows"
  // (that is the whole point of `hasWriter`), so this has to observe ACTUAL rows landing.
  it("dataGaps reports has-data for availability/captainNotes once real rows exist for this player (regression: hasWriter must not stay hardcoded false)", () => {
    const { db, sqlite } = freshDb();
    try {
      const home = db.insert(teams).values({ name: "Home Team" }).returning().get();
      db.update(teams).set({ isHome: true }).where(eq(teams.id, home.id)).run();
      const event = db
        .insert(events)
        .values({ name: "Event", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
        .returning()
        .get();
      const player = seedPlayer(db, { canonicalName: "Devon Dataworthy" });
      db.insert(teamMemberships).values({ playerId: player.id, teamId: home.id, eventId: event.id }).run();
      db.insert(availability)
        .values({ playerId: player.id, eventId: event.id, day: "2026-08-29", status: "available" })
        .run();
      db.insert(captainNotes)
        .values({ playerId: player.id, note: "Serves big.", createdAt: new Date().toISOString() })
        .run();

      const profile = getPlayerProfile(db, player.id, { window: windowSince("2027-01-01") });
      expect(profile.dataGaps.availability).toBe("has-data");
      expect(profile.dataGaps.captainNotes).toBe("has-data");
      // #113: `tn roster set` is now a real production writer for an event-scoped membership, so a
      // real row here (however it was inserted) reads as "has-data" too — the count is a genuine
      // query, not a literal. The dedicated end-to-end test below drives this through the ACTUAL
      // `setEventRoster` writer rather than a hand insert, which is what proves the production path
      // reaches this flag (never hand-insert the state a test is asserting is reachable).
      expect(profile.dataGaps.events).toBe("has-data");
    } finally {
      sqlite.close();
    }
  });

  // #113: `tn team pull` still writes `event_id: null` at both its call sites (a season/league
  // roster pull, never an event registration), so this remains the common case for most players —
  // but `events` now HAS a writer (`tn roster set`), so a player with zero event-scoped rows reads
  // as "empty" (a writer exists; nothing recorded for THIS player), never "not-collected".
  it("dataGaps reports events as empty (not not-collected) for a player whose only membership is season-scoped", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = db.insert(teams).values({ name: "Some Team" }).returning().get();
      db.insert(events)
        .values({ name: "Event", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
        .run();
      const player = seedPlayer(db, { canonicalName: "Elin Eventless" });
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();

      const profile = getPlayerProfile(db, player.id, { window: windowSince("2027-01-01") });
      expect(profile.dataGaps.events).toBe("empty");
    } finally {
      sqlite.close();
    }
  });

  // Task 8 (#113): the end-to-end proof — driven through the REAL `setEventRoster` writer
  // (`tn roster set`'s own service), never a hand-inserted row, per the standing rule that the
  // `hasWriter`/count assertion must run through the production path. `docs/findings.md:255`
  // records the exact defect a hand-inserted-state test would have hidden: flipping `hasWriter` to
  // `true` while leaving `count` a stale literal.
  it("end-to-end: tn roster set makes a registered player's events section has-data with a REAL count; an unregistered player stays empty", () => {
    const { db, sqlite } = freshDb();
    try {
      const fixture = seedTeamWithRosters(db, {
        teamName: "OK/Dickason/40&over3.5M",
        season: ["Registered Rey", "Unregistered Uma"],
      });
      db.insert(events).values({ name: "Springfield Sectionals 2026", kind: "tournament" }).returning().get();

      const result = setEventRoster(db, {
        team: "OK/Dickason/40&over3.5M",
        event: "Springfield Sectionals 2026",
        players: ["Registered Rey"],
      });
      expect(result.ok).toBe(true);

      const reyId = fixture.seasonPlayerIds.get("Registered Rey")!;
      const umaId = fixture.seasonPlayerIds.get("Unregistered Uma")!;

      const reyProfile = getPlayerProfile(db, reyId, { window: windowSince("2027-01-01") });
      expect(reyProfile.dataGaps.events).toBe("has-data");

      const umaProfile = getPlayerProfile(db, umaId, { window: windowSince("2027-01-01") });
      expect(umaProfile.dataGaps.events).toBe("empty");
    } finally {
      sqlite.close();
    }
  });
});

describe("resolvePlayerTarget", () => {
  useTnDbPath();

  it("resolves a bare canonical name", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Yuma Yarrowby" });
      const result = resolvePlayerTarget(db, "Yuma Yarrowby");
      expect(result).toEqual({ kind: "ok", playerId: player.id });
    } finally {
      sqlite.close();
    }
  });

  it("resolves a usta: prefixed target by usta_uaid", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Hollis Hartwell", ustaUaid: "UAID-1" });
      const result = resolvePlayerTarget(db, "usta:UAID-1");
      expect(result).toEqual({ kind: "ok", playerId: player.id });
    } finally {
      sqlite.close();
    }
  });

  it("resolves a wtn: prefixed target by wtn_tennis_id", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Delaney Duxbury", wtnTennisId: "WTN-1" });
      const result = resolvePlayerTarget(db, "wtn:WTN-1");
      expect(result).toEqual({ kind: "ok", playerId: player.id });
    } finally {
      sqlite.close();
    }
  });

  it("resolves a tr: prefixed target by tennisrecord_url", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, {
        canonicalName: "Juniper Jarrow",
        tennisrecordUrl: "https://tennisrecord.com/profile.aspx?playername=Juniper%20Jarrow",
      });
      const result = resolvePlayerTarget(db, "tr:https://tennisrecord.com/profile.aspx?playername=Juniper%20Jarrow");
      expect(result).toEqual({ kind: "ok", playerId: player.id });
    } finally {
      sqlite.close();
    }
  });

  it("an unknown usta:/wtn:/tr: prefixed target is not-found", () => {
    const { db, sqlite } = freshDb();
    try {
      expect(resolvePlayerTarget(db, "usta:no-such-uaid")).toEqual({ kind: "not-found" });
      expect(resolvePlayerTarget(db, "wtn:no-such-id")).toEqual({ kind: "not-found" });
      expect(resolvePlayerTarget(db, "tr:https://nope")).toEqual({ kind: "not-found" });
    } finally {
      sqlite.close();
    }
  });

  it("an exact alias collision (two distinct players share the same alias spelling) is ambiguous, not a silent pick", () => {
    const { db, sqlite } = freshDb();
    try {
      const first = seedPlayer(db, { canonicalName: "Marek Melbourne" });
      const second = seedPlayer(db, { canonicalName: "Orin Oakhurst" });
      // Both players independently picked up the same alias spelling — e.g. two rosters each
      // recording a shared nickname. The exact tier must not guess which one "Nickname" means.
      db.insert(playerAliases).values([
        { playerId: first.id, alias: "Nickname", nameKey: nameKey("Nickname") },
        { playerId: second.id, alias: "Nickname", nameKey: nameKey("Nickname") },
      ]).run();

      const result = resolvePlayerTarget(db, "Nickname");
      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.candidates.sort()).toEqual(["Marek Melbourne", "Orin Oakhurst"]);
      }
      // Never creates or modifies anything while resolving.
      expect(db.select().from(players).all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("an alias-only spelling resolves to the SAME profile as the canonical name — the Unicode case-folding path (#15)", () => {
    const { db, sqlite } = freshDb();
    try {
      // Player was originally pulled under an accented canonical spelling; an alias captures a
      // different casing of the SAME accented characters — the exact shape #15 fixed (SQLite's
      // `lower()` is ASCII-only; JS's `toLowerCase()` is Unicode-aware).
      const player = seedPlayer(db, { canonicalName: "Élodie Fontaine" });
      db.insert(playerAliases)
        .values({ playerId: player.id, alias: "ÉLODIE FONTAINE", nameKey: nameKey("ÉLODIE FONTAINE") })
        .run();

      const byAlias = resolvePlayerTarget(db, "élodie fontaine");
      const byCanonical = resolvePlayerTarget(db, "Élodie Fontaine");
      expect(byAlias).toEqual({ kind: "ok", playerId: player.id });
      expect(byAlias).toEqual(byCanonical);

      const profileByAlias = getPlayerProfile(db, (byAlias as { kind: "ok"; playerId: number }).playerId, {
        window: windowSince("2027-01-01"),
      });
      expect(profileByAlias.identity.canonicalName).toBe("Élodie Fontaine");
    } finally {
      sqlite.close();
    }
  });

  it("an unknown target is not-found, not an error and not a create", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = resolvePlayerTarget(db, "Nobody Atall");
      expect(result).toEqual({ kind: "not-found" });
      expect(db.select().from(players).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("an ambiguous fuzzy name lists every candidate", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(players)
        .values([
          { canonicalName: "Alex Stone", nameKey: nameKey("Alex Stone") },
          { canonicalName: "Alex Stove", nameKey: nameKey("Alex Stove") },
        ])
        .run();
      const result = resolvePlayerTarget(db, "Alex Ston");
      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.candidates.sort()).toEqual(["Alex Stone", "Alex Stove"]);
      }
    } finally {
      sqlite.close();
    }
  });
});
