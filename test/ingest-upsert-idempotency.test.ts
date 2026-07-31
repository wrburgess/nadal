import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import {
  courtMatchPlayers,
  courtMatches,
  ratingObservations,
  teamMatches,
  teamMemberships,
  teams,
} from "../src/db/schema.js";
import { hrefParam } from "../src/parsers/dom.js";
import { resolvePlayer } from "../src/ingest/identity.js";
import { matchHistoryUrlFor } from "../src/ingest/player-pull.js";
import { pullTeam } from "../src/ingest/team-pull.js";
import {
  normalizeSiteKey,
  normalizeTimeKey,
  upsertCourtMatch,
  upsertRatingObservation,
  upsertTeam,
  upsertTeamMatch,
} from "../src/ingest/upsert.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const team = loadFixture("tennisrecord/team");
const matchHistory = loadFixture("tennisrecord/match-history");

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

/** A minimal, structurally valid TennisRecord match-history page for a given player, with zero
 * matches — enough for parseTennisRecordHeader + parseMatchHistory to succeed without throwing,
 * so every roster entry's `--players` cascade resolves to ITS OWN distinct player identity rather
 * than colliding on a shared name. */
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

function buildFetcher() {
  const year = hrefParam(team.source.url, "year") ?? "2026";
  const fixtures: Record<string, { body: string }> = {
    [team.source.url]: { body: team.html },
  };
  for (const name of ROSTER_NAMES) {
    const url = matchHistoryUrlFor(name, year);
    fixtures[url] = name === "Avery Ashby" ? { body: matchHistory.html } : { body: syntheticEmptyMatchHistory(name) };
  }
  return createStubFetcher(fixtures);
}

describe("upsert idempotency — the headline test", () => {
  useTnDbPath();
  // Without this, a pull archives its pages into the repo own raw/ on every test run.
  useTnRawPath();

  it("running team pull twice through the stub fetcher leaves identical rows, and updates a changed rating in place", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const fetcher1 = buildFetcher();
      const first = await pullTeam({
        db,
        fetchPage: fetcher1,
        target: team.source.url,
        cascadePlayers: true,
      });
      expect(first.kind).toBe("ok");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshot = (table: any) => db.select().from(table).all();

      const teamsAfterFirst = snapshot(teams);
      const membershipsAfterFirst = snapshot(teamMemberships);
      const teamMatchesAfterFirst = snapshot(teamMatches);
      const courtMatchesAfterFirst = snapshot(courtMatches);
      const courtMatchPlayersAfterFirst = snapshot(courtMatchPlayers);
      const ratingObservationsAfterFirst = snapshot(ratingObservations);

      expect(teamMatchesAfterFirst).toHaveLength(10);
      expect(courtMatchesAfterFirst).toHaveLength(14);
      expect(ratingObservationsAfterFirst.length).toBeGreaterThan(0);

      const fetcher2 = buildFetcher();
      const second = await pullTeam({
        db,
        fetchPage: fetcher2,
        target: team.source.url,
        cascadePlayers: true,
      });
      expect(second.kind).toBe("ok");

      expect(snapshot(teams)).toEqual(teamsAfterFirst);
      expect(snapshot(teamMemberships)).toEqual(membershipsAfterFirst);
      expect(snapshot(teamMatches)).toEqual(teamMatchesAfterFirst);
      expect(snapshot(courtMatches)).toEqual(courtMatchesAfterFirst);
      expect(snapshot(courtMatchPlayers)).toEqual(courtMatchPlayersAfterFirst);
      expect(snapshot(ratingObservations)).toEqual(ratingObservationsAfterFirst);
    } finally {
      sqlite.close();
    }
  });

  it("a changed dynamic rating on a second pass updates the SAME rating_observations row in place, not a second one", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const resolved = resolvePlayer(db, { name: "Some Player" });
      if (resolved.kind === "ambiguous") throw new Error("unexpected ambiguous");

      upsertRatingObservation(db, {
        playerId: resolved.row.id,
        source: "tr_dynamic",
        value: 4.0,
        ratingType: null,
        observedOn: "2026-05-01",
      });
      upsertRatingObservation(db, {
        playerId: resolved.row.id,
        source: "tr_dynamic",
        value: 4.2,
        ratingType: null,
        observedOn: "2026-05-01",
      });

      const rows = db.select().from(ratingObservations).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value).toBe(4.2);
    } finally {
      sqlite.close();
    }
  });

  it("EDGE: a team_matches row with a NULL source_match_id does not collide with another NULL row", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const teamRow = upsertTeam(db, { name: "Solo Team" });
      upsertTeamMatch(db, {
        eventId: null,
        homeTeamId: teamRow.id,
        visitingTeamId: teamRow.id,
        playedOn: "2026-01-01",
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });
      upsertTeamMatch(db, {
        eventId: null,
        homeTeamId: teamRow.id,
        visitingTeamId: teamRow.id,
        playedOn: "2026-01-08",
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });

      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  // REGRESSION. The committed team fixture is an end-of-season page where every schedule row has a
  // result link, so every row carries a `mid=` and the partial unique index deduplicates it. An
  // UNPLAYED fixture has no result link and therefore no `mid=` — and that row took a plain-insert
  // path, so re-pulling a mid-season team page grew one duplicate row per unplayed fixture, on
  // every pull. The suite was green because no fixture exercised the case.
  it("REGRESSION: re-pulling a page with an unplayed fixture (no result link) does not duplicate its team_match", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const withUnplayedFixture = team.html.replace(
        '<a class="link" href="/adult/matchresults.aspx?year=2026&mid=181505">3-2</a>',
        "",
      );
      expect(withUnplayedFixture).not.toBe(team.html);
      const fetchPage = createStubFetcher({ [team.source.url]: { body: withUnplayedFixture } });

      const first = await pullTeam({ db, fetchPage, target: team.source.url });
      expect(first.kind).toBe("ok");
      const afterFirst = db.select().from(teamMatches).all();
      expect(afterFirst).toHaveLength(10);
      expect(afterFirst.filter((r) => r.sourceMatchId === null)).toHaveLength(1);

      const second = await pullTeam({ db, fetchPage, target: team.source.url });
      expect(second.kind).toBe("ok");
      expect(db.select().from(teamMatches).all()).toEqual(afterFirst);
    } finally {
      sqlite.close();
    }
  });

  // REGRESSION. `mid=` present but EMPTY is as unusable an idempotency key as an absent one, and
  // the partial index treats "" as non-null — so every empty-id row would have collapsed into a
  // single team_match. `match-history.ts` already made this argument for its own rows (Codex round
  // 7 on PR #26); the schedule parser had not.
  it("REGRESSION: an empty mid= is normalized to null, so two such rows stay distinct", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const emptyMid = team.html.replace(/mid=18150[58]/g, "mid=");
      expect(emptyMid).not.toBe(team.html);
      const fetchPage = createStubFetcher({ [team.source.url]: { body: emptyMid } });

      expect((await pullTeam({ db, fetchPage, target: team.source.url })).kind).toBe("ok");
      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(10);
      expect(rows.filter((r) => r.sourceMatchId === null)).toHaveLength(2);
      expect(rows.filter((r) => r.sourceMatchId === "")).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  // REGRESSION. A TennisRecord pull knows nothing about `tennislink_url` and passes `district:
  // null` unconditionally. Writing `values.x ?? null` across the conflict `set` meant every
  // re-pull silently erased whatever another source had recorded there — latent today, live the
  // moment #27 lands.
  it("REGRESSION: re-upserting a team from a source that lacks a column preserves the stored value", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      upsertTeam(db, {
        name: "Norbury, Nova",
        section: "Missouri Valley",
        district: "Iowa",
        tennislinkUrl: "https://tennislink.usta.com/team/1",
      });
      const after = upsertTeam(db, { name: "Norbury, Nova", tennisrecordUrl: "https://tr/team" });

      expect(after.tennislinkUrl).toBe("https://tennislink.usta.com/team/1");
      expect(after.district).toBe("Iowa");
      expect(after.section).toBe("Missouri Valley");
      expect(after.tennisrecordUrl).toBe("https://tr/team");
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("a court match with no source id is deduped on its natural composite rather than re-inserted", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const row = { teamMatchId: null, slot: "D1", discipline: "doubles", winnerSide: null, score: "6-3 6-4", leagueContext: "40+ 4.0", playedOn: "2026-03-01", sourceMatchId: null };
      upsertCourtMatch(db, row);
      upsertCourtMatch(db, { ...row, score: "6-3 6-2" });

      const rows = db.select().from(courtMatches).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.score).toBe("6-3 6-2");
    } finally {
      sqlite.close();
    }
  });
});

// Codex adversarial review, PR #31 [high]: ordered (home, visiting, date) is not an identity for an
// id-less fixture, because team-pull assigns the PULLED team to `home`. The first fix reproduced the
// very defect it was closing, one perspective over.
describe("id-less team matches across opposing perspectives", () => {
  useTnDbPath();
  useTnRawPath();

  it("REGRESSION: the same unplayed fixture pulled from BOTH teams' pages stays one row", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const base = { eventId: null, playedOn: "2026-06-01", sourceMatchId: null };

      // From A's page: A is home. From B's page: B is home. Same fixture.
      upsertTeamMatch(db, { ...base, homeTeamId: a.id, visitingTeamId: b.id, homeCourtsWon: null, visitingCourtsWon: null });
      upsertTeamMatch(db, { ...base, homeTeamId: b.id, visitingTeamId: a.id, homeCourtsWon: null, visitingCourtsWon: null });

      expect(db.select().from(teamMatches).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("court counts arriving from the opposite perspective are stored in the STORED row's orientation", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const base = { eventId: null, playedOn: "2026-06-08", sourceMatchId: null };

      // A's page: A won 3-2. Stored with A as home.
      upsertTeamMatch(db, { ...base, homeTeamId: a.id, visitingTeamId: b.id, homeCourtsWon: 3, visitingCourtsWon: 2 });
      // B's page describes the same fixture as B 2, A 3 — from B's perspective B is home.
      upsertTeamMatch(db, { ...base, homeTeamId: b.id, visitingTeamId: a.id, homeCourtsWon: 2, visitingCourtsWon: 3 });

      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(1);
      // Still oriented to the stored row (A home), NOT silently inverted by the second write.
      expect(rows[0]?.homeTeamId).toBe(a.id);
      expect(rows[0]?.homeCourtsWon).toBe(3);
      expect(rows[0]?.visitingCourtsWon).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});

// Codex adversarial review, PR #31 round 2 [high]: the unordered-pair key fixed the duplicate but
// over-merged — date alone cannot tell two same-day fixtures apart, and the pipeline was discarding
// the schedule's Time and Match Site columns that could.
describe("id-less team matches — same-day doubleheader", () => {
  useTnDbPath();
  useTnRawPath();

  it("REGRESSION: two id-less fixtures for the same pair on the same DAY stay two rows", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const base = {
        eventId: null,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        playedOn: "2026-06-01",
        site: "Westside Courts",
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      };

      upsertTeamMatch(db, { ...base, scheduledTime: "9:00 AM" });
      upsertTeamMatch(db, { ...base, scheduledTime: "5:00 PM" });

      expect(db.select().from(teamMatches).all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("the SAME fixture re-pulled (same day, time and site) is still one row", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const row = {
        eventId: null,
        playedOn: "2026-06-01",
        scheduledTime: "9:00 AM",
        site: "Westside Courts",
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      };

      upsertTeamMatch(db, { ...row, homeTeamId: a.id, visitingTeamId: b.id });
      upsertTeamMatch(db, { ...row, homeTeamId: a.id, visitingTeamId: b.id });
      // ...and still one when the same fixture arrives from the opposing team's page.
      upsertTeamMatch(db, { ...row, homeTeamId: b.id, visitingTeamId: a.id });

      expect(db.select().from(teamMatches).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});

// Codex adversarial review, PR #31 round 3 [high]: comparing time and site as exact strings made the
// id-less key FORMAT-sensitive — the same fixture re-rendered as "09:00 AM" missed its stored row and
// duplicated, breaking re-pull idempotency for exactly the rows with no mid= to fall back on.
describe("id-less team matches — equivalent time/site formatting", () => {
  useTnDbPath();
  useTnRawPath();

  it("REGRESSION: a re-pull rendering the same time differently does NOT duplicate", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const base = {
        eventId: null,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        playedOn: "2026-06-01",
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      };

      upsertTeamMatch(db, { ...base, scheduledTime: "9:00 AM", site: "Clayview Country Club" });
      upsertTeamMatch(db, { ...base, scheduledTime: "09:00 AM", site: "Clayview Country Club" });
      upsertTeamMatch(db, { ...base, scheduledTime: "9:00am", site: "Clayview  Country-Club" });

      expect(db.select().from(teamMatches).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("still tells a genuine doubleheader apart after normalization", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const base = {
        eventId: null,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        playedOn: "2026-06-01",
        site: "Clayview Country Club",
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      };

      upsertTeamMatch(db, { ...base, scheduledTime: "9:00 AM" });
      upsertTeamMatch(db, { ...base, scheduledTime: "9:00 PM" });

      expect(db.select().from(teamMatches).all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("normalizeTimeKey maps equivalent renderings together and keeps AM/PM apart", () => {
    expect(normalizeTimeKey("9:00 AM")).toBe(normalizeTimeKey("09:00 am"));
    expect(normalizeTimeKey("9:00 AM")).toBe("clock:09:00");
    expect(normalizeTimeKey("12:00 AM")).toBe("clock:00:00");
    expect(normalizeTimeKey("12:00 PM")).toBe("clock:12:00");
    expect(normalizeTimeKey("9:00 AM")).not.toBe(normalizeTimeKey("9:00 PM"));
    // An unrecognised rendering still compares equal to itself rather than collapsing to "".
    expect(normalizeTimeKey("TBD")).toBe("raw:tbd");
    expect(normalizeTimeKey("TBD")).not.toBe(normalizeTimeKey(null));
  });
});

// Codex adversarial review, PR #31 round 4 [high]: stripping non-alphanumerics mapped a
// punctuation-only value onto the SAME key null used, so a dash-rendered "time not set yet" merged
// with a fixture that genuinely had no time — and one real row was lost.
describe("id-less key domains are disjoint", () => {
  useTnDbPath();
  useTnRawPath();

  it("REGRESSION: a punctuation-only value never collides with the null key", () => {
    expect(normalizeTimeKey("—")).not.toBe(normalizeTimeKey(null));
    expect(normalizeSiteKey("---")).not.toBe(normalizeSiteKey(null));
    // ...and two different punctuation-only values stay distinct from each other, too.
    expect(normalizeTimeKey("—")).not.toBe(normalizeTimeKey("---"));
    // A recognised clock time can never be confused with a raw or null key.
    expect(normalizeTimeKey("9:00 AM").startsWith("clock:")).toBe(true);
  });

  it("REGRESSION: a dash-timed fixture and a null-timed fixture stay two rows", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const base = {
        eventId: null,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        playedOn: "2026-06-01",
        site: "Clayview Country Club",
        sourceMatchId: null,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      };

      upsertTeamMatch(db, { ...base, scheduledTime: null });
      upsertTeamMatch(db, { ...base, scheduledTime: "—" });

      expect(db.select().from(teamMatches).all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });
});
