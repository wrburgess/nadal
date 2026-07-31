import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { hrefParam } from "../src/parsers/dom.js";
import { matchHistoryUrlFor } from "../src/ingest/player-pull.js";
import { pullTeam } from "../src/ingest/team-pull.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
import { removeAllRosterRows, removeRosterRow } from "./helpers/roster-html.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const team = loadFixture("tennisrecord/team");

const ROSTER_NAMES = [
  "Ellis Eastwick",
  "EMORY ELLERBY",
  "Ira Inglewood",
  "Yuma Yarrowby",
  "Hollis Hartwell",
  "Kai Kestrel",
  "Blake Bramwell",
  "Lane Linfield",
  "Casey Calder",
  "Orin Oakhurst",
  "Marek Melbourne",
  "Rowan Rushworth",
  "Nova Norbury",
  "Avery Ashby",
  "Zephyr Zellman",
  "Harper Halloway",
  "Juniper Jarrow",
  "Delaney Duxbury",
];

function syntheticEmptyMatchHistory(name: string): string {
  return `<html><body>
    <table>
      <tr>
        <td><a class="link" href="/adult/profile.aspx?playername=${name}">${name}</a> (Somewhere, ZZ)<br><span>Male</span></td>
        <td>4.0 C<br>12/31/2025</td>
      </tr>
      <tr>
        <td>Estimated Dynamic Rating</td>
        <td>4.0<br>01/01/2026</td>
      </tr>
    </table>
    <div class="large">
      <table>
        <tr>
          <th>Match Date</th><th>League</th><th>Team</th><th>Court</th><th>Partner</th>
          <th>Opponent(s)</th><th>W/L</th><th>Result</th><th>Match</th><th>Rating</th>
        </tr>
      </table>
    </div>
  </body></html>`;
}

function buildFetcher(names = ROSTER_NAMES) {
  const year = hrefParam(team.source.url, "year") ?? "2026";
  const fixtures: Record<string, { body: string }> = { [team.source.url]: { body: team.html } };
  for (const name of names) {
    fixtures[matchHistoryUrlFor(name, year)] = { body: syntheticEmptyMatchHistory(name) };
  }
  return { fetcher: createStubFetcher(fixtures), year };
}


describe("pullTeam", () => {
  useTnDbPath();
  // Without this, a pull archives its pages into the repo own raw/ on every test run.
  useTnRawPath();

  it("writes the team, every roster membership, and every schedule row as a team_match with its source_match_id", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const { fetcher } = buildFetcher();
      const result = await pullTeam({ db, fetchPage: fetcher, target: team.source.url });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.rosterCount).toBe(18);
      expect(result.matchCount).toBe(10);

      // The primary team plus one row per distinct opponent named in its 10-row local schedule
      // (resolveTeam creates a stub team for each — the schedule's only source of that identity).
      const teamRows = db.select().from(teams).all();
      expect(teamRows).toHaveLength(11);
      const primary = teamRows.find((t) => t.name === "Norbury, Nova");
      expect(primary?.tennisrecordUrl).toBe(team.source.url);

      const memberships = db.select().from(teamMemberships).all();
      expect(memberships).toHaveLength(18);

      const matches = db.select().from(teamMatches).all();
      expect(matches).toHaveLength(10);
      const bySourceId = new Map(matches.map((m) => [m.sourceMatchId, m]));
      expect(bySourceId.get("181505")).toMatchObject({
        playedOn: "2026-04-09",
        homeCourtsWon: 3,
        visitingCourtsWon: 2,
      });
      expect(bySourceId.get("181556")).toMatchObject({
        playedOn: "2026-06-18",
        homeCourtsWon: 3,
        visitingCourtsWon: 2,
      });
    } finally {
      sqlite.close();
    }
  });

  it("--players cascades exactly one fetch per roster profile link, each exactly once", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const { fetcher, year } = buildFetcher();
      const result = await pullTeam({ db, fetchPage: fetcher, target: team.source.url, cascadePlayers: true });

      expect(result.kind).toBe("ok");
      // One call for the team page, plus one per roster entry.
      expect(fetcher.calls).toHaveLength(1 + ROSTER_NAMES.length);
      expect(fetcher.calls[0]).toBe(team.source.url);

      const expectedCascadeUrls = ROSTER_NAMES.map((name) => matchHistoryUrlFor(name, year));
      const actualCascadeUrls = fetcher.calls.slice(1);
      expect(actualCascadeUrls.sort()).toEqual(expectedCascadeUrls.sort());
      // Exactly once each — no duplicates.
      expect(new Set(actualCascadeUrls).size).toBe(actualCascadeUrls.length);
    } finally {
      sqlite.close();
    }
  });

  // Found by the independent Codex review of PR #47 (rated medium). `entry.name` is parsed from a
  // fetched roster page and went straight into `console.warn` — a raw stderr write with no summary
  // formatter in front of it, so ANSI, bidi and line controls bypassed the terminal-boundary guard
  // every other CLI output path has.
  it("sanitizes a hostile roster entry name before warning about it", async () => {
    const RTL_OVERRIDE = String.fromCharCode(0x202e);
    const ESC = String.fromCharCode(0x1b);
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // Same shape as the skip case below — a roster entry whose profile link is missing — but with
      // a name the source page could genuinely carry.
      const hostileName = `Ellis${RTL_OVERRIDE}${ESC}[2J Eastwick`;
      const mutated = team.html.replace(
        '<a class="link" href="/adult/profile.aspx?playername=Ellis Eastwick">Ellis Eastwick</a>',
        hostileName,
      );
      expect(mutated).not.toBe(team.html);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const stubFetcher = createStubFetcher({
        [team.source.url]: { body: mutated },
        ...Object.fromEntries(
          ROSTER_NAMES.filter((n) => n !== "Ellis Eastwick").map((name) => [
            matchHistoryUrlFor(name, hrefParam(team.source.url, "year") ?? "2026"),
            { body: syntheticEmptyMatchHistory(name) },
          ]),
        ),
      });

      await pullTeam({ db, fetchPage: stubFetcher, target: team.source.url, cascadePlayers: true });

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned, "a roster page must not be able to write control codes to stderr").not.toContain(ESC);
      expect(warned).not.toContain(RTL_OVERRIDE);
      // Still names the entry, so the warning stays actionable.
      expect(warned).toContain("Ellis");

      warnSpy.mockRestore();
    } finally {
      sqlite.close();
    }
  });

  it("skips a roster entry with no profile link (warns, non-fatal) instead of crashing or silently dropping the player", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const mutated = team.html.replace(
        '<a class="link" href="/adult/profile.aspx?playername=Ellis Eastwick">Ellis Eastwick</a>',
        "Ellis Eastwick",
      );
      expect(mutated).not.toBe(team.html);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const stubFetcher = createStubFetcher({
        [team.source.url]: { body: mutated },
        ...Object.fromEntries(
          ROSTER_NAMES.filter((n) => n !== "Ellis Eastwick").map((name) => [
            matchHistoryUrlFor(name, hrefParam(team.source.url, "year") ?? "2026"),
            { body: syntheticEmptyMatchHistory(name) },
          ]),
        ),
      });

      const result = await pullTeam({ db, fetchPage: stubFetcher, target: team.source.url, cascadePlayers: true });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.skippedRosterEntries).toEqual(["Ellis Eastwick"]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Ellis Eastwick"));

      // The player still exists — the roster membership isn't crashed or silently dropped, only
      // the enrichment cascade for it is skipped.
      const memberships = db.select().from(teamMemberships).all();
      expect(memberships).toHaveLength(18);

      warnSpy.mockRestore();
    } finally {
      sqlite.close();
    }
  });
});

// Issue #49, Task 3: the reconcile against the just-parsed roster, run inside `pullTeam`'s existing
// transaction. `removeRosterRow`/`removeAllRosterRows` above synthesize a changed roster page
// without a second captured fixture.
describe("pullTeam roster retirement (issue #49)", () => {
  useTnDbPath();
  useTnRawPath();

  it("a member absent from a re-pulled roster is retired; the other 17 are untouched; retiredCount reports it", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const first = await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: team.html } }),
        target: team.source.url,
      });
      expect(first.kind).toBe("ok");
      if (first.kind !== "ok") throw new Error("expected ok");
      expect(first.retiredCount).toBe(0);

      const withoutEllis = removeRosterRow(team.html, "Ellis Eastwick");
      expect(withoutEllis).not.toBe(team.html);
      const second = await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: withoutEllis } }),
        target: team.source.url,
      });

      expect(second.kind).toBe("ok");
      if (second.kind !== "ok") throw new Error("expected ok");
      expect(second.rosterCount).toBe(17);
      expect(second.retiredCount).toBe(1);

      // Soft-retire: no row is deleted. Still 18 membership rows, one of them now retired.
      const memberships = db.select().from(teamMemberships).all();
      expect(memberships).toHaveLength(18);
      const ellis = db.select().from(players).where(eq(players.canonicalName, "Ellis Eastwick")).all()[0]!;
      const ellisMembership = memberships.find((m) => m.playerId === ellis.id)!;
      expect(ellisMembership.retiredAt).not.toBeNull();
      const others = memberships.filter((m) => m.playerId !== ellis.id);
      expect(others.every((m) => m.retiredAt === null), "the other 17 are untouched").toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("a member who returns to the roster after being absent is un-retired, and remains one row", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: team.html } }),
        target: team.source.url,
      });
      const withoutEllis = removeRosterRow(team.html, "Ellis Eastwick");
      await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: withoutEllis } }),
        target: team.source.url,
      });

      const restored = await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: team.html } }),
        target: team.source.url,
      });

      expect(restored.kind).toBe("ok");
      if (restored.kind !== "ok") throw new Error("expected ok");
      expect(restored.retiredCount).toBe(0);

      const ellis = db.select().from(players).where(eq(players.canonicalName, "Ellis Eastwick")).all()[0]!;
      const ellisRows = db.select().from(teamMemberships).where(eq(teamMemberships.playerId, ellis.id)).all();
      expect(ellisRows, "still one row, never a second one created by the un-retire").toHaveLength(1);
      expect(ellisRows[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("a pull whose parse yields a zero-length roster retires nobody (the empty-observed-set guard, at the integration level)", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: team.html } }),
        target: team.source.url,
      });
      const before = db.select().from(teamMemberships).all();
      expect(before).toHaveLength(18);

      const emptyRoster = removeAllRosterRows(team.html, ROSTER_NAMES);
      const result = await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: emptyRoster } }),
        target: team.source.url,
      });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.rosterCount).toBe(0);
      expect(result.retiredCount, "an empty observed roster must not read as 'everyone left'").toBe(0);

      const after = db.select().from(teamMemberships).all();
      expect(after).toEqual(before);
    } finally {
      sqlite.close();
    }
  });

  it("a pull that aborts on an ambiguous roster entry mid-loop leaves memberships EXACTLY as they were", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const first = await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: team.html } }),
        target: team.source.url,
      });
      expect(first.kind).toBe("ok");
      const before = db.select().from(teamMemberships).all();
      expect(before).toHaveLength(18);

      // "Yuma Yarrowby" (the 4th of 18 — mid-loop, not first) is respelled to a name one edit away
      // from the ALREADY-ON-FILE "Yuma Yarrowby" — not an exact match (tier 2 misses), but fuzzy-
      // close enough that resolvePlayer's tier 3 refuses to guess and returns ambiguous, aborting
      // the whole transaction. The three roster entries processed before it in loop order
      // (Ellis/Emory/Ira) must not "stick" either, and — the regression this test exists for —
      // `retireAbsentMemberships` (which runs AFTER the roster loop, still inside the transaction)
      // must never be reached at all, so none of the OTHER 17 pre-existing memberships are retired
      // on the strength of a partial, aborted roster.
      const mutated = team.html.replace(
        '<a class="link" href="/adult/profile.aspx?playername=Yuma Yarrowby">Yuma Yarrowby</a>',
        '<a class="link" href="/adult/profile.aspx?playername=Yuma Yarrowbyy">Yuma Yarrowbyy</a>',
      );
      expect(mutated).not.toBe(team.html);

      const result = await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: mutated } }),
        target: team.source.url,
      });

      expect(result.kind).toBe("ambiguous");
      const after = db.select().from(teamMemberships).all();
      expect(after).toEqual(before);
    } finally {
      sqlite.close();
    }
  });
});
