import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { playerAliases, players, teamMemberships, teams } from "../src/db/schema.js";
import { resolvePlayer, resolveRosterPlayer, resolveTeam } from "../src/ingest/identity.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("resolvePlayer", () => {
  useTnDbPath();

  function freshDb() {
    runMigrations();
    return openDb();
  }

  it("tier 1: matches by usta_uaid, ignoring the given name", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(players).values({ canonicalName: "Jane Doe", ustaUaid: "12345" }).run();
      const result = resolvePlayer(db, { ustaUaid: "12345", name: "Some Other Spelling" });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.canonicalName).toBe("Jane Doe");
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("tier 1: matches by tennisrecord_url", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(players)
        .values({ canonicalName: "Nova Norbury", tennisrecordUrl: "https://tr/profile?a" })
        .run();
      const result = resolvePlayer(db, {
        tennisrecordUrl: "https://tr/profile?a",
        name: "Different Name",
      });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.canonicalName).toBe("Nova Norbury");
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("tier 2: matches via player_aliases, case-insensitively", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(players).values({ canonicalName: "Jane Doe", nameKey: nameKey("Jane Doe") }).run();
      const seeded = db.select().from(players).all()[0]!;
      db.insert(playerAliases).values({ playerId: seeded.id, alias: "JD", nameKey: nameKey("JD") }).run();

      const result = resolvePlayer(db, { name: "jd" });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.id).toBe(seeded.id);
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("tier 3: two near-identical stored names resolve as ambiguous with BOTH candidates, and creates/modifies nothing", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(players)
        .values([
          { canonicalName: "Alex Stone", nameKey: nameKey("Alex Stone") },
          { canonicalName: "Alex Stove", nameKey: nameKey("Alex Stove") },
        ])
        .run();
      const before = db.select().from(players).all();

      // "Alex Ston" is one edit from "Alex Stone" (insert "e") and two edits from "Alex Stove"
      // (substitute "n"->"v", insert "e") — both within the fuzzy radius, neither an exact match.
      const result = resolvePlayer(db, { name: "Alex Ston" });

      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.candidates.map((c) => c.canonicalName).sort()).toEqual([
          "Alex Stone",
          "Alex Stove",
        ]);
      }
      expect(db.select().from(players).all()).toEqual(before);
      expect(db.select().from(playerAliases).all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("brand-new name: creates exactly one player, canonical_name preserving the page's own spelling", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = resolvePlayer(db, { name: "EMORY ELLERBY" });

      expect(result.kind).toBe("created");
      if (result.kind === "created") expect(result.row.canonicalName).toBe("EMORY ELLERBY");

      const rows = db.select().from(players).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.canonicalName).toBe("EMORY ELLERBY");
    } finally {
      sqlite.close();
    }
  });

  it("EDGE: the same name appearing twice on one roster resolves to one player, not two", () => {
    const { db, sqlite } = freshDb();
    try {
      const first = resolvePlayer(db, { name: "Ellis Eastwick" });
      const second = resolvePlayer(db, { name: "Ellis Eastwick" });

      expect(first.kind).toBe("created");
      expect(second.kind).toBe("matched");
      if (first.kind === "created" && second.kind === "matched") {
        expect(second.row.id).toBe(first.row.id);
      }
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});

describe("resolveTeam", () => {
  useTnDbPath();

  function freshDb() {
    runMigrations();
    return openDb();
  }

  it("tier 1: matches by tennisrecord_url", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(teams).values({ name: "Norbury, Nova", tennisrecordUrl: "https://tr/team?a" }).run();
      const result = resolveTeam(db, { tennisrecordUrl: "https://tr/team?a", name: "Different" });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.name).toBe("Norbury, Nova");
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("matches an existing team by exact case-insensitive name", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(teams).values({ name: "Norbury, Nova", nameKey: nameKey("Norbury, Nova") }).run();
      const result = resolveTeam(db, { name: "norbury, nova" });

      expect(result.kind).toBe("matched");
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("creates exactly one team for a brand-new name, preserving spelling", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = resolveTeam(db, { name: "Granborough, Galen" });

      expect(result.kind).toBe("created");
      if (result.kind === "created") expect(result.row.name).toBe("Granborough, Galen");
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});

// Codex adversarial review, PR #31 [medium]: tier 2 folded case in SQLite (`lower()`, ASCII-only)
// while the canonical-name half of the SAME tier folded in JS (Unicode). One identity ladder cannot
// run two different notions of "the same name" — the gap creates a SECOND row for someone on file.
describe("identity ladder — Unicode case folding", () => {
  useTnDbPath();

  it("REGRESSION: a non-ASCII alias resolves case-insensitively instead of creating a split identity", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const created = resolvePlayer(db, { name: "Jane Smith" });
      if (created.kind === "ambiguous") throw new Error("unexpected ambiguous");
      db.insert(playerAliases)
        .values({ playerId: created.row.id, alias: "Élodie Ünwin", nameKey: nameKey("Élodie Ünwin") })
        .run();

      const resolved = resolvePlayer(db, { name: "élodie ünwin" });

      expect(resolved.kind).toBe("matched");
      if (resolved.kind === "matched") expect(resolved.row.id).toBe(created.row.id);
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});

// Task 2, #18: a NEVER-CREATE, roster-scoped ladder for names extracted from a scorecard photo.
// Unlike `resolvePlayer` (the scraping paths, which create on a miss), a miss here is `unresolved`
// — "flag, never guess" (spec § Ingestion) has no room for a misread name silently growing `players`.
describe("resolveRosterPlayer", () => {
  useTnDbPath();

  function freshDb() {
    runMigrations();
    return openDb();
  }

  function seedTeam(db: ReturnType<typeof openDb>["db"], name: string) {
    db.insert(teams).values({ name, nameKey: nameKey(name) }).run();
    return db.select().from(teams).all().find((t) => t.name === name)!;
  }

  function seedPlayer(db: ReturnType<typeof openDb>["db"], name: string) {
    db.insert(players).values({ canonicalName: name, nameKey: nameKey(name) }).run();
    return db.select().from(players).all().find((p) => p.canonicalName === name)!;
  }

  it("matches an exact roster name", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const player = seedPlayer(db, "Ada Ashby");
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();

      const result = resolveRosterPlayer(db, { name: "Ada Ashby", teamId: team.id });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.id).toBe(player.id);
    } finally {
      sqlite.close();
    }
  });

  it("matches an alias on the roster, case-insensitively", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const player = seedPlayer(db, "Ada Ashby");
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
      db.insert(playerAliases).values({ playerId: player.id, alias: "AA", nameKey: nameKey("AA") }).run();

      const result = resolveRosterPlayer(db, { name: "aa", teamId: team.id });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.id).toBe(player.id);
    } finally {
      sqlite.close();
    }
  });

  it("tier 3: a near-miss spelling on the roster is ambiguous, listing the candidate(s), never auto-matched", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const player = seedPlayer(db, "Alex Stone");
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();

      const result = resolveRosterPlayer(db, { name: "Alex Ston", teamId: team.id });

      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.candidates.map((c) => c.canonicalName)).toEqual(["Alex Stone"]);
      }
    } finally {
      sqlite.close();
    }
  });

  it("unresolved: a name not on any roster at all", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");

      const result = resolveRosterPlayer(db, { name: "Nobody Ontheroster", teamId: team.id });

      expect(result.kind).toBe("unresolved");
      if (result.kind === "unresolved") expect(result.candidates).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  // REGRESSION guard for the design choice itself: an unscoped lookup would find this player by
  // exact name and match — the whole point of Task 2 is that it must NOT.
  it("REGRESSION: a player who exists in `players` and is on the OPPOSING team's roster flags rather than matching", () => {
    const { db, sqlite } = freshDb();
    try {
      const homeTeam = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const otherTeam = seedTeam(db, "Report Opponent");
      const player = seedPlayer(db, "Ada Ashby");
      db.insert(teamMemberships).values({ playerId: player.id, teamId: otherTeam.id, eventId: null }).run();

      const result = resolveRosterPlayer(db, { name: "Ada Ashby", teamId: homeTeam.id });

      expect(result.kind).toBe("unresolved");
    } finally {
      sqlite.close();
    }
  });

  it("REGRESSION: a player who exists in `players` but is on NO roster at all flags rather than matching", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      seedPlayer(db, "Ada Ashby"); // no team_memberships row at all

      const result = resolveRosterPlayer(db, { name: "Ada Ashby", teamId: team.id });

      expect(result.kind).toBe("unresolved");
    } finally {
      sqlite.close();
    }
  });

  // Codex adversarial review of PR #54, High finding 1: the three prefix-ID branches returned a
  // GLOBAL player row without ever consulting `team_memberships` — so an id naming a real player on
  // some OTHER team (or no team at all) matched here regardless, defeating the roster-scoping
  // invariant this whole function exists to enforce. This is the exact "comment claims coverage the
  // code does not enforce" shape: the doc comment above already claimed "roster scoping does not
  // apply" for prefix-IDs, when the intent was only ever to let a correction override a NAME that
  // would otherwise flag — never to bypass the roster boundary entirely.
  it("REGRESSION (Codex High finding 1): a usta: prefix-ID naming a player NOT on the given team's roster is off-roster, never matched", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      // The id resolves to a real player — just not one on THIS team's roster.
      const player = seedPlayer(db, "Some Other Spelling");
      db.update(players).set({ ustaUaid: "99999" }).where(eq(players.id, player.id)).run();

      const result = resolveRosterPlayer(db, { name: "usta:99999", teamId: team.id });

      expect(result.kind).toBe("off-roster");
      if (result.kind === "off-roster") expect(result.row.id).toBe(player.id);
    } finally {
      sqlite.close();
    }
  });

  it("a usta: prefix-ID naming a player ON the given team's roster still resolves — the correction workflow keeps working", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const player = seedPlayer(db, "Some Other Spelling");
      db.update(players).set({ ustaUaid: "99999" }).where(eq(players.id, player.id)).run();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();

      const result = resolveRosterPlayer(db, { name: "usta:99999", teamId: team.id });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.id).toBe(player.id);
    } finally {
      sqlite.close();
    }
  });

  it("a wtn: prefix-ID off-roster is refused the same way as usta:", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const player = seedPlayer(db, "Some Other Spelling");
      db.update(players).set({ wtnTennisId: "wtn-42" }).where(eq(players.id, player.id)).run();

      const result = resolveRosterPlayer(db, { name: "wtn:wtn-42", teamId: team.id });

      expect(result.kind).toBe("off-roster");
    } finally {
      sqlite.close();
    }
  });

  it("a tr: prefix-ID off-roster is refused the same way as usta:", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const player = seedPlayer(db, "Some Other Spelling");
      db.update(players).set({ tennisrecordUrl: "https://tr/profile?x" }).where(eq(players.id, player.id)).run();

      const result = resolveRosterPlayer(db, { name: "tr:https://tr/profile?x", teamId: team.id });

      expect(result.kind).toBe("off-roster");
    } finally {
      sqlite.close();
    }
  });

  it("never creates: an unresolved call leaves `players` untouched", () => {
    const { db, sqlite } = freshDb();
    try {
      const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
      const before = db.select().from(players).all();

      resolveRosterPlayer(db, { name: "Nobody Ontheroster", teamId: team.id });

      expect(db.select().from(players).all()).toEqual(before);
    } finally {
      sqlite.close();
    }
  });

  // Issue #49 (PR #52, main) added nullable `team_memberships.retired_at`; every OTHER
  // current-roster read (`getTeamProfile`, `getLineupPlan`) and write gate (`setAvailability`,
  // `addCaptainNote`) filters it. `resolveRosterPlayer` merged in without doing so (found by the
  // orchestrator's own audit after this branch merged main) — a retired player still resolved as
  // on-roster for a scorecard, through both the bare-name tiers and the prefix-ID `isOnRoster`
  // check, defeating the exact invariant this function exists to enforce.
  describe("retired team_memberships rows (#49) are excluded from the roster, like every sibling read", () => {
    it("REGRESSION: a bare name for a player RETIRED from the named team is not matched", () => {
      const { db, sqlite } = freshDb();
      try {
        const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
        const player = seedPlayer(db, "Ada Ashby");
        db.insert(teamMemberships)
          .values({ playerId: player.id, teamId: team.id, eventId: null, retiredAt: "2026-07-01T00:00:00.000Z" })
          .run();

        const result = resolveRosterPlayer(db, { name: "Ada Ashby", teamId: team.id });

        // Reported, not assumed: with the retired row excluded from the roster query entirely, the
        // player cannot appear in tier 2 (exact) or tier 3 (fuzzy) — nothing on file for this team
        // to be ambiguous WITH — so this resolves the same as a name matching no one at all.
        expect(result.kind).toBe("unresolved");
        if (result.kind === "unresolved") expect(result.candidates).toEqual([]);
      } finally {
        sqlite.close();
      }
    });

    it("REGRESSION: a usta: prefix-ID for a player RETIRED from the named team is off-roster, not matched", () => {
      const { db, sqlite } = freshDb();
      try {
        const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
        const player = seedPlayer(db, "Ada Ashby");
        db.update(players).set({ ustaUaid: "99999" }).where(eq(players.id, player.id)).run();
        db.insert(teamMemberships)
          .values({ playerId: player.id, teamId: team.id, eventId: null, retiredAt: "2026-07-01T00:00:00.000Z" })
          .run();

        const result = resolveRosterPlayer(db, { name: "usta:99999", teamId: team.id });

        expect(result.kind).toBe("off-roster");
        if (result.kind === "off-roster") expect(result.row.id).toBe(player.id);
      } finally {
        sqlite.close();
      }
    });

    it("a CURRENT (non-retired) member still resolves normally, by both a bare name and a prefix-ID — the guard must not over-refuse", () => {
      const { db, sqlite } = freshDb();
      try {
        const team = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
        const player = seedPlayer(db, "Ada Ashby");
        db.update(players).set({ ustaUaid: "99999" }).where(eq(players.id, player.id)).run();
        db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();

        const byName = resolveRosterPlayer(db, { name: "Ada Ashby", teamId: team.id });
        const byId = resolveRosterPlayer(db, { name: "usta:99999", teamId: team.id });

        expect(byName.kind).toBe("matched");
        if (byName.kind === "matched") expect(byName.row.id).toBe(player.id);
        expect(byId.kind).toBe("matched");
        if (byId.kind === "matched") expect(byId.row.id).toBe(player.id);
      } finally {
        sqlite.close();
      }
    });

    it("a player retired from team A but CURRENT on team B resolves for B, and is off-roster/unresolved for A", () => {
      const { db, sqlite } = freshDb();
      try {
        const teamA = seedTeam(db, "HOA/Burgess-Zingg/40&over3.5M");
        const teamB = seedTeam(db, "Report Opponent");
        const player = seedPlayer(db, "Ada Ashby");
        db.update(players).set({ ustaUaid: "99999" }).where(eq(players.id, player.id)).run();
        db.insert(teamMemberships)
          .values({ playerId: player.id, teamId: teamA.id, eventId: null, retiredAt: "2026-07-01T00:00:00.000Z" })
          .run();
        db.insert(teamMemberships).values({ playerId: player.id, teamId: teamB.id, eventId: null }).run();

        const forA = resolveRosterPlayer(db, { name: "Ada Ashby", teamId: teamA.id });
        const forAById = resolveRosterPlayer(db, { name: "usta:99999", teamId: teamA.id });
        const forB = resolveRosterPlayer(db, { name: "Ada Ashby", teamId: teamB.id });
        const forBById = resolveRosterPlayer(db, { name: "usta:99999", teamId: teamB.id });

        expect(forA.kind).toBe("unresolved");
        expect(forAById.kind).toBe("off-roster");
        expect(forB.kind).toBe("matched");
        if (forB.kind === "matched") expect(forB.row.id).toBe(player.id);
        expect(forBById.kind).toBe("matched");
        if (forBById.kind === "matched") expect(forBById.row.id).toBe(player.id);
      } finally {
        sqlite.close();
      }
    });
  });
});
