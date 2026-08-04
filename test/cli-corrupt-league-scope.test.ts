// #97, found by the AC's own verify pass on PR #99 before the external review reported.
//
// `resolveEvent` gained a SECOND fail-closed decoder (`readLeagueScope`) alongside the existing
// `readEventFormat`, so every command that resolves a named event can now throw a refusal class it
// could not throw before. Two CLI commands classify refusals by an explicit `instanceof` list, and
// neither list knew about the new class — so a corrupted `events.league_scope` exited 1 with
// **nothing printed at all**: no `status=error` line, no message, not even a stack trace. That is
// worse than the crash the contract forbids, because a silent nonzero exit reads as "it did nothing"
// rather than "it refused, here is why".
//
// The class, stated so the next column inherits the lesson rather than the bug: **a new decoder on a
// shared resolve path is a new refusal class, and every caller that classifies refusals by an
// explicit list is silently incomplete until it is added.** The concurrency half of this was already
// written down for the same commit (one read, two columns); the refusal half was not.
//
// Each case below is paired with its `format` twin, which was ALREADY handled — so the assertion is
// "these two behave the same", not "this one prints something". A test that only pinned the new
// column could pass against a diagnostic that disagreed with its sibling's.

import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { addEvent } from "../src/query/events.js";
import { useTnDbPath } from "./helpers/tn-db.js";

const EVENT = {
  name: "Springfield Sectionals",
  kind: "tournament",
  startsOn: "2026-08-28",
  endsOn: "2026-08-30",
  format: "S1:singles,D1:doubles",
};

/** A team with real, own-team court history, so `lineup plan` reaches the event resolution rather
 * than refusing earlier for "no court-match history" — otherwise this whole file would assert the
 * wrong refusal and pass. */
function seed(): void {
  runMigrations();
  const { db, sqlite } = openDb();
  const team = db.insert(teams).values({ name: "IA/Versteeg/40&Over3.5M" }).returning().get();
  const opponent = db.insert(teams).values({ name: "Opponent" }).returning().get();
  const ada = db.insert(players).values({ canonicalName: "Ada Ashby" }).returning().get();
  db.insert(teamMemberships).values({ playerId: ada.id, teamId: team.id, eventId: null }).run();
  backfillNameKeys(db);
  const tm = db
    .insert(teamMatches)
    .values({ homeTeamId: team.id, visitingTeamId: opponent.id, sourceMatchId: "own-1" })
    .returning()
    .get();
  const cm = upsertCourtMatch(db, {
    teamMatchId: tm.id,
    slot: "S1",
    discipline: "singles",
    winnerSide: "home",
    score: "6-3 6-4",
    leagueContext: "Adult 40+ 3.5",
    playedOn: "2026-05-01",
    sourceMatchId: "own-court-1",
  });
  upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: ada.id, side: "home" });
  addEvent(db, EVENT);
  sqlite.close();
}

/** Hand-corrupts one structured column — the case both fail-closed decoders exist for. Only
 * `addEvent` writes these in production, but SQLite enforces no shape on a text column. */
function corrupt(column: "format" | "league_scope"): void {
  const { sqlite } = openDb();
  sqlite.prepare(`UPDATE events SET ${column} = 'not json at all'`).run();
  sqlite.close();
}

describe("a corrupted structured column on a named event refuses with a DIAGNOSTIC, never in silence", () => {
  useTnDbPath("corrupt.db");

  // One case per (command, column) pair, NOT a loop inside one case: `useTnDbPath` gives each TEST
  // its own database, so two seeds in one body collide on `teams.name` — which is how the first
  // draft of this file failed, red for its own bug rather than for the defect.
  //
  // The `format` rows are the control. They already behaved correctly before this fix, so they are
  // what turns "the new column prints something" into "the new column prints the same KIND of thing
  // its sibling does" — a weaker assertion would pass against a diagnostic that disagreed with the
  // one beside it.
  it.each([
    ["report build", ["report", "build", "sectionals", EVENT.name], "format"],
    ["report build", ["report", "build", "sectionals", EVENT.name], "league_scope"],
    ["lineup plan", ["lineup", "plan", "IA/Versteeg/40&Over3.5M", EVENT.name], "format"],
    ["lineup plan", ["lineup", "plan", "IA/Versteeg/40&Over3.5M", EVENT.name], "league_scope"],
  ] as const)("%s refuses a corrupt %s with a diagnostic", async (command, argv, column) => {
    seed();
    corrupt(column);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch([...argv]);

    expect(code).toBe(1);
    // The load-bearing assertion. Before the fix, the `league_scope` cases exited 1 having printed
    // NOTHING AT ALL — `errSpy` was never called once.
    expect(errSpy, `${command} / ${column} must print a diagnostic`).toHaveBeenCalledTimes(1);
    const message = errSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain(`${command} status=error`);
    expect(message).toContain("not valid JSON");
    // And it names WHICH column, so an operator holding a hand-edited database knows what to
    // re-record — the two messages must not be interchangeable.
    expect(message).toContain(column === "format" ? "stored event format" : "stored league scope");
  });
});
