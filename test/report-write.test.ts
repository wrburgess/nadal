import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { players, teamMemberships, teams } from "../src/db/schema.js";
import { OutputPathError } from "../src/fs/output-root.js";
import { buildTeamDossier, writeTeamDossier, writeSectionalsDossiers } from "../src/report/write.js";
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
  });

  describe("writeSectionalsDossiers", () => {
    it("writes one dossier per team in the DB, plus a top-level index.html/index.md", () => {
      const teamE = seedTeamWithRoster("Team E", []);
      const teamF = seedTeamWithRoster("Team F", []);
      const { db, sqlite } = openDb();
      try {
        const written = writeSectionalsDossiers(db, { since: "2026-01-01" });
        // 2 teams * 2 files each (index.html + index.md) + 2 top-level index files.
        expect(written.length).toBe(6);
        for (const path of written) {
          expect(existsSync(path)).toBe(true);
        }
        expect(written).toContain(join(reportsDir, `team-${teamE.id}`, "index.html"));
        expect(written).toContain(join(reportsDir, `team-${teamF.id}`, "index.md"));
        expect(written).toContain(join(reportsDir, "index.html"));
        expect(written).toContain(join(reportsDir, "index.md"));
        // The top-level index links to each team dossier.
        expect(readFileSync(join(reportsDir, "index.html"), "utf8")).toContain("Team E");
        expect(readFileSync(join(reportsDir, "index.md"), "utf8")).toContain("Team F");
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
