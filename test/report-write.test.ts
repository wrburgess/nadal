import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

  // REGRESSION (verify pass, PR #38, Finding 3). `src/ingest/archive.ts` re-checks for symlinked
  // path components AFTER `mkdirSync` (which silently treats an existing symlink-to-a-directory as
  // "already there") and writes with `flag: "wx"` so the leaf itself cannot be followed either.
  // `write.ts` inherited only the pre-`mkdirSync` check, so it never gained either protection.
  // Reports carry the same personal data as raw captures and land in the same public repo, so they
  // deserve the same discipline — the difference is reports are DELIBERATELY rewritten in place on
  // every run, so a bare `wx` (which refuses whenever anything already exists at the leaf) would
  // break every second run; the fix must refuse a symlink specifically, not "anything already there".
  describe("writeTeamDossier vs the filesystem (symlinks + reruns)", () => {
    it("REGRESSION: refuses to follow a symlink planted at index.html, even though mkdirSync silently succeeds over an existing directory", () => {
      const team = seedTeamWithRoster("Team Sym", []);
      const dir = join(reportsDir, "team-sym");
      mkdirSync(dir, { recursive: true });
      const escapeTarget = mkdtempSync(join(tmpdir(), "tn-escape-"));
      const linkTarget = join(escapeTarget, "leaked.html");
      symlinkSync(linkTarget, join(dir, "index.html"));
      const { db, sqlite } = openDb();
      try {
        expect(() => writeTeamDossier(db, team.id, { since: "2026-01-01" })).toThrow(OutputPathError);
        // The write must never have followed the symlink through to its target.
        expect(existsSync(linkTarget)).toBe(false);
      } finally {
        sqlite.close();
        rmSync(escapeTarget, { recursive: true, force: true });
      }
    });

    // REGRESSION (verify pass, PR #38, Finding 3 [medium]). `writeTeamDossier`'s doc comment claims
    // "a refusal leaves nothing on disk". Both paths ARE validated up front with
    // `assertReportPathSafe`, but the symlink-LEAF refusal lived only inside `overwriteOutputFile`,
    // which runs at WRITE time — after `index.html` has already been written. With `index.md`
    // symlinked and `index.html` absent, the html write succeeds, and only the md write throws,
    // leaving a fresh (untracked but very real) html dossier on disk despite the "throws" contract.
    // The pre-existing symlink test above only ever symlinks `index.html` — the FIRST leaf written —
    // so it fails before either write and can never observe this.
    it("REGRESSION: a symlinked index.md (index.html absent) refuses before index.html is ever written", () => {
      const team = seedTeamWithRoster("Team SymMd", []);
      const dir = join(reportsDir, "team-symmd");
      mkdirSync(dir, { recursive: true });
      const escapeTarget = mkdtempSync(join(tmpdir(), "tn-escape-"));
      const linkTarget = join(escapeTarget, "leaked.md");
      symlinkSync(linkTarget, join(dir, "index.md"));
      const { db, sqlite } = openDb();
      try {
        expect(() => writeTeamDossier(db, team.id, { since: "2026-01-01" })).toThrow(OutputPathError);
        // The bug this guards against: index.html landing on disk before the index.md symlink is
        // ever inspected.
        expect(existsSync(join(dir, "index.html"))).toBe(false);
        expect(existsSync(linkTarget)).toBe(false);
      } finally {
        sqlite.close();
        rmSync(escapeTarget, { recursive: true, force: true });
      }
    });

    it("a second run over the same team still succeeds and rewrites both files in place (no bare-'wx' regression)", () => {
      const team = seedTeamWithRoster("Team Rerun", []);
      const { db, sqlite } = openDb();
      try {
        const first = writeTeamDossier(db, team.id, { since: "2026-01-01" });
        let second: string[] = [];
        expect(() => {
          second = writeTeamDossier(db, team.id, { since: "2026-01-01" });
        }).not.toThrow();
        expect(second).toEqual(first);
        for (const p of second) {
          expect(existsSync(p)).toBe(true);
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

    // REGRESSION (verify pass, PR #38, Finding 1). `renderIndexHtml` correctly calls `escapeHtml` on
    // the team name; `renderIndexMarkdown` two functions below it interpolated the raw name straight
    // into a markdown link label — the exact defect class already fixed on the HTML side, left
    // unfixed one function over. A name containing `]`/`(`/`)` breaks the link's structure, and a
    // name containing `<script>` survives into the `.md` file as raw, renderable HTML (CommonMark
    // permits inline HTML) — either way a scraped, attacker-influenced team name controls markup in
    // a file this tool writes to disk.
    it("REGRESSION: escapes a team name that would otherwise break or inject markup into index.md's link", () => {
      seedTeamWithRoster("X](javascript:alert(1))", []);
      seedTeamWithRoster("<script>alert(1)</script>", []);
      const { db, sqlite } = openDb();
      try {
        writeSectionalsDossiers(db, { since: "2026-01-01" });
        const indexMd = readFileSync(join(reportsDir, "index.md"), "utf8");
        // Unescaped, "X](javascript:alert(1))" closes the link label early, turning the rest into a
        // live `(javascript:alert(1))` href — the escaped form has a backslash before the `]` so this
        // exact substring never appears.
        expect(indexMd).not.toContain("X](javascript:alert(1))");
        expect(indexMd).not.toContain("<script>alert(1)</script>");
      } finally {
        sqlite.close();
      }
    });

    // REGRESSION (verify pass, PR #38, Finding 2). `resolveTeamDirNames` checked the disambiguated
    // candidate (`${slug}-${teamId}`) for a collision exactly once, and added it unconditionally even
    // when THAT was already taken too — so two teams could still land in the same directory and one
    // dossier would silently overwrite the other. Reproducer in DB id order: id 1 "X" -> slug "x"; id
    // 2 "X 3" -> slug "x-3"; id 3 "X!" -> slug "x" collides -> retries "x-3" -> ALSO collides with
    // team 2. The function's own doc comment promises "neither dossier ever overwrites the other" —
    // this is the case that broke the promise.
    it("REGRESSION: a second-round collision (disambiguated slug ALSO taken) still gets a distinct directory", () => {
      const t1 = seedTeamWithRoster("X", []);
      const t2 = seedTeamWithRoster("X 3", []);
      const t3 = seedTeamWithRoster("X!", []);
      expect([t1.id, t2.id, t3.id]).toEqual([1, 2, 3]);
      const { db, sqlite } = openDb();
      try {
        const written = writeSectionalsDossiers(db, { since: "2026-01-01" });
        const teamIndexHtmlPaths = written.filter(
          (p) => p.endsWith("index.html") && p !== join(reportsDir, "index.html"),
        );
        const dirs = teamIndexHtmlPaths.map((p) => dirname(p));
        expect(new Set(dirs).size).toBe(3);
        for (const dir of dirs) {
          expect(existsSync(join(dir, "index.html"))).toBe(true);
        }
      } finally {
        sqlite.close();
      }
    });

    // REGRESSION (verify pass, PR #38, Finding 3 [medium]), same defect one level up: the top-level
    // `index.html`/`index.md` pair deserves the identical "refusal leaves nothing on disk" guarantee
    // as a single team's pair, not a lesser one just because it names every team on file rather than
    // one.
    it("REGRESSION: a symlinked top-level index.md (index.html absent) refuses before index.html is ever written", () => {
      seedTeamWithRoster("Team G", []);
      mkdirSync(reportsDir, { recursive: true });
      const escapeTarget = mkdtempSync(join(tmpdir(), "tn-escape-"));
      const linkTarget = join(escapeTarget, "leaked-index.md");
      symlinkSync(linkTarget, join(reportsDir, "index.md"));
      const { db, sqlite } = openDb();
      try {
        expect(() => writeSectionalsDossiers(db, { since: "2026-01-01" })).toThrow(OutputPathError);
        expect(existsSync(join(reportsDir, "index.html"))).toBe(false);
        expect(existsSync(linkTarget)).toBe(false);
        // Codex adversarial review, PR #38 round 2, Finding 3 [medium]: this test passed even before
        // the round-2 fix because it never checked what happened to Team G's OWN dossier. Teams are
        // written before the top-level index (see `writeSectionalsDossiers`'s body), so without a
        // batch-wide pre-validation pass, Team G's index.html/index.md land on disk BEFORE the
        // top-level index.md's symlink is ever inspected — "a refusal leaves nothing on disk" was
        // false for the batch even though this test's only assertions were about the top-level pair.
        expect(existsSync(join(reportsDir, "team-g", "index.html"))).toBe(false);
        expect(existsSync(join(reportsDir, "team-g", "index.md"))).toBe(false);
      } finally {
        sqlite.close();
        rmSync(escapeTarget, { recursive: true, force: true });
      }
    });

    // REGRESSION (Codex adversarial review, PR #38 round 2, Finding 3 [medium]). The reviewer's exact
    // reproducer: two teams, the LATER team's `index.md` is a symlink, and the EARLIER team has no
    // dossier on disk yet. Teams are written serially in `writeSectionalsDossiers`'s loop, so without
    // a batch-wide pre-validation pass, the earlier team's html+md are already written by the time
    // the later team's symlinked leaf is discovered (at write time, inside `overwriteOutputFile`) and
    // throws — leaving a fresh, unwanted dossier on disk despite `writeTeamDossier`'s own "a refusal
    // leaves nothing on disk" doc-comment promise, which only ever held PER TEAM, not across the
    // batch.
    it("REGRESSION: a symlinked leaf on the SECOND team refuses before the FIRST team's dossier is ever written", () => {
      const teamOne = seedTeamWithRoster("Team First", []);
      const teamTwo = seedTeamWithRoster("Team Second", []);
      const dirTwo = join(reportsDir, teamSlug(teamTwo.id, "Team Second"));
      mkdirSync(dirTwo, { recursive: true });
      const escapeTarget = mkdtempSync(join(tmpdir(), "tn-escape-"));
      const linkTarget = join(escapeTarget, "leaked.md");
      symlinkSync(linkTarget, join(dirTwo, "index.md"));
      const { db, sqlite } = openDb();
      try {
        expect(() => writeSectionalsDossiers(db, { since: "2026-01-01" })).toThrow(OutputPathError);
        // The bug this guards against: Team First's dossier — which has no symlink of its own and
        // would build+write without issue on its own — must not have been written just because it
        // happened to be processed (by id order) before Team Second's symlink was discovered.
        const dirOne = join(reportsDir, teamSlug(teamOne.id, "Team First"));
        expect(existsSync(join(dirOne, "index.html"))).toBe(false);
        expect(existsSync(join(dirOne, "index.md"))).toBe(false);
        expect(existsSync(linkTarget)).toBe(false);
      } finally {
        sqlite.close();
        rmSync(escapeTarget, { recursive: true, force: true });
      }
    });

    // REGRESSION (Codex adversarial review, PR #38 round 2, Finding 2 [high]). Neither
    // `db.select().from(teams).all()` call this collision scheme depends on (write.ts:115 inside
    // `resolveDirNameForTeam`, write.ts:242 here) carries an `ORDER BY`. SQL makes NO guarantee about
    // unordered row order, and SQLite has a documented pragma, `reverse_unordered_selects`, whose
    // entire purpose is to surface bugs that (wrongly) assume one — exactly the shape of bug this
    // test targets. Without an explicit `ORDER BY teams.id`, two DIFFERENT invocations (a batch
    // `sectionals` run, and a later single-team `tn report build "<team>"` refresh on a fresh
    // connection) can observe teams.* in different row orders and therefore assign the SAME colliding
    // team to DIFFERENT directories — which is precisely the overwrite bug round 1 claimed to fix,
    // reintroduced one layer up. This is NOT satisfied by getting insertion order "by luck" (the
    // round-1 tests' gap, per the reviewer): the pragma below forces a genuinely different order on
    // the second connection.
    it("REGRESSION: a single-team refresh must not disagree with the batch build on a colliding team's directory, even when SQLite's row order differs between the two connections", () => {
      const teamOne = seedTeamWithRoster("Team A!!!", []);
      const teamTwo = seedTeamWithRoster("Team A???", []);

      // Invocation 1: `sectionals`, on an ordinary connection.
      const batch = openDb();
      let batchWritten: string[];
      try {
        batchWritten = writeSectionalsDossiers(batch.db, { since: "2026-01-01" });
      } finally {
        batch.sqlite.close();
      }
      const batchTeamHtmlPaths = batchWritten.filter(
        (p) => p.endsWith("index.html") && p !== join(reportsDir, "index.html"),
      );
      const batchDirForTeamTwo = dirname(
        batchTeamHtmlPaths.find((p) => readFileSync(p, "utf8").includes("Team A???"))!,
      );

      // Invocation 2: `tn report build "Team A???"` — a single-team refresh, on a SEPARATE connection
      // where the unordered SELECT happens to come back reversed. Same DB, same teams, same
      // collision — this must still land in the SAME directory invocation 1 chose.
      rmSync(reportsDir, { recursive: true, force: true });
      const single = openDb();
      single.sqlite.pragma("reverse_unordered_selects = ON");
      let singleWritten: string[];
      try {
        singleWritten = writeTeamDossier(single.db, teamTwo.id, { since: "2026-01-01" });
      } finally {
        single.sqlite.close();
      }
      const singleDirForTeamTwo = dirname(singleWritten.find((p) => p.endsWith("index.html"))!);

      expect(singleDirForTeamTwo).toBe(batchDirForTeamTwo);
      expect(teamOne.id).toBeLessThan(teamTwo.id); // sanity: id order is the order the scheme depends on
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
