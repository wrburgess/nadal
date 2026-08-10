// The home-team race in `buildTeamDossier`, pinned properly (#126, Codex adversarial review of
// PR #134 — round 1 found the defect, round 2 found that my first attempt at this test did not
// actually pin it).
//
// What round 2 caught: the original regression test was named "even if the home team changes
// mid-assembly" and never changed the home team. It asserted `ownTeam !== null` equals
// `team.isHome`, which is trivially true whenever nothing moves — so it passed against the PRE-FIX
// code it was written to guard. `rules/testing.md`: never let a check's title or comment claim
// coverage the code does not enforce.
//
// This file lives apart from `report-write.test.ts` because the mock below is module-wide, and the
// rest of that suite must keep exercising the real `resolveHomeTeam`.
//
// The mock is the only honest way to make the interleaving deterministic: the race is between two
// reads inside ONE synchronous call, so no amount of fixture setup can land a write between them.
// Making `resolveHomeTeam` answer differently on its second call reproduces exactly the state a
// concurrent `tn team home` produces, without a real second process.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveHomeTeamMock = vi.fn();

vi.mock("../src/query/home-team.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/query/home-team.js")>();
  return { ...actual, resolveHomeTeam: resolveHomeTeamMock };
});

const { evidenceWindow } = await import("../src/cli/window.js");
const { openDb, runMigrations } = await import("../src/db/client.js");
const { players, teamMemberships, teams } = await import("../src/db/schema.js");
const { buildTeamDossier } = await import("../src/report/write.js");
const { useTnDbPath } = await import("./helpers/tn-db.js");

describe("buildTeamDossier — the home team changing mid-assembly", () => {
  useTnDbPath();

  beforeEach(() => {
    resolveHomeTeamMock.mockReset();
  });

  it("ownTeam and team.isHome agree even when the designation flips between the two reads", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const ours = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
      const theirs = db.insert(teams).values({ name: "OK/Dickason/40&over3.5M" }).returning().get();
      const p = db.insert(players).values({ canonicalName: "Nova Norbury" }).returning().get();
      db.insert(teamMemberships).values({ playerId: p.id, teamId: ours.id, eventId: null }).run();

      // THE RACE, deterministically: `buildTeamDossier` reads at write.ts:185 and gets OUR team;
      // a concurrent `tn team home` then moves the flag, so any LATER read sees theirs. Before the
      // fix, `getTeamProfile` performed exactly such a later read for `isHome`.
      resolveHomeTeamMock
        .mockReturnValueOnce({ id: ours.id, name: ours.name })
        .mockReturnValue({ id: theirs.id, name: theirs.name });

      const dossier = buildTeamDossier(db, ours.id, { window: evidenceWindow("2026-01-01") });

      // Pre-fix this was `true` vs `false`: a dossier carrying the Own-team book whose prior-meetings
      // section simultaneously reported that no home team was configured (the #19 defect).
      expect(dossier.ownTeam).not.toBeNull();
      expect(dossier.team.isHome).toBe(true);
      expect(dossier.ownTeam !== null).toBe(dossier.team.isHome);
    } finally {
      sqlite.close();
    }
  });

  it("an opponent dossier stays an opponent dossier even if we become home mid-assembly", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const ours = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
      const theirs = db.insert(teams).values({ name: "OK/Dickason/40&over3.5M" }).returning().get();
      const p = db.insert(players).values({ canonicalName: "Cy Calder" }).returning().get();
      db.insert(teamMemberships).values({ playerId: p.id, teamId: theirs.id, eventId: null }).run();

      // The inverse interleaving: read 1 says OUR team is home (so `theirs` is an opponent), then
      // the flag moves to `theirs`. A later read would call `theirs` home and hand an opponent a book.
      resolveHomeTeamMock
        .mockReturnValueOnce({ id: ours.id, name: ours.name })
        .mockReturnValue({ id: theirs.id, name: theirs.name });

      const dossier = buildTeamDossier(db, theirs.id, { window: evidenceWindow("2026-01-01") });

      expect(dossier.ownTeam).toBeNull();
      expect(dossier.team.isHome).toBe(false);
      expect(dossier.ownTeam !== null).toBe(dossier.team.isHome);
    } finally {
      sqlite.close();
    }
  });

  it("with no home team at all, the null answer is not re-read into a different one", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const team = db.insert(teams).values({ name: "Nobody Home" }).returning().get();
      const p = db.insert(players).values({ canonicalName: "Cy Calder" }).returning().get();
      db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();

      // The `null` half of the `homeTeamId` contract: read 1 answers "there is no home team", and a
      // designation lands immediately after. `null` must be carried as an ANSWER, not treated as
      // "not supplied" and re-resolved — which is the fail-open branch round 2's lens asked about.
      resolveHomeTeamMock.mockReturnValueOnce(null).mockReturnValue({ id: team.id, name: team.name });

      const dossier = buildTeamDossier(db, team.id, { window: evidenceWindow("2026-01-01") });

      expect(dossier.ownTeam).toBeNull();
      expect(dossier.team.isHome).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
