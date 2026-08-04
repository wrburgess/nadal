import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { hrefParam } from "../src/parsers/dom.js";
import { FetchError, type PageFetcher } from "../src/ingest/fetch.js";
import { matchHistoryUrlFor } from "../src/ingest/player-pull.js";
import { cascadeFailureWarning, pullTeam } from "../src/ingest/team-pull.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
import { buildRosterPage, removeAllRosterRows, removeRosterRow } from "./helpers/roster-html.js";
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

  // Issue #46, at the pipeline level: re-pulling the SAME URL with a RENAMED team page must not
  // split the roster/schedule across two team rows. Before the fix, `upsertTeam` conflicted only
  // on `teams.name`, so the second pull inserted a second team row sharing the same
  // tennisrecord_url, and `resolveTeamTarget`/tier-1 `resolveTeam` would then pick between the two
  // arbitrarily.
  it("REGRESSION (#46): re-pulling the same URL with a RENAMED team keeps memberships and team_matches on ONE row", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const fetcher1 = createStubFetcher({ [team.source.url]: { body: team.html } });
      const first = await pullTeam({ db, fetchPage: fetcher1, target: team.source.url });
      expect(first.kind).toBe("ok");
      if (first.kind !== "ok") throw new Error("expected ok");

      const renamedHtml = team.html.replace(
        '<td style="text-align:left;" class="padding10">Norbury, Nova</td>',
        '<td style="text-align:left;" class="padding10">Norbury, Nova 4.0</td>',
      );
      expect(renamedHtml).not.toBe(team.html);
      const fetcher2 = createStubFetcher({ [team.source.url]: { body: renamedHtml } });
      const second = await pullTeam({ db, fetchPage: fetcher2, target: team.source.url });
      expect(second.kind).toBe("ok");
      if (second.kind !== "ok") throw new Error("expected ok");

      const teamRows = db.select().from(teams).where(eq(teams.tennisrecordUrl, team.source.url)).all();
      expect(teamRows).toHaveLength(1);
      expect(teamRows[0]?.id).toBe(first.team.id);
      expect(teamRows[0]?.name).toBe("Norbury, Nova 4.0");

      const memberships = db
        .select()
        .from(teamMemberships)
        .where(eq(teamMemberships.teamId, first.team.id))
        .all();
      expect(memberships).toHaveLength(18);

      const matches = db.select().from(teamMatches).where(eq(teamMatches.homeTeamId, first.team.id)).all();
      expect(matches).toHaveLength(10);
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

  it("a pull whose page has NO roster rows refuses, and still retires nobody (#92 supersedes the #49 shape)", async () => {
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

      // #49 established this path and asserted `kind: "ok"` with `rosterCount: 0` — the safety
      // property being that an empty observed roster must never read as "everyone left".
      //
      // #92 keeps that property and STRENGTHENS the outcome: a roster table with a complete header
      // and no player rows is now a parse refusal, because `status=ok ... roster=0` was a scouting
      // pull that silently found nobody while the snapshot watermark advanced as if it had
      // succeeded. Nothing is written on this path at all now, rather than nothing being written
      // by a guard inside a committed transaction.
      //
      // The empty-observed-set guard itself is NOT left uncovered by this change: it is asserted
      // directly in test/ingest-upsert-membership-retirement.test.ts ("an empty observedPlayerIds
      // writes NOTHING"), which is where that primitive's sad path belongs.
      expect(result.kind).toBe("error");

      const after = db.select().from(teamMemberships).all();
      expect(after, "a refused pull must leave every membership untouched").toEqual(before);
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

// Issue #49, found by the independent Codex adversarial review of PR #53 (rated high). `--from`
// reads an arbitrary saved page whose vintage NOTHING establishes, so it must never reconcile:
// replaying an archive captured before a newer live pull would retire everyone who joined since.
// The reviewer noted the pre-existing `--from` coverage all starts from an EMPTY database, so a
// stale replay against a populated one was never exercised.
describe("pullTeam --from never retires (issue #49, Codex review of PR #53)", () => {
  useTnDbPath();
  useTnRawPath();

  /** Writes `html` to a throwaway file and returns the path, for the `--from` replay path. */
  function archiveFile(html: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "tn-archive-")), "team.html");
    writeFileSync(path, html, "utf8");
    return path;
  }

  it("replaying an OLDER archive after a newer live pull retires nobody", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // The live roster of record: all 18.
      const live = await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: team.html } }),
        target: team.source.url,
      });
      expect(live.kind).toBe("ok");
      const before = db.select().from(teamMemberships).all();
      expect(before).toHaveLength(18);

      // A STALE archive that predates one member joining — i.e. it simply does not list them.
      // Replaying it must not conclude they left.
      const stale = archiveFile(removeRosterRow(team.html, "Ellis Eastwick"));
      const replay = await pullTeam({
        db,
        fetchPage: createStubFetcher({}),
        from: { path: stale, sourceUrl: team.source.url },
      });

      expect(replay.kind).toBe("ok");
      if (replay.kind !== "ok") throw new Error("expected ok");
      expect(replay.retiredCount, "a replayed page must never retire").toBe(0);

      // Asserted on DATABASE STATE, not just the reported count: every membership is still current.
      const after = db.select().from(teamMemberships).all();
      expect(after).toHaveLength(18);
      expect(after.every((m) => m.retiredAt === null), "no membership was retired by the replay").toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("a replay does NOT un-retire a member the authoritative roster retired, but still adds an unseen one", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // Ellis is retired legitimately, by a live pull whose roster omits them.
      await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: team.html } }),
        target: team.source.url,
      });
      const withoutEllis = removeRosterRow(team.html, "Ellis Eastwick");
      const live = await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: withoutEllis } }),
        target: team.source.url,
      });
      expect(live.kind).toBe("ok");
      if (live.kind !== "ok") throw new Error("expected ok");
      expect(live.retiredCount).toBe(1);

      // Replay the FULL archive, which DOES list Ellis. An archive of unknown vintage must not
      // overturn the authoritative roster's finding — reviving a departed player is the very defect
      // #49 exists to fix, and it is no more acceptable arriving from a replay than a retirement
      // would be. (An earlier version of this PR asserted the opposite; Codex round 4 caught it.)
      const full = archiveFile(team.html);
      const replay = await pullTeam({
        db,
        fetchPage: createStubFetcher({}),
        from: { path: full, sourceUrl: team.source.url },
      });
      expect(replay.kind).toBe("ok");

      const ellis = db.select().from(players).where(eq(players.canonicalName, "Ellis Eastwick")).all()[0]!;
      const rows = db.select().from(teamMemberships).where(eq(teamMemberships.playerId, ellis.id)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.retiredAt, "a replay must not revive a retired member").not.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("a replay still INSERTS a membership it has never seen — untrusted evidence may add, just not overturn", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // Seed from a roster WITHOUT Ellis, so no Ellis membership exists at all.
      await pullTeam({
        db,
        fetchPage: createStubFetcher({ [team.source.url]: { body: removeRosterRow(team.html, "Ellis Eastwick") } }),
        target: team.source.url,
      });
      const before = db.select().from(players).where(eq(players.canonicalName, "Ellis Eastwick")).all();
      expect(before, "Ellis is not on file yet").toHaveLength(0);

      const full = archiveFile(team.html);
      await pullTeam({ db, fetchPage: createStubFetcher({}), from: { path: full, sourceUrl: team.source.url } });

      const ellis = db.select().from(players).where(eq(players.canonicalName, "Ellis Eastwick")).all()[0]!;
      const rows = db.select().from(teamMemberships).where(eq(teamMemberships.playerId, ellis.id)).all();
      expect(rows, "a never-seen member is still inserted").toHaveLength(1);
      expect(rows[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});


// Issue #49, found by the independent Codex adversarial review of PR #53 round 2 (rated high).
// SQLite serializes the two writers, but serialization orders the WRITES and the reconcile is a
// claim about the INPUTS: an older complete roster that commits last would retire a player the
// newer one listed. Both pages are valid and complete, so this is distinct from the accepted
// truncated-page limitation. Reachable inside one process — the MCP server awaits `fetchPage`, so
// two overlapping `team_pull` calls interleave exactly this way when the earlier request is slower.
describe("pullTeam is monotonic in observation time (issue #49, Codex review round 2)", () => {
  useTnDbPath();
  useTnRawPath();

  /** A fetcher that reports an explicit `fetchedAt`, so a test can order two snapshots by the time
   * they were OBSERVED rather than by the order they happen to be written. */
  function fetcherObservedAt(body: string, fetchedAt: string) {
    return async (url: string) => ({ url, status: 200, body, fetchedAt });
  }

  it("an OLDER complete roster committing after a newer one does not retire the player the newer one listed", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // Seed: the team exists with all 18, observed early.
      const seed = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-01T00:00:00.000Z"),
        target: team.source.url,
      });
      expect(seed.kind).toBe("ok");

      // Process B: the NEWER snapshot — still lists Ellis — commits FIRST.
      const newer = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-20T00:00:00.000Z"),
        target: team.source.url,
      });
      expect(newer.kind).toBe("ok");

      // Process A: the OLDER snapshot, fetched before B but slower to arrive, omits Ellis and
      // commits SECOND. Without the monotonic guard it retires Ellis on stale evidence.
      const olderBody = removeRosterRow(team.html, "Ellis Eastwick");
      const older = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(olderBody, "2026-07-10T00:00:00.000Z"),
        target: team.source.url,
      });

      expect(older.kind).toBe("ok");
      if (older.kind !== "ok") throw new Error("expected ok");
      expect(older.retiredCount, "a stale snapshot must retire nobody").toBe(0);

      const ellis = db.select().from(players).where(eq(players.canonicalName, "Ellis Eastwick")).all()[0]!;
      const rows = db.select().from(teamMemberships).where(eq(teamMemberships.playerId, ellis.id)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.retiredAt, "the newer snapshot listed Ellis, so Ellis is still current").toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("a NEWER snapshot still retires normally — the guard rejects stale evidence, it does not disable retirement", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-01T00:00:00.000Z"),
        target: team.source.url,
      });

      const later = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(removeRosterRow(team.html, "Ellis Eastwick"), "2026-07-15T00:00:00.000Z"),
        target: team.source.url,
      });

      expect(later.kind).toBe("ok");
      if (later.kind !== "ok") throw new Error("expected ok");
      expect(later.retiredCount).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("a stale snapshot does not advance the watermark, so a genuinely newer pull after it still reconciles", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-20T00:00:00.000Z"),
        target: team.source.url,
      });
      // Stale — skipped, and must NOT move the mark backward to 2026-07-10.
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-10T00:00:00.000Z"),
        target: team.source.url,
      });

      const teamRow = db.select().from(teams).where(eq(teams.tennisrecordUrl, team.source.url)).all()[0]!;
      expect(teamRow.rosterObservedAt, "the stale pull must not move the watermark").toBe(
        "2026-07-20T00:00:00.000Z",
      );

      // A genuinely newer snapshot after the stale one still reconciles.
      const newest = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(removeRosterRow(team.html, "Ellis Eastwick"), "2026-07-25T00:00:00.000Z"),
        target: team.source.url,
      });
      expect(newest.kind).toBe("ok");
      if (newest.kind !== "ok") throw new Error("expected ok");
      expect(newest.retiredCount).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("a --from replay never advances the watermark, so it cannot make a later live pull look stale", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-01T00:00:00.000Z"),
        target: team.source.url,
      });
      const path = join(mkdtempSync(join(tmpdir(), "tn-archive-")), "team.html");
      writeFileSync(path, team.html, "utf8");
      await pullTeam({ db, fetchPage: createStubFetcher({}), from: { path, sourceUrl: team.source.url } });

      const teamRow = db.select().from(teams).where(eq(teams.tennisrecordUrl, team.source.url)).all()[0]!;
      expect(teamRow.rosterObservedAt, "a replay records no observation time").toBe("2026-07-01T00:00:00.000Z");
    } finally {
      sqlite.close();
    }
  });
});


// Issue #49, Codex adversarial review of PR #53 round 3. Two more ways a reconcile could act on
// evidence it cannot actually order.
describe("pullTeam reconcile provenance (issue #49, Codex review round 3)", () => {
  useTnDbPath();
  useTnRawPath();

  function fetcherObservedAt(body: string, fetchedAt: string) {
    return async (url: string) => ({ url, status: 200, body, fetchedAt });
  }

  it("an EQUAL observation stamp retires nobody — ties fail closed rather than on commit order", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const stamp = "2026-07-20T12:00:00.123Z";
      await pullTeam({ db, fetchPage: fetcherObservedAt(team.html, stamp), target: team.source.url });

      // Same millisecond, conflicting content. Nothing orders these two, so neither may remove.
      const tied = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(removeRosterRow(team.html, "Ellis Eastwick"), stamp),
        target: team.source.url,
      });

      expect(tied.kind).toBe("ok");
      if (tied.kind !== "ok") throw new Error("expected ok");
      expect(tied.retiredCount, "an unordered tie must not retire").toBe(0);
      const ellis = db.select().from(players).where(eq(players.canonicalName, "Ellis Eastwick")).all()[0]!;
      const rows = db.select().from(teamMemberships).where(eq(teamMemberships.playerId, ellis.id)).all();
      expect(rows[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("freshly fetching a PRIOR-SEASON url retires nobody, even though its fetch time is newer", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // The current season establishes the roster and the baseline.
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-20T00:00:00.000Z"),
        target: team.source.url,
      });

      // Same team name, PRIOR season url, fetched NOW — a valid roster that is a year out of date.
      // Its stamp is newer than the watermark, so only the source check can stop it.
      const priorYearUrl = team.source.url.replace("year=2026", "year=2025");
      expect(priorYearUrl).not.toBe(team.source.url);
      const priorSeason = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(removeRosterRow(team.html, "Ellis Eastwick"), "2026-07-31T00:00:00.000Z"),
        target: priorYearUrl,
      });

      expect(priorSeason.kind).toBe("ok");
      if (priorSeason.kind !== "ok") throw new Error("expected ok");
      expect(priorSeason.retiredCount, "a different source may refresh, never remove").toBe(0);
      const ellis = db.select().from(players).where(eq(players.canonicalName, "Ellis Eastwick")).all()[0]!;
      const rows = db.select().from(teamMemberships).where(eq(teamMemberships.playerId, ellis.id)).all();
      expect(rows[0]!.retiredAt).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("a different source RE-BASELINES, so the next pull from it reconciles normally", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-20T00:00:00.000Z"),
        target: team.source.url,
      });
      const nextSeasonUrl = team.source.url.replace("year=2026", "year=2027");

      // First pull from the new source: re-baseline, retire nobody.
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-21T00:00:00.000Z"),
        target: nextSeasonUrl,
      });
      const teamRow = db.select().from(teams).where(eq(teams.name, "Norbury, Nova")).all()[0]!;
      expect(teamRow.rosterObservedUrl, "the baseline moved to the new source").toBe(nextSeasonUrl);

      // Second pull from the SAME new source reconciles normally — proving the source check is a
      // one-pull transition, not a permanent disabling of retirement when a season rolls over.
      const settled = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(removeRosterRow(team.html, "Ellis Eastwick"), "2026-07-22T00:00:00.000Z"),
        target: nextSeasonUrl,
      });
      expect(settled.kind).toBe("ok");
      if (settled.kind !== "ok") throw new Error("expected ok");
      expect(settled.retiredCount, "retirement resumes once the new source is the baseline").toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

// Issue #49, Codex adversarial review of PR #53 round 4 (rated high). The guards above stop an
// untrusted snapshot REMOVING a member; these pin the inverse — it must not REVIVE one either.
// Reviving a correctly-retired player puts them back on every roster read and back into predicted
// lineups, which is the original defect of this issue arriving through the opposite door.
describe("an untrusted snapshot cannot revive a retired member (issue #49, Codex round 4)", () => {
  useTnDbPath();
  useTnRawPath();

  function fetcherObservedAt(body: string, fetchedAt: string) {
    return async (url: string) => ({ url, status: 200, body, fetchedAt });
  }

  /** Pulls the full roster, then a later roster omitting Ellis, leaving Ellis correctly retired. */
  async function seedWithEllisRetired(db: ReturnType<typeof openDb>["db"]) {
    await pullTeam({
      db,
      fetchPage: fetcherObservedAt(team.html, "2026-07-01T00:00:00.000Z"),
      target: team.source.url,
    });
    const retired = await pullTeam({
      db,
      fetchPage: fetcherObservedAt(removeRosterRow(team.html, "Ellis Eastwick"), "2026-07-20T00:00:00.000Z"),
      target: team.source.url,
    });
    expect(retired.kind).toBe("ok");
    if (retired.kind !== "ok") throw new Error("expected ok");
    expect(retired.retiredCount).toBe(1);
  }

  function ellisRetiredAt(db: ReturnType<typeof openDb>["db"]): string | null {
    const ellis = db.select().from(players).where(eq(players.canonicalName, "Ellis Eastwick")).all()[0]!;
    return db.select().from(teamMemberships).where(eq(teamMemberships.playerId, ellis.id)).all()[0]!.retiredAt;
  }

  it("a STALE same-source snapshot listing the retired member leaves them retired", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await seedWithEllisRetired(db);

      // Older than the watermark, and it lists Ellis. Stale evidence must not overturn.
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-10T00:00:00.000Z"),
        target: team.source.url,
      });

      expect(ellisRetiredAt(db), "a stale snapshot must not revive a retired member").not.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("a DIFFERENT-SOURCE (prior-season) snapshot listing the retired member leaves them retired", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await seedWithEllisRetired(db);

      // Newer stamp, but a different source — exactly the case that re-baselines. It may move the
      // baseline; it may not overturn the authoritative roster's finding about Ellis.
      const priorYearUrl = team.source.url.replace("year=2026", "year=2025");
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-31T00:00:00.000Z"),
        target: priorYearUrl,
      });

      expect(ellisRetiredAt(db), "a different source must not revive a retired member").not.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("a TRUSTED newer same-source snapshot DOES un-retire — the guard rejects bad evidence, not the feature", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await seedWithEllisRetired(db);

      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-25T00:00:00.000Z"),
        target: team.source.url,
      });

      expect(ellisRetiredAt(db), "a trusted newer roster listing Ellis un-retires them").toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

// Issue #49, Codex adversarial review of PR #53 round 5 (rated high). Migrations 0007/0008 add both
// watermark columns as NULL, so EVERY team in an upgraded database starts with no roster provenance.
// If a missing baseline read as "trusted", the first `tn team pull` after an upgrade — pointed, say,
// at a prior season's URL — would retire legacy members on the strength of a year-old roster. That
// needs only ONE pull, so it is not the two-pull re-baselining residual deferred to issue #46.
// The migration half of this (upgraded teams really do have NULL watermarks) is pinned in
// test/db-membership-retirement-upgrade.test.ts.
describe("a team with no established baseline is not authoritative (issue #49, Codex round 5)", () => {
  useTnDbPath();
  useTnRawPath();

  function fetcherObservedAt(body: string, fetchedAt: string) {
    return async (url: string) => ({ url, status: 200, body, fetchedAt });
  }

  it("the first pull after an upgrade retires nobody, even from an arbitrary prior-season URL", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // Exactly the post-upgrade state: a team with current memberships and NULL watermarks. Seeded
      // directly rather than by re-running the migrations, which the sibling test already covers.
      const teamRow = db.insert(teams).values({ name: "Norbury, Nova" }).returning().get();
      const ellis = db.insert(players).values({ canonicalName: "Ellis Eastwick" }).returning().get();
      db.insert(teamMemberships).values({ playerId: ellis.id, teamId: teamRow.id, eventId: null }).run();
      // `runMigrations` backfills name keys on a real upgrade (db/client.ts), so a legacy row is
      // resolvable by the fail-closed identity probe. Seeding directly skips that, so do it here —
      // otherwise this test would fail on identity resolution rather than on the guard it names.
      backfillNameKeys(db);
      expect(teamRow.rosterObservedUrl, "the post-upgrade precondition").toBeNull();

      // A prior-season page for the same team name, omitting Ellis. Its stamp is brand new and
      // there is no watermark to compare against, so ONLY the no-baseline rule can stop it.
      const priorYearUrl = team.source.url.replace("year=2026", "year=2025");
      const first = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(removeRosterRow(team.html, "Ellis Eastwick"), "2026-07-31T00:00:00.000Z"),
        target: priorYearUrl,
      });

      expect(first.kind).toBe("ok");
      if (first.kind !== "ok") throw new Error("expected ok");
      expect(first.retiredCount, "a first snapshot establishes a baseline, it does not assert departures").toBe(0);
      const rows = db.select().from(teamMemberships).where(eq(teamMemberships.playerId, ellis.id)).all();
      expect(rows[0]!.retiredAt, "a legacy member survives the first post-upgrade pull").toBeNull();

      // The baseline IS established, so the pull was not simply discarded.
      const after = db.select().from(teams).where(eq(teams.id, teamRow.id)).all()[0]!;
      expect(after.rosterObservedUrl).toBe(priorYearUrl);
    } finally {
      sqlite.close();
    }
  });

  it("the SECOND pull from that established source reconciles normally", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      await pullTeam({
        db,
        fetchPage: fetcherObservedAt(team.html, "2026-07-01T00:00:00.000Z"),
        target: team.source.url,
      });
      const second = await pullTeam({
        db,
        fetchPage: fetcherObservedAt(removeRosterRow(team.html, "Ellis Eastwick"), "2026-07-02T00:00:00.000Z"),
        target: team.source.url,
      });
      expect(second.kind).toBe("ok");
      if (second.kind !== "ok") throw new Error("expected ok");
      expect(second.retiredCount, "retirement works once a baseline exists").toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

// Issue #96, finding 1. `(error)` was the WHOLE diagnosis a cascade gave an operator:
//
//   team pull: cascading "Jim Vanderveen" failed (error) — skipped
//
// `PlayerPullResult` carries a populated `message` for both `error` and `unknown-target`, and the
// warning rendered one for `ambiguous` only. A network timeout, an HTTP 404 and a `ParseError` want
// three different responses and the report distinguished none of them — measured live as four
// transient failures in one session, every one clean on an immediate individual retry, which is
// exactly the case a message settles at a glance.
//
// This is the same defect class #94 was opened for, one branch over: #94's fix supplied all three
// facts for `kind === "ambiguous"` and left the other two kinds reporting a bare kind name, because
// those two branches were pinned by NOTHING. So each is asserted here as a whole rendered line.
describe("the cascade warning says WHY a roster entry was skipped, for every failure kind (#96)", () => {
  useTnDbPath();
  useTnRawPath();

  const TEAM_URL = "https://www.tennisrecord.com/adult/teamprofile.aspx?teamname=Cascade&year=2026";
  const OK_PLAYER = "Avery Ashby";
  const FAILING_PLAYER = "Nova Norbury";
  const FAILING_URL = matchHistoryUrlFor(FAILING_PLAYER, "2026");

  /**
   * A two-member roster whose second member's match-history fetch throws `failure`. Hand-rolled
   * rather than `createStubFetcher` because the point is a fetch that FAILS in a specific way — the
   * stub's own "no fixture registered" throw would put the test helper's wording in the assertion
   * instead of the failure's.
   */
  function fetcherFailing(failure: Error): PageFetcher {
    const roster = buildRosterPage({ teamName: "Cascade Test", players: [OK_PLAYER, FAILING_PLAYER] });
    const page = (url: string, body: string) => ({ url, status: 200, body, fetchedAt: new Date().toISOString() });
    return async (url: string) => {
      if (url === FAILING_URL) throw failure;
      if (url === TEAM_URL) return page(url, roster);
      if (url === matchHistoryUrlFor(OK_PLAYER, "2026")) return page(url, syntheticEmptyMatchHistory(OK_PLAYER));
      throw new Error(`test fetcher: unexpected url "${url}"`);
    };
  }

  it("an `error` names the failure — the branch that used to print the word `error` and nothing else", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await pullTeam({
        db,
        fetchPage: fetcherFailing(new FetchError(`fetch failed with status 503: ${FAILING_URL}`, 503, FAILING_URL)),
        target: TEAM_URL,
        cascadePlayers: true,
      });

      // The team itself committed; only the enrichment was skipped.
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.skippedRosterEntries).toEqual([FAILING_PLAYER]);

      expect(warnSpy).toHaveBeenCalledWith(
        `team pull: cascading "${FAILING_PLAYER}" failed (error) — ` +
          `fetch failed with status 503: ${FAILING_URL} — skipped`,
      );
    } finally {
      warnSpy.mockRestore();
      sqlite.close();
    }
  });

  // The reason is now interpolated into a raw `console.warn`, which is a NEW attacker-influenced
  // path: a `ParseError` quotes the page it failed on, so the message can carry whatever the scraped
  // document did. Asserted as a whole line rather than as an absence-of-ESC search, so it also
  // states what the operator actually reads.
  it("sanitizes the reason too — an error message is attacker-influenced the same way a name is", async () => {
    const ESC = String.fromCharCode(0x1b);
    const RTL_OVERRIDE = String.fromCharCode(0x202e);
    runMigrations();
    const { db, sqlite } = openDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await pullTeam({
        db,
        fetchPage: fetcherFailing(new Error(`parse failed${ESC}[2J at${RTL_OVERRIDE} row 3`)),
        target: TEAM_URL,
        cascadePlayers: true,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        `team pull: cascading "${FAILING_PLAYER}" failed (error) — parse failed [2J at  row 3 — skipped`,
      );
    } finally {
      warnSpy.mockRestore();
      sqlite.close();
    }
  });

  // An error can carry no message at all (`new Error("")`), and a reason-shaped hole would print
  // `failed (error) —  — skipped`: a line that reads as truncated output rather than as "this
  // failure carried no reason", and that is indistinguishable at a glance from the defect above.
  //
  // Labelled deliberately: this one is GREEN both before and after the fix, because the branch it
  // pins is the one the FIX could break, not the one the issue reports — an unlabelled always-green
  // test reads to a reviewer as a test that cannot fail. Verified by mutation instead: appending the
  // reason unconditionally (` — ${reason}`) reddens exactly this test.
  it("an error carrying NO message prints no dangling separator", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await pullTeam({
        db,
        fetchPage: fetcherFailing(new Error("")),
        target: TEAM_URL,
        cascadePlayers: true,
      });

      expect(warnSpy).toHaveBeenCalledWith(`team pull: cascading "${FAILING_PLAYER}" failed (error) — skipped`);
    } finally {
      warnSpy.mockRestore();
      sqlite.close();
    }
  });

  // `cascadeFailureWarning` is exported for THIS test. The cascade calls `pullPlayer` with a `url`,
  // never a name target, so `unknown-target` — which only `resolveTargetUrl` produces — cannot be
  // reached through `pullTeam` at all. That unreachability is not a reason to leave the branch
  // unasserted; it is precisely how the branch came to print no reason in the first place. The two
  // integration tests above go through the real pipeline and assert lines this same function built,
  // which is what binds these direct assertions to what an operator actually sees.
  it("an `unknown-target` names the target, even though the cascade itself cannot produce one", () => {
    expect(
      cascadeFailureWarning("Ellis Eastwick", {
        kind: "unknown-target",
        message: 'unknown player target "Ellis Eastwick"',
      }),
    ).toBe(
      'team pull: cascading "Ellis Eastwick" failed (unknown-target) — unknown player target "Ellis Eastwick" — skipped',
    );
  });

  // The OTHER interpolated value. `entry.name` comes off the same fetched roster page, and the
  // integration tests above all pair a benign entry name with a hostile reason — so without this,
  // deleting the sanitizer would still leave the entry-name half of the line unpinned. Asserted on
  // the renderer directly because a control character inside a roster row's profile HREF is a
  // URL-parsing question, not a reporting one, and would test `hrefParam` instead of this line.
  it("sanitizes the cascade target's own name, not only the reason", () => {
    const ESC = String.fromCharCode(0x1b);
    const RTL_OVERRIDE = String.fromCharCode(0x202e);
    const rendered = cascadeFailureWarning(`Ellis${RTL_OVERRIDE}${ESC}[2J Eastwick`, {
      kind: "error",
      message: "fetch failed with status 503",
    });
    expect(rendered).toBe(
      'team pull: cascading "Ellis  [2J Eastwick" failed (error) — fetch failed with status 503 — skipped',
    );
  });

  it("an `ambiguous` renders the three facts through the shared formatter, unchanged from #94", () => {
    const identity = { incoming: "Austin DuBois", candidates: ["Justin DuBois"], context: "match opponent" };
    expect(cascadeFailureWarning("John Jennings", { kind: "ambiguous", ...identity, identities: [identity] })).toBe(
      'team pull: cascading "John Jennings" failed (ambiguous) — ' +
        'ambiguous identity "Austin DuBois" (match opponent) — near: Justin DuBois — skipped',
    );
  });
});
