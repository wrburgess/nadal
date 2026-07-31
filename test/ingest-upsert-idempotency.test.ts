import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import {
  courtMatchPlayers,
  courtMatches,
  events,
  ratingObservations,
  teamMatches,
  teamMemberships,
  teams,
} from "../src/db/schema.js";
import { hrefParam } from "../src/parsers/dom.js";
import { AmbiguousIdentityError } from "../src/ingest/errors.js";
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

      // Issue #49 (Codex review round 2): `teams.roster_observed_at` is the one column a re-pull is
      // SUPPOSED to move — it records WHEN we last looked, not what we found, and the monotonic
      // retirement guard depends on it advancing. Every other column of `teams`, and every other
      // table below, still compares byte-identical, so the headline guarantee ("a re-pull changes
      // no DATA") is intact rather than weakened. Asserted as two halves rather than by dropping
      // the row comparison: the watermark is pinned to have ADVANCED, so this is strictly more
      // coverage than the single `toEqual` it replaces, not an exemption carved out of it.
      type TeamSnapshotRow = { id: number; tennisrecordUrl: string | null; rosterObservedAt: string | null };
      const teamsFirst = teamsAfterFirst as TeamSnapshotRow[];
      const teamsSecond = snapshot(teams) as TeamSnapshotRow[];
      const withoutWatermark = (rows: TeamSnapshotRow[]) =>
        rows.map((row) => {
          const copy: Partial<TeamSnapshotRow> = { ...row };
          delete copy.rosterObservedAt;
          return copy;
        });
      expect(withoutWatermark(teamsSecond)).toEqual(withoutWatermark(teamsFirst));

      const pulledFirst = teamsFirst.find((t) => t.tennisrecordUrl !== null)!;
      const pulledSecond = teamsSecond.find((t) => t.id === pulledFirst.id)!;
      expect(pulledFirst.rosterObservedAt).not.toBeNull();
      expect(
        pulledSecond.rosterObservedAt! >= pulledFirst.rosterObservedAt!,
        "the second pull observed the roster no earlier than the first",
      ).toBe(true);
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

// Codex adversarial review (PR #54 round 5), the second round-5 finding: `team-pull` passes
// `eventId: null` UNCONDITIONALLY for every parsed schedule row (verified at its one call site,
// src/ingest/team-pull.ts:301 — a hardcoded literal, not derived from anything parsed), and the
// id-less update branch above used to write `values.eventId ?? null` straight through with no
// regard for what the STORED row already held. So: ingest a scorecard for an event-linked fixture
// (`addMatchFromScorecard`/`match-add`, which supplies a real `eventId`), then re-pull either team
// from a schedule containing that SAME id-less fixture — the event link on the parent row is
// SILENTLY ERASED, even though the lenient matching PR #54 round 2 added never lets team-pull MOVE
// the event to a different one (`upsertTeamMatch`'s own matching logic is untouched by that
// change). HC-ruled in scope for #18 (relaxing the earlier "upsertTeamMatch/team-pull.ts stay
// untouched" boundary for this ONE change): the fix is the identical fill-in-blanks idiom the
// scorecard-specific updater (`upsertLenientTeamMatchForScorecard` in src/ingest/match-add.ts)
// already uses for `scheduledTime`/`site` — `existing.eventId ?? values.eventId`, and two
// DIFFERENT non-null event ids refuse rather than silently overwrite, matching this file's own
// existing error posture (a bare `Error`, same as `upsertPlayer` above) rather than inventing a new
// refusal mechanism that would ripple into every caller of `upsertTeamMatch`.
describe("id-less team matches preserve a stored event link (Codex round 5, HC-approved exception)", () => {
  useTnDbPath();
  useTnRawPath();

  function seedEvent(db: ReturnType<typeof openDb>["db"], name: string) {
    return db
      .insert(events)
      .values({ name, kind: "tournament", startsOn: "2026-08-01", endsOn: "2026-08-31" })
      .returning()
      .get();
  }

  it("REGRESSION: an event-linked row survives a later id-less update supplying no event (team-pull's own shape)", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const eventA = seedEvent(db, "Event A");
      const base = { playedOn: "2026-08-28", scheduledTime: "9:00 AM", site: "Court 1", sourceMatchId: null };

      upsertTeamMatch(db, {
        ...base,
        eventId: eventA.id,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });

      // The exact shape team-pull's own call site uses: eventId: null, unconditionally.
      upsertTeamMatch(db, {
        ...base,
        eventId: null,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: 3,
        visitingCourtsWon: 2,
      });

      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventId).toBe(eventA.id);
      // The rest of the update still applies — this is not a "reject the whole write" guard.
      expect(rows[0]?.homeCourtsWon).toBe(3);
      expect(rows[0]?.visitingCourtsWon).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("the reverse ordering: a stored row with no event is filled in by a later update that supplies one", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const eventA = seedEvent(db, "Event A");
      const base = { playedOn: "2026-08-29", scheduledTime: "9:00 AM", site: "Court 1", sourceMatchId: null };

      upsertTeamMatch(db, {
        ...base,
        eventId: null,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });
      upsertTeamMatch(db, {
        ...base,
        eventId: eventA.id,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: 3,
        visitingCourtsWon: 2,
      });

      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventId).toBe(eventA.id);
    } finally {
      sqlite.close();
    }
  });

  it("REGRESSION: two DIFFERENT non-null events on the same id-less fixture refuse, nothing overwritten", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const eventA = seedEvent(db, "Event A");
      const eventB = seedEvent(db, "Event B");
      const base = { playedOn: "2026-08-30", scheduledTime: "9:00 AM", site: "Court 1", sourceMatchId: null };

      upsertTeamMatch(db, {
        ...base,
        eventId: eventA.id,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });

      expect(() =>
        upsertTeamMatch(db, {
          ...base,
          eventId: eventB.id,
          homeTeamId: a.id,
          visitingTeamId: b.id,
          homeCourtsWon: 3,
          visitingCourtsWon: 2,
        }),
      ).toThrow();

      // Nothing moved or partially applied: the stored row is untouched.
      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventId).toBe(eventA.id);
      expect(rows[0]?.homeCourtsWon).toBeNull();
      expect(rows[0]?.visitingCourtsWon).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

// Codex adversarial review (PR #54 round 8, rated High): round 5 fixed event preservation in the
// ID-LESS branch above but left its SIBLING — the `sourceMatchId`-keyed `onConflictDoUpdate` branch
// a few lines below it, in the SAME function — writing `eventId: values.eventId ?? null`
// unconditionally, exactly the shape round 5 already fixed once. Round 7 made this reachable in a
// way it was not before: a scorecard can now attach to (and set an event on) a `mid=`-bearing row,
// so a re-pull of that SAME `mid=` (which always passes `eventId: null`, per team-pull's one call
// site) silently erased the event the scorecard had just linked. Fixed with the identical
// preserve/fill/refuse semantics, expressed differently because this branch has no separate
// SELECT-then-UPDATE step to hang a JS `existing.eventId ?? values.eventId` off of the way the
// id-less branch does: a PRE-SELECT by `sourceMatchId` runs first (better-sqlite3 is fully
// synchronous, so there is no interleaving window between this select and the upsert that follows —
// unlike a multi-connection database, nothing else can run in between), throwing the SAME conflict
// error on two different non-null events, and computing the SAME JS expression
// (`existing?.eventId ?? values.eventId ?? null`) the id-less branch already uses, fed into
// `onConflictDoUpdate`'s `set` clause as a plain value rather than a hand-rolled SQL `coalesce` —
// one shared notion of "how an event is written," not two independently-invented ones.
describe("source-backed team matches preserve a stored event link (Codex round 8)", () => {
  useTnDbPath();
  useTnRawPath();

  function seedEvent(db: ReturnType<typeof openDb>["db"], name: string) {
    return db
      .insert(events)
      .values({ name, kind: "tournament", startsOn: "2026-08-01", endsOn: "2026-08-31" })
      .returning()
      .get();
  }

  it("REGRESSION (Codex round 8, rated High): an event-linked source-backed row survives a later re-pull of the SAME mid= (team-pull's own shape)", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const eventA = seedEvent(db, "Event A");
      const base = { playedOn: "2026-08-28", scheduledTime: "9:00 AM", site: "Court 1", sourceMatchId: "181505" };

      upsertTeamMatch(db, {
        ...base,
        eventId: eventA.id,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });

      // The exact shape team-pull's own call site uses: eventId: null, unconditionally.
      upsertTeamMatch(db, {
        ...base,
        eventId: null,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: 3,
        visitingCourtsWon: 2,
      });

      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventId).toBe(eventA.id); // survives, not erased
      expect(rows[0]?.homeCourtsWon).toBe(3); // the rest of the re-pull still applies
    } finally {
      sqlite.close();
    }
  });

  it("the reverse ordering: a source-backed row with no event is filled in by a later re-pull that supplies one", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const eventA = seedEvent(db, "Event A");
      const base = { playedOn: "2026-08-29", scheduledTime: "9:00 AM", site: "Court 1", sourceMatchId: "181506" };

      upsertTeamMatch(db, {
        ...base,
        eventId: null,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });
      upsertTeamMatch(db, {
        ...base,
        eventId: eventA.id,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: 3,
        visitingCourtsWon: 2,
      });

      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventId).toBe(eventA.id);
    } finally {
      sqlite.close();
    }
  });

  it("REGRESSION (Codex round 8): two DIFFERENT non-null events on the same mid= refuse, nothing overwritten", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const a = upsertTeam(db, { name: "Team A" });
      const b = upsertTeam(db, { name: "Team B" });
      const eventA = seedEvent(db, "Event A");
      const eventB = seedEvent(db, "Event B");
      const base = { playedOn: "2026-08-30", scheduledTime: "9:00 AM", site: "Court 1", sourceMatchId: "181507" };

      upsertTeamMatch(db, {
        ...base,
        eventId: eventA.id,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });

      expect(() =>
        upsertTeamMatch(db, {
          ...base,
          eventId: eventB.id,
          homeTeamId: a.id,
          visitingTeamId: b.id,
          homeCourtsWon: 3,
          visitingCourtsWon: 2,
        }),
      ).toThrow();

      const rows = db.select().from(teamMatches).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventId).toBe(eventA.id); // untouched
      expect(rows[0]?.homeCourtsWon).toBeNull(); // nothing partially applied
    } finally {
      sqlite.close();
    }
  });
});

// Codex adversarial review (PR #54 round 9, rated Medium): round 8's fix (a JS pre-select, then a
// JS-computed decision fed into `onConflictDoUpdate`) is safe within ONE synchronous connection —
// nothing else can run between the select and the write in a single process — but NOT across two
// separate connections, which is exactly how the MCP server and a CLI invocation reach this table:
// as separate processes, each with its OWN connection. Concrete interleaving: `mid=181505` stored
// with `eventId=null`; connection A pre-selects (sees null); connection B pre-selects (ALSO sees
// null, since A hasn't written yet) and upserts event 102; A then upserts event 101 using ITS
// pre-selected (now STALE) null, silently overwriting B's write with neither call ever throwing.
//
// Testing note, not glossed over: a black-box call to `upsertTeamMatch` cannot literally reproduce
// this interleaving, because the vulnerable OLD shape's own pre-select ran synchronously, fresh, at
// the START of THAT call — there is no way for test code to pause a synchronous JS function mid-body
// to let another connection commit in between. The FIRST test below reconstructs the vulnerable
// two-statement shape directly, with raw table operations standing in for what the OLD code did
// internally, to demonstrate the hazard is real independent of any one function's implementation —
// this is what actually justifies collapsing conflict-check-and-write into ONE atomic SQL statement,
// rather than trusting a description of the bug. The SECOND test exercises the ACTUAL, FIXED
// `upsertTeamMatch` across two real connections and confirms the invariant now holds even when a
// later-arriving connection's own read reflects an earlier state than the one that actually commits
// first — which is the property the fix guarantees structurally (there is no separate pre-select
// left in the fixed code for a second connection's write to race against).
describe("source-id event conflict check is atomic ACROSS CONNECTIONS (Codex round 9, rated Medium)", () => {
  useTnDbPath();
  useTnRawPath();

  function seedEvent(db: ReturnType<typeof openDb>["db"], name: string) {
    return db
      .insert(events)
      .values({ name, kind: "tournament", startsOn: "2026-08-01", endsOn: "2026-08-31" })
      .returning()
      .get();
  }

  it("CHARACTERIZATION: a select-then-decide-then-write shape across two connections silently corrupts the invariant (the hazard this fix closes)", () => {
    runMigrations();
    const connA = openDb();
    const connB = openDb();
    try {
      const a = upsertTeam(connA.db, { name: "Team A" });
      const b = upsertTeam(connA.db, { name: "Team B" });
      const eventA = seedEvent(connA.db, "Event A");
      const eventB = seedEvent(connA.db, "Event B");
      connA.db
        .insert(teamMatches)
        .values({
          eventId: null,
          homeTeamId: a.id,
          visitingTeamId: b.id,
          playedOn: "2026-08-28",
          sourceMatchId: "181505",
        })
        .run();

      // Both connections independently see the SAME blank state before either decides anything —
      // reproducing the exact moment the OLD pre-select-based code made its decision from.
      const seenByA = connA.db.select().from(teamMatches).where(eq(teamMatches.sourceMatchId, "181505")).all()[0]!;
      const seenByB = connB.db.select().from(teamMatches).where(eq(teamMatches.sourceMatchId, "181505")).all()[0]!;
      expect(seenByA.eventId).toBeNull();
      expect(seenByB.eventId).toBeNull();

      // Connection B decides (from its own null read) that it is safe to set event B, and commits.
      connB.db.update(teamMatches).set({ eventId: eventB.id }).where(eq(teamMatches.id, seenByB.id)).run();

      // Connection A now acts on ITS pre-selected (now stale) `seenByA.eventId === null` — exactly
      // what the OLD `upsertTeamMatch` shape did: decide from the read, THEN write, with no
      // re-check. Nothing here throws, and the write silently succeeds.
      connA.db.update(teamMatches).set({ eventId: eventA.id }).where(eq(teamMatches.id, seenByA.id)).run();

      // The invariant IS violated: two different non-null events were both accepted, one silently
      // clobbering the other, with no error at any point — this is the corruption the atomic fix
      // (a single statement, re-evaluated against whatever is actually current) closes.
      const final = connA.db.select().from(teamMatches).where(eq(teamMatches.sourceMatchId, "181505")).all()[0]!;
      expect(final.eventId).toBe(eventA.id); // B's committed event, silently overwritten
    } finally {
      connA.sqlite.close();
      connB.sqlite.close();
    }
  });

  it("REGRESSION (Codex round 9, rated Medium): the REAL upsertTeamMatch refuses a conflicting event across two connections, even though a stale read happened first", () => {
    runMigrations();
    const connA = openDb();
    const connB = openDb();
    try {
      const a = upsertTeam(connA.db, { name: "Team A" });
      const b = upsertTeam(connA.db, { name: "Team B" });
      const eventA = seedEvent(connA.db, "Event A");
      const eventB = seedEvent(connA.db, "Event B");
      const base = { playedOn: "2026-08-28", scheduledTime: "9:00 AM", site: "Court 1", sourceMatchId: "181505" };

      upsertTeamMatch(connA.db, {
        ...base,
        eventId: null,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });

      // Both connections read the blank row before either sets an event — same setup as above.
      const seenByA = connA.db.select().from(teamMatches).where(eq(teamMatches.sourceMatchId, "181505")).all()[0]!;
      const seenByB = connB.db.select().from(teamMatches).where(eq(teamMatches.sourceMatchId, "181505")).all()[0]!;
      expect(seenByA.eventId).toBeNull();
      expect(seenByB.eventId).toBeNull();

      // Connection B commits event B through the real function.
      const afterB = upsertTeamMatch(connB.db, {
        ...base,
        eventId: eventB.id,
        homeTeamId: a.id,
        visitingTeamId: b.id,
        homeCourtsWon: null,
        visitingCourtsWon: null,
      });
      expect(afterB.eventId).toBe(eventB.id);

      // Connection A now attempts event A. The fixed function does NOT consult `seenByA` (or any
      // other stale JS value) — its conflict check and its write are ONE atomic SQL statement,
      // evaluated against whatever `teamMatches` actually holds the instant it executes, so it sees
      // B's committed event and refuses rather than silently overwriting it.
      expect(() =>
        upsertTeamMatch(connA.db, {
          ...base,
          eventId: eventA.id,
          homeTeamId: a.id,
          visitingTeamId: b.id,
          homeCourtsWon: null,
          visitingCourtsWon: null,
        }),
      ).toThrow();

      const final = connA.db.select().from(teamMatches).where(eq(teamMatches.sourceMatchId, "181505")).all()[0]!;
      expect(final.eventId).toBe(eventB.id); // survives, untouched by A's refused attempt
    } finally {
      connA.sqlite.close();
      connB.sqlite.close();
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

// Issue #46: a non-null `teams.tennisrecord_url` is a unique source identity. Before this fix,
// `upsertTeam` conflicted only on `teams.name`, so a re-pull of a RENAMED team (the same URL,
// parsed to a new name) missed the old row entirely and inserted a second row carrying the SAME
// tennisrecord_url — the exact case the assessment for #46 traced from #42.
describe("upsertTeam resolves by tennisrecord_url first (#46)", () => {
  useTnDbPath();

  it("REGRESSION: re-upserting a renamed team by the same tennisrecord_url updates the SAME row, not a second one", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const url = "https://tennisrecord.com/team.aspx?teamname=Springfield%20A";
      const first = upsertTeam(db, { name: "Springfield A", tennisrecordUrl: url });
      const second = upsertTeam(db, { name: "Springfield A 4.0", tennisrecordUrl: url });

      expect(second.id).toBe(first.id);
      expect(second.name).toBe("Springfield A 4.0");
      // A stale name_key is the same silent-duplicate failure as never setting it at all
      // (upsert.ts's existing rationale for seeding `set.nameKey` unconditionally).
      expect(second.nameKey).toBe(nameKey("Springfield A 4.0"));

      const rows = db.select().from(teams).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("Springfield A 4.0");
    } finally {
      sqlite.close();
    }
  });

  // The reachable sad path: `resolveTeam` creates opponent teams by NAME with a null
  // tennisrecord_url (team-pull.ts's schedule loop) — the schedule is the only source of that
  // identity. A rename that collides with such a stub is a merge decision, out of bounds per
  // spec § Ingestion, so it must throw rather than silently pick a row.
  it("REGRESSION: renaming into a name a DIFFERENT row already holds throws AmbiguousIdentityError and mutates nothing", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const url = "https://tennisrecord.com/team.aspx?teamname=Springfield%20A";
      const renamed = upsertTeam(db, { name: "Springfield A", tennisrecordUrl: url });
      const opponent = upsertTeam(db, { name: "Springfield B" });

      let caught: unknown;
      try {
        upsertTeam(db, { name: "Springfield B", tennisrecordUrl: url });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AmbiguousIdentityError);
      if (caught instanceof AmbiguousIdentityError) {
        expect(caught.candidates.slice().sort()).toEqual(["Springfield A", "Springfield B"]);
      }

      // NO row mutated, NO row inserted — re-read both rows rather than trusting the throw alone.
      const rows = db.select().from(teams).all();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === renamed.id)?.name).toBe("Springfield A");
      expect(rows.find((r) => r.id === opponent.id)?.name).toBe("Springfield B");
    } finally {
      sqlite.close();
    }
  });

  // The existing NAME-branch test at :260 guards only that branch — this guards that the URL
  // branch's null-skipping `set` (upsert.ts:65-73) survives unchanged, so a re-pull that carries
  // `section: null` cannot erase another source's value on this path either.
  //
  // The RENAME is load-bearing and was missing in this test's first draft (Codex adversarial
  // review, rated medium, raised to high here — `PROJECT.md` scores a missing required test as
  // High). With both writes under the SAME name, reverting the whole URL branch still routes the
  // second write through the old name-conflict update, which has the same null-skipping `set` — so
  // the test stayed green while proving nothing about the new path. Renaming forces the URL branch:
  // the old name-conflict target matches no row under the new name, so a revert INSERTS a second
  // row and both the id and the row-count assertions go red.
  //
  // All three optional columns are asserted, not just `section`: `district` and `tennislink_url`
  // are the two the upsertTeam doc comment actually names as at risk ("a TennisRecord pull knows
  // nothing about tennislink_url and passes district: null unconditionally"), so a test that omits
  // them guards the rationale's example rather than its claim.
  it("REGRESSION: re-upserting a RENAMED team via the tennisrecord_url branch with every optional column null preserves all of them", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const url = "https://tennisrecord.com/team.aspx?teamname=Springfield%20A";
      const first = upsertTeam(db, {
        name: "Springfield A",
        tennisrecordUrl: url,
        section: "Missouri Valley",
        district: "Central",
        tennislinkUrl: "https://tennislink.usta.com/team/1",
      });

      // The rename is what routes this through the URL branch rather than the name-conflict path.
      const after = upsertTeam(db, {
        name: "Springfield A 4.0",
        tennisrecordUrl: url,
        section: null,
        district: null,
        tennislinkUrl: null,
      });

      expect(after.id).toBe(first.id);
      expect(after.name).toBe("Springfield A 4.0");
      expect(after.section).toBe("Missouri Valley");
      expect(after.district).toBe("Central");
      expect(after.tennislinkUrl).toBe("https://tennislink.usta.com/team/1");
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("two teams with no tennisrecord_url coexist (the partial unique index must not collapse un-URL'd teams)", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      upsertTeam(db, { name: "Team No URL A" });
      upsertTeam(db, { name: "Team No URL B" });

      expect(db.select().from(teams).all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("idempotence unchanged: the same URL and name upserted twice is one row and no error", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const url = "https://tennisrecord.com/team.aspx?teamname=Springfield%20A";
      upsertTeam(db, { name: "Springfield A", tennisrecordUrl: url });
      expect(() => upsertTeam(db, { name: "Springfield A", tennisrecordUrl: url })).not.toThrow();

      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
