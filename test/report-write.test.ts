import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { players, teamMemberships, teams } from "../src/db/schema.js";
import { OutputPathError } from "../src/fs/output-root.js";
import {
  buildTeamDossier,
  slugify,
  teamSlug,
  writeTeamDossier,
  writeSectionalsDossiers,
} from "../src/report/write.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("src/report/write.ts", () => {
  useTnDbPath();
  let reportsDir: string;
  const originalReportsPath = process.env.TN_REPORTS_PATH;

  beforeEach(() => {
    reportsDir = mkdtempSync(join(tmpdir(), "tn-reports-"));
    process.env.TN_REPORTS_PATH = reportsDir;
  });

  afterEach(() => {
    if (originalReportsPath === undefined) delete process.env.TN_REPORTS_PATH;
    else process.env.TN_REPORTS_PATH = originalReportsPath;
    rmSync(reportsDir, { recursive: true, force: true });
  });

  function seedTeamWithRoster(name: string, playerNames: string[]) {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name }).returning().get();
    for (const playerName of playerNames) {
      const player = db.insert(players).values({ canonicalName: playerName }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    }
    sqlite.close();
    return team;
  }

  describe("buildTeamDossier", () => {
    it("assembles a TeamDossier with one full PlayerProfile per roster member, same order as team.roster", () => {
      const team = seedTeamWithRoster("Team A", ["Zed Zephyr", "Alice Anders"]);
      const { db, sqlite } = openDb();
      try {
        const dossier = buildTeamDossier(db, team.id, { since: "2026-01-01" });
        expect(dossier.team.teamName).toBe("Team A");
        expect(dossier.players.map((p) => p.identity.canonicalName)).toEqual(
          dossier.team.roster.map((r) => r.canonicalName),
        );
      } finally {
        sqlite.close();
      }
    });
  });

  describe("writeTeamDossier", () => {
    it("writes <reports>/<team>/index.html and index.md under TN_REPORTS_PATH", () => {
      const team = seedTeamWithRoster("Team B", ["Player One"]);
      const { db, sqlite } = openDb();
      try {
        const written = writeTeamDossier(db, team.id, { since: "2026-01-01" });
        expect(written.length).toBe(2);
        for (const path of written) {
          expect(existsSync(path)).toBe(true);
        }
        expect(written.some((p) => p.endsWith(".html"))).toBe(true);
        expect(written.some((p) => p.endsWith(".md"))).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it("is byte-identical on a second run over the same DB", () => {
      const team = seedTeamWithRoster("Team C", ["Player One"]);
      const { db, sqlite } = openDb();
      try {
        const firstRun = writeTeamDossier(db, team.id, { since: "2026-01-01" });
        const firstContents = firstRun.map((p) => readFileSync(p, "utf8"));
        const secondRun = writeTeamDossier(db, team.id, { since: "2026-01-01" });
        const secondContents = secondRun.map((p) => readFileSync(p, "utf8"));
        expect(secondContents).toEqual(firstContents);
      } finally {
        sqlite.close();
      }
    });

    it("refuses a TN_REPORTS_PATH inside the repo tree at anything other than reports/", () => {
      process.env.TN_REPORTS_PATH = resolve("src");
      const team = seedTeamWithRoster("Team D", []);
      const { db, sqlite } = openDb();
      try {
        expect(() => writeTeamDossier(db, team.id, { since: "2026-01-01" })).toThrow(OutputPathError);
      } finally {
        sqlite.close();
      }
    });

    it("writes under a slugified team-name directory, not the opaque team-<id> name — a courtside binder must be navigable by opponent name", () => {
      const team = seedTeamWithRoster("IA/Versteeg/40&Over3.5M", []);
      const { db, sqlite } = openDb();
      try {
        const written = writeTeamDossier(db, team.id, { since: "2026-01-01" });
        expect(written.every((p) => p.includes(join(reportsDir, "ia-versteeg-40-over3-5m")))).toBe(true);
        expect(written.some((p) => p.includes(`team-${team.id}`))).toBe(false);
      } finally {
        sqlite.close();
      }
    });

    it("a team name that is entirely punctuation slugifies to nothing, so the directory falls back to team-<id>", () => {
      const team = seedTeamWithRoster("!!!", []);
      const { db, sqlite } = openDb();
      try {
        const written = writeTeamDossier(db, team.id, { since: "2026-01-01" });
        expect(written.every((p) => p.includes(join(reportsDir, `team-${team.id}`)))).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it("a team name shaped like a path-traversal attempt cannot escape the reports root by construction", () => {
      const team = seedTeamWithRoster("../../etc/passwd", []);
      const { db, sqlite } = openDb();
      try {
        const written = writeTeamDossier(db, team.id, { since: "2026-01-01" });
        for (const p of written) {
          expect(p.startsWith(reportsDir)).toBe(true);
          expect(p).not.toContain("..");
        }
      } finally {
        sqlite.close();
      }
    });
  });

  describe("slugify", () => {
    it("lowercases and collapses runs of non-alphanumerics to a single dash", () => {
      expect(slugify("IA/Versteeg/40&Over3.5M")).toBe("ia-versteeg-40-over3-5m");
    });

    it("trims leading and trailing dashes", () => {
      expect(slugify("--Hello World--")).toBe("hello-world");
    });

    it("a name that is entirely punctuation slugifies to the empty string", () => {
      expect(slugify("!!!")).toBe("");
    });

    it("no dot, double-dot, forward-slash, or backslash survives slugification", () => {
      const slug = slugify("../../etc/passwd\\windows");
      expect(slug).not.toMatch(/[./\\]/);
      expect(slug).not.toContain("..");
    });
  });

  describe("teamSlug", () => {
    it("falls back to team-<id> when the name slugifies to the empty string", () => {
      expect(teamSlug(42, "!!!")).toBe("team-42");
    });

    it("uses the slugified name otherwise", () => {
      expect(teamSlug(42, "Team Alpha")).toBe("team-alpha");
    });
  });

  describe("writeSectionalsDossiers", () => {
    it("writes one dossier per team in the DB, plus a top-level index.html/index.md", () => {
      seedTeamWithRoster("Team E", []);
      seedTeamWithRoster("Team F", []);
      const { db, sqlite } = openDb();
      try {
        const written = writeSectionalsDossiers(db, { since: "2026-01-01" });
        // 2 teams * 2 files each (index.html + index.md) + 2 top-level index files.
        expect(written.length).toBe(6);
        for (const path of written) {
          expect(existsSync(path)).toBe(true);
        }
        // Directories are named for the team (slugified), not the opaque numeric id — a courtside
        // binder must be navigable by opponent name, not by looking up which id belongs to which team.
        expect(written).toContain(join(reportsDir, "team-e", "index.html"));
        expect(written).toContain(join(reportsDir, "team-f", "index.md"));
        expect(written).toContain(join(reportsDir, "index.html"));
        expect(written).toContain(join(reportsDir, "index.md"));
        // The top-level index links to each team dossier.
        expect(readFileSync(join(reportsDir, "index.html"), "utf8")).toContain("Team E");
        expect(readFileSync(join(reportsDir, "index.md"), "utf8")).toContain("Team F");
      } finally {
        sqlite.close();
      }
    });

    it("two distinct team names that slugify identically get distinct, collision-safe directories", () => {
      // "Team A!!!" and "Team A???" both slugify to "team-a" — neither may overwrite the other's
      // dossier, so the later team (by insertion/id order) must get its id appended to disambiguate.
      seedTeamWithRoster("Team A!!!", []);
      const teamTwo = seedTeamWithRoster("Team A???", []);
      const { db, sqlite } = openDb();
      try {
        const written = writeSectionalsDossiers(db, { since: "2026-01-01" });
        expect(written).toContain(join(reportsDir, "team-a", "index.html"));
        expect(written).toContain(join(reportsDir, `team-a-${teamTwo.id}`, "index.html"));
        // Every written path actually exists, and the two dossiers are genuinely distinct files —
        // this is the assertion that would fail if the second team silently overwrote the first.
        expect(existsSync(join(reportsDir, "team-a", "index.html"))).toBe(true);
        expect(existsSync(join(reportsDir, `team-a-${teamTwo.id}`, "index.html"))).toBe(true);
        expect(readFileSync(join(reportsDir, "team-a", "index.html"), "utf8")).toContain("Team A!!!");
        expect(readFileSync(join(reportsDir, `team-a-${teamTwo.id}`, "index.html"), "utf8")).toContain(
          "Team A???",
        );
      } finally {
        sqlite.close();
      }
    });

    it("with no teams in the DB, still writes a (near-empty) top-level index without crashing", () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const written = writeSectionalsDossiers(db, { since: "2026-01-01" });
        expect(written.length).toBe(2);
      } finally {
        sqlite.close();
      }
    });
  });
});
