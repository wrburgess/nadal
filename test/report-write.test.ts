import { eq } from "drizzle-orm";
import { evidenceWindow, windowSnapshot } from "../src/cli/window.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { players, teamMemberships, teams } from "../src/db/schema.js";
import { OutputPathError } from "../src/fs/output-root.js";
import { setAvailability } from "../src/query/availability.js";
import { addCaptainNote } from "../src/query/captain-notes.js";
import { addEvent } from "../src/query/events.js";
import { resolveEvent } from "../src/query/lineup.js";
import { setHomeTeam } from "../src/query/home-team.js";
import { renderDossier } from "../src/report/html.js";
import { renderDossierMarkdown } from "../src/report/markdown.js";
import {
  buildTeamDossier,
  slugify,
  teamSlug,
  writeTeamDossier,
  writeSectionalsDossiers,
} from "../src/report/write.js";
import { seedHomeTeamFixture } from "./helpers/home-team.js";
import { seedTeamWithRosters } from "./helpers/roster.js";
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
        const dossier = buildTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") });
        expect(dossier.team.teamName).toBe("Team A");
        expect(dossier.players.map((p) => p.identity.canonicalName)).toEqual(
          dossier.team.roster.map((r) => r.canonicalName),
        );
      } finally {
        sqlite.close();
      }
    });

    // Task 8 (#113): the downstream consequence of flipping `events`' `hasWriter`. Every real
    // dossier used to report `events` as "not-collected" for every player unconditionally (nothing
    // could ever populate it), so the "## Not collected yet" section always rendered. With all
    // three sections now written (`availability`/`captainNotes` since #17 PR A, `events` since
    // #113), a REAL dossier for a player with none of the three recorded reports all three as
    // "empty" instead — and the whole section disappears. Built through `buildTeamDossier`
    // (real DB rows), not a hand-built fixture — the report-html/markdown suites hand-build
    // `dataGaps` directly and would not redden for this.
    it("the '## Not collected yet' section is ABSENT from a real dossier now that events has a writer too", () => {
      const team = seedTeamWithRoster("Team No Gaps", ["Nova Norbury"]);
      const { db, sqlite } = openDb();
      try {
        const dossier = buildTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") });
        expect(dossier.players[0]!.dataGaps).toEqual({
          events: "empty",
          availability: "empty",
          captainNotes: "empty",
        });

        const md = renderDossierMarkdown(dossier);
        const html = renderDossier(dossier);
        expect(md).not.toContain("Not collected yet");
        expect(html).not.toContain("Not collected yet");
      } finally {
        sqlite.close();
      }
    });

    // #126. Driven through the REAL writers (`setAvailability` / `addCaptainNote`) rather than
    // hand-inserted rows — the discipline #113 established, and whose cost `player-profile.ts`
    // records: a fixture that writes rows directly can pass while the actual write path is broken.
    describe("own-team book (#126)", () => {
      function seedHomeWithEvent() {
        runMigrations();
        const { db, sqlite } = openDb();
        const fixture = seedHomeTeamFixture(db, { eventName: "Springfield Sectionals 2026" });
        // `buildTeamDossier` threads `options.event` into `getLineupPlan`, which refuses an event
        // with no format on file — added so the build reaches the assertions, as above.
        addEvent(db, {
          name: "Springfield Sectionals 2026",
          kind: "tournament",
          startsOn: "2026-08-28",
          endsOn: "2026-08-30",
          format: "S1:singles",
        });
        return { db, sqlite, fixture };
      }

      it("populates ownTeam for the home team, from what the real writers stored", () => {
        const { db, sqlite, fixture } = seedHomeWithEvent();
        try {
          setAvailability(db, { playerId: fixture.playerId, day: "2026-08-29", status: "available" });
          addCaptainNote(db, { playerId: fixture.playerId, text: "steady under pressure" });

          const event = resolveEvent(db, "Springfield Sectionals 2026");
          const dossier = buildTeamDossier(db, fixture.homeTeamId, {
            window: evidenceWindow("2026-01-01"),
            event,
          });

          expect(dossier.ownTeam).not.toBeNull();
          // Every day of the event range, not only the answered one.
          expect(dossier.ownTeam!.availability!.days).toEqual(["2026-08-28", "2026-08-29", "2026-08-30"]);
          expect(dossier.ownTeam!.notes.player.map((n) => n.note)).toEqual(["steady under pressure"]);

          // And it reaches the page — the point of the whole issue.
          expect(renderDossierMarkdown(dossier)).toContain("## Own-team book");
        } finally {
          sqlite.close();
        }
      });

      it("leaves ownTeam null for an opponent, even with our own availability on file", () => {
        const { db, sqlite, fixture } = seedHomeWithEvent();
        try {
          setAvailability(db, { playerId: fixture.playerId, day: "2026-08-29", status: "available" });
          const opponent = seedTeamWithRosters(db, {
            teamName: "OK/Dickason/40&over3.5M",
            season: ["Cy Calder"],
          });

          const event = resolveEvent(db, "Springfield Sectionals 2026");
          const dossier = buildTeamDossier(db, opponent.teamId, {
            window: evidenceWindow("2026-01-01"),
            event,
          });

          // An opponent's book is not empty — it does not exist. Spec § Domain model: captain notes
          // and availability are "populated for our team only, by design".
          expect(dossier.ownTeam).toBeNull();
          expect(renderDossierMarkdown(dossier)).not.toContain("Own-team book");
        } finally {
          sqlite.close();
        }
      });

      // THE regression this issue's real-data check caught. Against the live database the grid
      // listed 13 players while the roster table three sections above it said "registered 11" — and
      // the two extra names were exactly the ones the dossier's own "Not registered (watch for
      // adds)" section prints. Every unit test passed: the query was scoped correctly to the TEAM,
      // which is simply the wrong question for an event-scoped dossier.
      it("the availability grid lists the REGISTERED field, not everyone on the season roster", () => {
        const { db, sqlite, fixture } = seedHomeWithEvent();
        try {
          // A season-roster member who did not register for this event.
          const unregistered = db.insert(players).values({ canonicalName: "Nate Notregistered" }).returning().get();
          db.insert(teamMemberships)
            .values({ playerId: unregistered.id, teamId: fixture.homeTeamId, eventId: null })
            .run();

          const event = resolveEvent(db, "Springfield Sectionals 2026");
          const dossier = buildTeamDossier(db, fixture.homeTeamId, {
            window: evidenceWindow("2026-01-01"),
            event,
          });

          // One page, one answer to "who is on this team": the grid and the roster table must name
          // the same people.
          expect(dossier.ownTeam!.availability!.players.map((p) => p.canonicalName)).toEqual(
            dossier.team.roster.map((m) => m.canonicalName),
          );
          expect(dossier.ownTeam!.availability!.players.map((p) => p.canonicalName)).not.toContain(
            "Nate Notregistered",
          );
        } finally {
          sqlite.close();
        }
      });

      // Retirement filtering lives in `resolveRoster` (src/query/roster.ts), not in
      // `getAvailabilityForEvent` — this is the end-to-end proof that it still reaches the grid,
      // asserted at the layer that owns it rather than at the one that merely benefits.
      it("a soft-retired member reaches neither the roster table nor the availability grid", () => {
        const { db, sqlite, fixture } = seedHomeWithEvent();
        try {
          setAvailability(db, { playerId: fixture.playerId, day: "2026-08-29", status: "available" });
          db.update(teamMemberships)
            .set({ retiredAt: "2026-08-01T00:00:00.000Z" })
            .where(eq(teamMemberships.playerId, fixture.playerId))
            .run();

          const event = resolveEvent(db, "Springfield Sectionals 2026");
          const dossier = buildTeamDossier(db, fixture.homeTeamId, {
            window: evidenceWindow("2026-01-01"),
            event,
          });

          expect(dossier.team.roster.map((m) => m.canonicalName)).not.toContain(fixture.playerName);
          expect(dossier.ownTeam!.availability!.players.map((p) => p.canonicalName)).not.toContain(
            fixture.playerName,
          );
        } finally {
          sqlite.close();
        }
      });

      // REGRESSION, Codex adversarial review of PR #134 [high]. `buildTeamDossier` derives THREE
      // things from "who is the home team" — `versusTeamId`, `team.isHome`, and `ownTeam`. Two came
      // from the read at write.ts:185 and the third from an independent re-read inside
      // `getTeamProfile` (team-profile.ts:294). A `tn team home` from the neighbouring process
      // landing between them produced a dossier carrying an Own-team book while its prior-meetings
      // section printed "no home team configured" — the #19 defect, through the back door.
      //
      // The fixture forces the divergence deterministically rather than racing a real clock: it
      // proves the three derivations now come from ONE read, which is the actual invariant.
      it("ownTeam and team.isHome always agree, even if the home team changes mid-assembly", () => {
        const { db, sqlite, fixture } = seedHomeWithEvent();
        try {
          const other = seedTeamWithRosters(db, { teamName: "OK/Dickason/40&over3.5M", season: ["Cy Calder"] });
          const event = resolveEvent(db, "Springfield Sectionals 2026");

          const dossier = buildTeamDossier(db, fixture.homeTeamId, {
            window: evidenceWindow("2026-01-01"),
            event,
          });

          // The two must never contradict: a book means "this is our team", and so does `isHome`.
          expect(dossier.ownTeam !== null).toBe(dossier.team.isHome);

          // And the opposite pairing, on a team that is not ours.
          const opponentDossier = buildTeamDossier(db, other.teamId, {
            window: evidenceWindow("2026-01-01"),
            event,
          });
          expect(opponentDossier.ownTeam !== null).toBe(opponentDossier.team.isHome);
          expect(opponentDossier.team.isHome).toBe(false);
        } finally {
          sqlite.close();
        }
      });

      it("a dossier built with no home team designated carries no book and reports isHome false", () => {
        // The `null` half of the `homeTeamId` contract: "the caller resolved it and there is none"
        // must not fall back to a fresh read inside `getTeamProfile`.
        runMigrations();
        const { db, sqlite } = openDb();
        try {
          const team = seedTeamWithRosters(db, { teamName: "Nobody Home", season: ["Cy Calder"] });
          const dossier = buildTeamDossier(db, team.teamId, { window: evidenceWindow("2026-01-01") });

          expect(dossier.ownTeam).toBeNull();
          expect(dossier.team.isHome).toBe(false);
        } finally {
          sqlite.close();
        }
      });

      it("reports availability as null, not an empty grid, when the build names no event", () => {
        const { db, sqlite, fixture } = seedHomeWithEvent();
        try {
          addCaptainNote(db, { playerId: fixture.playerId, text: "notes still work unscoped" });

          // No `event` option at all — availability is per-event-day, so there is no range.
          const dossier = buildTeamDossier(db, fixture.homeTeamId, { window: evidenceWindow("2026-01-01") });

          expect(dossier.ownTeam).not.toBeNull();
          expect(dossier.ownTeam!.availability).toBeNull();
          // Notes are event-independent, so they still render.
          expect(dossier.ownTeam!.notes.player).toHaveLength(1);
          expect(renderDossierMarkdown(dossier).toLowerCase()).toContain("no event named");
        } finally {
          sqlite.close();
        }
      });
    });
  });

  // Task 3 (#113): `options.event` already threads through to `getLineupPlan`; this pins the SAME
  // resolved value now also scoping `getTeamProfile`'s roster, and that two teams sharing one
  // resolved event each scope independently — a registered roster for one team must not leak into,
  // or be assumed for, a team that never registered.
  describe("buildTeamDossier — event-scoped roster (#113)", () => {
    it("each team scopes its OWN roster against the same resolved event", () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const registeredTeam = seedTeamWithRosters(db, {
          teamName: "OK/Dickason/40&over3.5M",
          season: ["Alice Anders", "Bo Bramwell"],
          registered: { eventName: "Springfield Sectionals 2026", names: ["Alice Anders"] },
        });
        const unregisteredTeam = seedTeamWithRosters(db, {
          teamName: "IA/Versteeg/40&Over3.5M",
          season: ["Cy Calder", "Del Duxbury"],
        });
        // `buildTeamDossier` threads `options.event` straight into `getLineupPlan`, which refuses an
        // event with no format on file — a format is added here purely so the dossier build reaches
        // the roster assertions below, not because this test is about the predicted lineup.
        addEvent(db, {
          name: "Springfield Sectionals 2026",
          kind: "tournament",
          startsOn: "2026-08-28",
          endsOn: "2026-08-30",
          format: "S1:singles",
        });
        const event = resolveEvent(db, "Springfield Sectionals 2026");

        const registeredDossier = buildTeamDossier(db, registeredTeam.teamId, {
          window: evidenceWindow("2026-01-01"),
          event,
        });
        const unregisteredDossier = buildTeamDossier(db, unregisteredTeam.teamId, {
          window: evidenceWindow("2026-01-01"),
          event,
        });

        expect(registeredDossier.team.rosterSource).toBe("registered");
        expect(registeredDossier.team.roster.map((r) => r.canonicalName)).toEqual(["Alice Anders"]);
        expect(unregisteredDossier.team.rosterSource).toBe("season");
        expect(unregisteredDossier.team.roster.map((r) => r.canonicalName).sort()).toEqual([
          "Cy Calder",
          "Del Duxbury",
        ]);
      } finally {
        sqlite.close();
      }
    });
  });

  describe("buildTeamDossier — home-team head-to-head wiring (Task 5)", () => {
    it("populates headToHead against the designated home team when building an OPPONENT's dossier", () => {
      const home = seedTeamWithRoster("Home Team", ["Home Player"]);
      const opponent = seedTeamWithRoster("Opponent Team", ["Opponent Player"]);
      const { db, sqlite } = openDb();
      try {
        setHomeTeam(db, home.id);
        const dossier = buildTeamDossier(db, opponent.id, { window: evidenceWindow("2026-01-01") });
        // Not null — "not requested" must become distinguishable from "requested, nothing found"
        // now that a home team IS designated (src/query/team-profile.ts's own doc comment on this).
        expect(dossier.team.headToHead).not.toBeNull();
      } finally {
        sqlite.close();
      }
    });

    it("stays null (the existing 'not available' path) when no home team is designated at all", () => {
      const opponent = seedTeamWithRoster("Opponent Team", ["Opponent Player"]);
      const { db, sqlite } = openDb();
      try {
        const dossier = buildTeamDossier(db, opponent.id, { window: evidenceWindow("2026-01-01") });
        expect(dossier.team.headToHead).toBeNull();
      } finally {
        sqlite.close();
      }
    });

    it("stays null when building the HOME team's OWN dossier — never compares a team against itself", () => {
      const home = seedTeamWithRoster("Home Team", ["Home Player"]);
      const { db, sqlite } = openDb();
      try {
        setHomeTeam(db, home.id);
        const dossier = buildTeamDossier(db, home.id, { window: evidenceWindow("2026-01-01") });
        expect(dossier.team.headToHead).toBeNull();
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
        const written = writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") }).files;
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
        const firstRun = writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") }).files;
        const firstContents = firstRun.map((p) => readFileSync(p, "utf8"));
        const secondRun = writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") }).files;
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
        expect(() => writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") })).toThrow(OutputPathError);
      } finally {
        sqlite.close();
      }
    });

    it("writes under a slugified team-name directory, not the opaque team-<id> name — a courtside binder must be navigable by opponent name", () => {
      const team = seedTeamWithRoster("IA/Versteeg/40&Over3.5M", []);
      const { db, sqlite } = openDb();
      try {
        const written = writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") }).files;
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
        const written = writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") }).files;
        expect(written.every((p) => p.includes(join(reportsDir, `team-${team.id}`)))).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it("a team name shaped like a path-traversal attempt cannot escape the reports root by construction", () => {
      const team = seedTeamWithRoster("../../etc/passwd", []);
      const { db, sqlite } = openDb();
      try {
        const written = writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") }).files;
        for (const p of written) {
          expect(p.startsWith(reportsDir)).toBe(true);
          expect(p).not.toContain("..");
        }
      } finally {
        sqlite.close();
      }
    });

    // Round-1 Finding 3 (#122 review): the double-read this fix closes, pinned directly.
    // `buildTeamDossier` (called by `writeTeamDossier`) takes the window AND the event as two
    // separate, ALREADY-RESOLVED values — it must consume exactly what it was handed, never re-read
    // `events` to fill in either one. A concurrent `tn event add` committing a different `starts_on`
    // AND a different `leagueScope` to the SAME row, after resolution but before the dossier is
    // built, proves that by construction: if this function re-read the row, the window label would
    // shift to the NEW `starts_on` while the evidence scope came from whichever read happened to run
    // — the exact split the round-1 reviewer traced (window from one snapshot, scope/format/roster
    // from another).
    it("consumes the resolved window and event it was handed, never re-reads — a concurrent update to the same row after resolution does not reach the dossier", () => {
      const team = seedTeamWithRoster("Team Stale Event", ["Player One"]);
      const { db, sqlite } = openDb();
      try {
        addEvent(db, {
          name: "Sectionals 2026",
          kind: "tournament",
          startsOn: "2026-08-28",
          endsOn: "2026-08-30",
          format: "S1:singles",
          leagueScope: "exclude:Mixed",
        });
        const staleEvent = resolveEvent(db, "Sectionals 2026");
        const staleWindow = windowSnapshot(evidenceWindow(staleEvent.recordedAs.startsOn!));

        // A concurrent writer commits a DIFFERENT starts_on AND a different league scope to the SAME
        // row, after `staleEvent`/`staleWindow` above were already resolved.
        addEvent(db, {
          name: "Sectionals 2026",
          kind: "tournament",
          startsOn: "2026-09-28",
          endsOn: "2026-09-30",
          format: "S1:singles",
          leagueScope: "only:Mixed",
        });

        const written = writeTeamDossier(db, team.id, { window: staleWindow, event: staleEvent }).files;
        const html = readFileSync(written.find((p) => p.endsWith(".html"))!, "utf8");

        // The STALE anchor's label, not the updated row's — proves the window was never re-derived.
        expect(html).toContain("12mo to 2026-08-28");
        // The STALE league scope's own rendering, not the updated row's — proves the evidence scope
        // was never re-read either. `exclude:Mixed` renders "excluding league contexts…";
        // `only:Mixed` (the updated row) would render "only league contexts…" instead, so the two
        // scopes read distinguishably.
        expect(html).toContain("excluding league contexts");
        expect(html).not.toContain("only league contexts");
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
        expect(() => writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") })).toThrow(OutputPathError);
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
        expect(() => writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") })).toThrow(OutputPathError);
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
        const first = writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") }).files;
        let second: string[] = [];
        expect(() => {
          second = writeTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") }).files;
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
    // Codex adversarial review of PR #82, Finding 1 [high]. nadal runs `tn mcp serve` beside a CLI
    // invocation against one WAL database, so a `tn event add` committing PART WAY THROUGH a
    // `report build` is an ordinary concurrent-PROCESS interleaving, not a contrived one. When the
    // event was resolved once per TEAM, one batch could emit a two-court dossier and a four-court
    // dossier that each name the same event — while GRAMMAR.md promises the named event's format
    // applies to every dossier the run builds.
    //
    // Reproduced deterministically without a second process: the trigger corrupts the `events` row
    // right after `writeSectionalsDossiers` starts reading, and asserts the batch completes anyway.
    //
    // Round-1 Finding 3 (#122 review) moved event resolution OUT of this function entirely — the
    // caller (`tn report build`'s command / MCP handler) now resolves once via `resolveEvent` and
    // hands the already-resolved `ResolvedEvent` down, closing the double-read where the WINDOW came
    // from one snapshot (`resolveWindowAnchor`'s own read) and the format/scope/roster came from a
    // SECOND, independent one (`resolveEvent`'s). `writeSectionalsDossiers` therefore no longer reads
    // `events` at all, which is the narrower property this now pins directly: a write racing in
    // behind it — even one that corrupts the very row this batch's event was resolved from — cannot
    // reach an already-resolved value this function never looks up again.
    it("never re-reads `events` once handed an already-resolved event — a mid-build corruption of that row cannot reach it", () => {
      seedTeamWithRoster("Team G", []);
      seedTeamWithRoster("Team H", []);
      const { db, sqlite } = openDb();
      try {
        addEvent(db, {
          name: "Springfield Sectionals 2026",
          kind: "tournament",
          startsOn: "2026-08-28",
          endsOn: "2026-08-30",
          format: "S1:singles,D1:doubles",
        });
        const event = resolveEvent(db, "Springfield Sectionals 2026");

        // Fires at the START of the very first select this call performs — proving even the
        // earliest possible race against this row cannot matter, since nothing here reads it again.
        let selects = 0;
        const racingDb = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop !== "select") return Reflect.get(target, prop, receiver) as unknown;
            return (...args: unknown[]) => {
              selects += 1;
              if (selects === 1) {
                sqlite
                  .prepare("UPDATE events SET format = ? WHERE name = ?")
                  .run("not json at all", "Springfield Sectionals 2026");
              }
              return (target.select as (...a: unknown[]) => unknown)(...args);
            };
          },
        }) as typeof db;

        const written = writeSectionalsDossiers(racingDb, {
          window: evidenceWindow("2026-01-01"),
          event,
        });

        // Completed at all — a re-read would have thrown InvalidEventFormatError on the corrupted row.
        // Still 6: nobody is registered for this event, so the #124 field scope takes the all-teams
        // reading and both seeded teams are rendered, exactly as before that change.
        expect(written.files.length).toBe(6);
      } finally {
        sqlite.close();
      }
    });

    // The unknown-event refusal is no longer expressible AT this layer: `writeSectionalsDossiers`
    // takes an already-resolved `event?: ResolvedEvent`, never a name, so there is nothing left here
    // to resolve or refuse. The property itself (a bad name refuses before any dossier is prepared,
    // with nothing written) now lives at the command boundary — end to end in
    // `test/evidence-window.test.ts`'s "report build's anchor" describe and in
    // `test/cli-report-build-command.test.ts`'s "an unknown event name exits 1 and writes nothing".

    it("writes one dossier per team in the DB, plus a top-level index.html/index.md", () => {
      seedTeamWithRoster("Team E", []);
      seedTeamWithRoster("Team F", []);
      const { db, sqlite } = openDb();
      try {
        const written = writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") }).files;
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

    // #124. "Every team on file" was the only available reading of "the field" while nothing linked a
    // TEAM to an EVENT. `tn roster set` (#113) supplies that link in practice — a team with at least
    // one player registered for this event IS in this event's field — so the batch no longer renders
    // the whole database when an event names a real field. The Springfield case that motivated it:
    // 32 teams on file, 5 in the field, 66 files where 12 were wanted.
    it("scopes the field to teams with a player registered for the named event", () => {
      const inField = seedTeamWithRoster("Team In", ["Reg Istered"]);
      seedTeamWithRoster("Team Out", ["Un Registered"]);
      const { db, sqlite } = openDb();
      try {
        addEvent(db, {
          name: "Springfield Sectionals 2026",
          kind: "tournament",
          startsOn: "2026-08-28",
          endsOn: "2026-08-30",
          format: "S1:singles,D1:doubles",
        });
        const event = resolveEvent(db, "Springfield Sectionals 2026");
        sqlite
          .prepare("UPDATE team_memberships SET event_id = ? WHERE team_id = ?")
          .run(event.event.id, inField.id);

        const result = writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01"), event });

        // 1 team * 2 files + 2 top-level index files — NOT 6, which is what rendering both teams costs.
        expect(result.files.length).toBe(4);
        expect(result.teamCount).toBe(1);
        expect(result.fieldSource).toBe("registered");
        expect(result.files).toContain(join(reportsDir, "team-in", "index.html"));
        expect(result.files).not.toContain(join(reportsDir, "team-out", "index.html"));
        // The unregistered team must not merely be absent from the returned list — it must not be on
        // disk, and must not be linked from the index a captain navigates by.
        expect(existsSync(join(reportsDir, "team-out", "index.html"))).toBe(false);
        expect(readFileSync(join(reportsDir, "index.md"), "utf8")).not.toContain("Team Out");
      } finally {
        sqlite.close();
      }
    });

    // The fallback is REPORTED, never silent. An event nobody has registered for yet is the state
    // every event passes through, and emitting one dossier per team on file is the only useful answer
    // there — but a caller cannot distinguish that from a real 32-team field unless the batch says
    // which reading it used. `fieldSource` is what the command's summary prints.
    it("falls back to every team when the named event has no registered team, and says so", () => {
      seedTeamWithRoster("Team In", ["Reg Istered"]);
      seedTeamWithRoster("Team Out", ["Un Registered"]);
      const { db, sqlite } = openDb();
      try {
        addEvent(db, {
          name: "Springfield Sectionals 2026",
          kind: "tournament",
          startsOn: "2026-08-28",
          endsOn: "2026-08-30",
          format: "S1:singles,D1:doubles",
        });
        const event = resolveEvent(db, "Springfield Sectionals 2026");

        const result = writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01"), event });

        expect(result.files.length).toBe(6);
        expect(result.teamCount).toBe(2);
        expect(result.fieldSource).toBe("all-teams");
      } finally {
        sqlite.close();
      }
    });

    // Registration is scoped to THIS event, not to "any event". A team registered for a DIFFERENT
    // event says nothing about this one — the objection `writeSectionalsDossiers`' own doc comment
    // raised against deriving a field at all, and the reason the filter binds `event.event.id`
    // rather than testing `event_id IS NOT NULL`.
    it("ignores registrations belonging to a different event", () => {
      seedTeamWithRoster("Team In", ["Reg Istered"]);
      const otherTeam = seedTeamWithRoster("Team Out", ["Un Registered"]);
      const { db, sqlite } = openDb();
      try {
        addEvent(db, {
          name: "Springfield Sectionals 2026",
          kind: "tournament",
          startsOn: "2026-08-28",
          endsOn: "2026-08-30",
          format: "S1:singles,D1:doubles",
        });
        addEvent(db, {
          name: "Some Other Event",
          kind: "tournament",
          startsOn: "2026-09-28",
          endsOn: "2026-09-30",
          format: "S1:singles,D1:doubles",
        });
        const event = resolveEvent(db, "Springfield Sectionals 2026");
        const other = resolveEvent(db, "Some Other Event");
        sqlite
          .prepare("UPDATE team_memberships SET event_id = ? WHERE team_id = ?")
          .run(other.event.id, otherTeam.id);

        const result = writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01"), event });

        // Nobody is registered for Springfield, so this is the all-teams fallback — the OTHER event's
        // registration must not be mistaken for this event's field, which would silently render a
        // one-team field of the wrong team.
        expect(result.fieldSource).toBe("all-teams");
        expect(result.teamCount).toBe(2);
      } finally {
        sqlite.close();
      }
    });

    // Bare `report build` names no event, so there is no field to scope to and nothing to fall back
    // FROM — the reading is "every team on file" by construction, not by fallback.
    it("reports all-teams when no event is named at all", () => {
      seedTeamWithRoster("Team In", []);
      const { db, sqlite } = openDb();
      try {
        const result = writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") });
        expect(result.fieldSource).toBe("all-teams");
        expect(result.teamCount).toBe(1);
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
        const written = writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") }).files;
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
        writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") });
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
        const written = writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") }).files;
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
        expect(() => writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") })).toThrow(OutputPathError);
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
        expect(() => writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") })).toThrow(OutputPathError);
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

    // REGRESSION (Codex adversarial review, PR #38 round 3, Finding 3 [medium]). The round-2 fix
    // above stopped the FIRST team's two FILES from landing on disk, but `prepareTeamDossierWrite`
    // still calls `mkdirSync(dir, { recursive: true })` for EVERY team as part of validating it — so
    // Team First's now-empty DIRECTORY is still created and left behind the moment Team First's own
    // prepare step runs, well before Team Second's symlinked leaf is ever discovered. The round-2
    // tests only ever asserted files were absent, so they passed while this directory-level leak
    // shipped unnoticed for a whole review round. Directory creation belongs in the COMMIT phase
    // (after every leaf in the batch has already been validated), not the prepare/validation phase.
    it("REGRESSION: a symlinked leaf on the SECOND team must not leave the FIRST team's now-empty DIRECTORY behind either", () => {
      const teamOne = seedTeamWithRoster("Team Third", []);
      const teamTwo = seedTeamWithRoster("Team Fourth", []);
      const dirTwo = join(reportsDir, teamSlug(teamTwo.id, "Team Fourth"));
      mkdirSync(dirTwo, { recursive: true });
      const escapeTarget = mkdtempSync(join(tmpdir(), "tn-escape-"));
      const linkTarget = join(escapeTarget, "leaked.md");
      symlinkSync(linkTarget, join(dirTwo, "index.md"));
      const { db, sqlite } = openDb();
      try {
        expect(() => writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") })).toThrow(OutputPathError);
        const dirOne = join(reportsDir, teamSlug(teamOne.id, "Team Third"));
        // The stronger assertion round 2 was missing: not just "no files inside dirOne", but "dirOne
        // itself was never created" — prepare must not mutate the filesystem at all.
        expect(existsSync(dirOne)).toBe(false);
      } finally {
        sqlite.close();
        rmSync(escapeTarget, { recursive: true, force: true });
      }
    });

    // REGRESSION (Codex adversarial review, PR #38 round 3, Finding 3 [medium]), the top-level-index
    // companion to the test above: a refusal triggered by the TOP-LEVEL index pair must not leave any
    // team's per-team directory behind either, even though that team's own leaves were perfectly fine
    // and would have been written without issue if the batch had gone on to commit.
    it("REGRESSION: a symlinked top-level index.md must not leave any team's per-team DIRECTORY behind either", () => {
      seedTeamWithRoster("Team Fifth", []);
      mkdirSync(reportsDir, { recursive: true });
      const escapeTarget = mkdtempSync(join(tmpdir(), "tn-escape-"));
      const linkTarget = join(escapeTarget, "leaked-index.md");
      symlinkSync(linkTarget, join(reportsDir, "index.md"));
      const { db, sqlite } = openDb();
      try {
        expect(() => writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") })).toThrow(OutputPathError);
        expect(existsSync(join(reportsDir, "team-fifth"))).toBe(false);
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
        batchWritten = writeSectionalsDossiers(batch.db, { window: evidenceWindow("2026-01-01") }).files;
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
        singleWritten = writeTeamDossier(single.db, teamTwo.id, { window: evidenceWindow("2026-01-01") }).files;
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
        const written = writeSectionalsDossiers(db, { window: evidenceWindow("2026-01-01") }).files;
        expect(written.length).toBe(2);
      } finally {
        sqlite.close();
      }
    });
  });
});
