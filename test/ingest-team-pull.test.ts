import { describe, expect, it, vi } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { hrefParam } from "../src/parsers/dom.js";
import { matchHistoryUrlFor } from "../src/ingest/player-pull.js";
import { pullTeam } from "../src/ingest/team-pull.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
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
