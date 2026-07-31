import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { teams } from "../src/db/schema.js";
import { HomeTeamNotFoundError, resolveHomeTeam, setHomeTeam } from "../src/query/home-team.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("home team designation", () => {
  useTnDbPath();

  function seedTeam(db: ReturnType<typeof openDb>["db"], name: string) {
    return db.insert(teams).values({ name }).returning().get();
  }

  it("resolveHomeTeam returns null when no team is designated", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      expect(resolveHomeTeam(db)).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("designating a team via setHomeTeam makes resolveHomeTeam return it", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const team = seedTeam(db, "Burgess-Zingg");
      setHomeTeam(db, team.id);
      const resolved = resolveHomeTeam(db);
      expect(resolved?.id).toBe(team.id);
      expect(resolved?.name).toBe("Burgess-Zingg");
    } finally {
      sqlite.close();
    }
  });

  it("many teams may coexist at is_home = null/0 freely", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      seedTeam(db, "Team A");
      seedTeam(db, "Team B");
      seedTeam(db, "Team C");
      expect(resolveHomeTeam(db)).toBeNull();
      expect(db.select().from(teams).all()).toHaveLength(3);
    } finally {
      sqlite.close();
    }
  });

  it("setHomeTeam moving the flag from team A to team B leaves exactly one set row", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const teamA = seedTeam(db, "Team A");
      const teamB = seedTeam(db, "Team B");
      setHomeTeam(db, teamA.id);
      setHomeTeam(db, teamB.id);

      const resolved = resolveHomeTeam(db);
      expect(resolved?.id).toBe(teamB.id);

      const allTeams = db.select().from(teams).all();
      expect(allTeams.filter((t) => t.isHome === true)).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("setHomeTeam against a nonexistent team id throws HomeTeamNotFoundError and leaves the prior designation intact (transactional)", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const teamA = seedTeam(db, "Team A");
      setHomeTeam(db, teamA.id);

      expect(() => setHomeTeam(db, teamA.id + 999)).toThrow(HomeTeamNotFoundError);

      // No partial mutation: team A is still, and remains the ONLY, home team.
      const resolved = resolveHomeTeam(db);
      expect(resolved?.id).toBe(teamA.id);
      const allTeams = db.select().from(teams).all();
      expect(allTeams.filter((t) => t.isHome === true)).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("a second row set to is_home = 1 directly (bypassing setHomeTeam) throws the DB's own constraint error, asserted by class not message", () => {
    // Provoked directly against the schema's partial unique index, NOT through setHomeTeam (which
    // always clears first) — this is what proves the invariant is enforced by the database itself,
    // not merely by application code that happens to clear before it sets (rules/backend.md: "a
    // validation is not a guarantee under concurrency"). Asserting on the error CLASS (not its
    // message text) is deliberate: docs/findings.md (#16) records a prior defect where an
    // English-only message match silently broke under a non-English locale.
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const teamA = seedTeam(db, "Team A");
      const teamB = seedTeam(db, "Team B");
      db.update(teams).set({ isHome: true }).where(eq(teams.id, teamA.id)).run();
      expect(() => db.update(teams).set({ isHome: true }).where(eq(teams.id, teamB.id)).run()).toThrow(
        Database.SqliteError,
      );
    } finally {
      sqlite.close();
    }
  });
});
