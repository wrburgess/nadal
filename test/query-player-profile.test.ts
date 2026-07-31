import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
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
import { getPlayerProfile, resolvePlayerTarget } from "../src/query/player-profile.js";
import { useTnDbPath } from "./helpers/tn-db.js";

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

      const profile = getPlayerProfile(db, player.id, { since: "2026-06-01" });

      expect(profile.identity.canonicalName).toBe("Nova Norbury");
      expect(profile.ratingTrajectory).toHaveLength(4);
      const bySource = new Map(profile.ratingTrajectory.map((r) => [r.source, r]));
      expect(bySource.get("ntrp")!.latest.ratingType).toBe("C");
      expect(bySource.get("tr_dynamic")!.latest.value).toBe(4.1);

      expect(profile.singlesRecord.sixMonth).toEqual({ wins: 1, losses: 0, undecided: 0, excludedUndated: 0 });
      expect(profile.doublesRecord.sixMonth).toEqual({ wins: 0, losses: 1, undecided: 0, excludedUndated: 0 });
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

      const profile = getPlayerProfile(db, player.id, { since: "2026-01-01" });

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

      const before = getPlayerProfile(db, player.id, { since: "2026-01-01" });

      db.update(teamMemberships)
        .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
        .where(eq(teamMemberships.playerId, player.id))
        .run();

      const after = getPlayerProfile(db, player.id, { since: "2026-01-01" });
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

      const profile = getPlayerProfile(db, player.id, { since: "2026-01-01" });

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

      const profile = getPlayerProfile(db, player.id, { since: "2026-01-01" });

      expect(profile.singlesRecord.allTime).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 0 });
      expect(profile.doublesRecord.allTime).toEqual({ wins: 0, losses: 0, undecided: 0, excludedUndated: 0 });
      expect(profile.slotTendencies).toEqual([]);
      expect(profile.partnerFrequency).toEqual([]);
      expect(profile.ratingTrajectory).toEqual([]);
      expect(profile.teamMemberships).toEqual([]);
      // dataGaps still reports even with nothing else on file. `availability`/`captainNotes` have
      // writers (#17 PR A), so an empty table for THIS player reads as "empty". `events` does NOT:
      // #17 PR B's `addEvent` writes the events table, but nothing writes the event-scoped
      // `team_memberships` row that would associate a PLAYER with an event, so the section is
      // genuinely not collected. Both directions of that distinction are the silent-lie risk
      // docs/findings.md records.
      expect(profile.dataGaps.events).toBe("not-collected");
      expect(profile.dataGaps.availability).toBe("empty");
      expect(profile.dataGaps.captainNotes).toBe("empty");
    } finally {
      sqlite.close();
    }
  });

  it("dataGaps separates the two sections with writers from events, which still has no player-scoped one", () => {
    const { db, sqlite } = freshDb();
    try {
      const player = seedPlayer(db, { canonicalName: "Casey Calder" });
      const profile = getPlayerProfile(db, player.id, { since: "2026-01-01" });
      expect(profile.dataGaps).toEqual({
        events: "not-collected",
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

      const profile = getPlayerProfile(db, player.id, { since: "2026-01-01" });
      expect(profile.dataGaps.availability).toBe("has-data");
      expect(profile.dataGaps.captainNotes).toBe("has-data");
      // `events` does NOT join them, even though this fixture inserted an event-scoped membership
      // by hand: no production path writes one, so reporting anything but "not-collected" would
      // claim collection support the codebase does not have. This assertion is deliberately about
      // the CODEBASE, not about the rows this test happens to have created — the distinction the
      // review of PR #47 caught an earlier revision getting backwards.
      expect(profile.dataGaps.events).toBe("not-collected");
    } finally {
      sqlite.close();
    }
  });

  // The realistic case, and the reason `events` cannot claim a writer: a roster pulled outside an
  // event writes `event_id: null` (docs/findings.md, #15 — the normal path for every real
  // `tn team pull`), so no production player ever acquires an event association at all, however
  // many events `tn event add` has created.
  it("dataGaps reports events as not-collected for a player whose only membership is not event-scoped", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = db.insert(teams).values({ name: "Some Team" }).returning().get();
      db.insert(events)
        .values({ name: "Event", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
        .run();
      const player = seedPlayer(db, { canonicalName: "Elin Eventless" });
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();

      const profile = getPlayerProfile(db, player.id, { since: "2026-01-01" });
      expect(profile.dataGaps.events).toBe("not-collected");
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
        since: "2026-01-01",
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
