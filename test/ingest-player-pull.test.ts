import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { courtMatchPlayers, courtMatches, players, ratingObservations } from "../src/db/schema.js";
import { parseMatchHistory } from "../src/parsers/index.js";
import { resolvePlayer } from "../src/ingest/identity.js";
import { pullPlayer } from "../src/ingest/player-pull.js";
import { FetchError } from "../src/ingest/fetch.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const matchHistory = loadFixture("tennisrecord/match-history");
const empty = loadFixture("tennisrecord/match-history-empty");

describe("pullPlayer", () => {
  useTnDbPath();
  // Without this, a pull archives its pages into the repo own raw/ on every test run.
  const raw = useTnRawPath();

  it("writes court matches, court-match players, and rating observations, hand-verified against the fixture", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const fetcher = createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } });
      const result = await pullPlayer({ db, fetchPage: fetcher, url: matchHistory.source.url });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");

      // Ground truth from the same parser the parser test suite already verifies exhaustively —
      // aggregating it independently here checks the PIPELINE wrote what the parser produced,
      // not a number invented separately from the fixture.
      const expectedRecords = parseMatchHistory(matchHistory.html, matchHistory.source);
      expect(result.courtMatchCount).toBe(expectedRecords.length);
      expect(expectedRecords).toHaveLength(14);

      const courtMatchRows = db.select().from(courtMatches).all();
      expect(courtMatchRows).toHaveLength(14);

      const expectedParticipants = expectedRecords.reduce(
        (sum, r) => sum + 1 /* the profiled player */ + (r.partner === null ? 0 : 1) + r.opponents.length,
        0,
      );
      const participantRows = db.select().from(courtMatchPlayers).all();
      expect(participantRows).toHaveLength(expectedParticipants);

      // Spot-check the first record in full (doubles, both sides populated).
      const firstCourtMatch = courtMatchRows.find((c) => c.sourceMatchId === "20336");
      expect(firstCourtMatch).toMatchObject({ slot: "D2", discipline: "doubles", score: "7-6 6-3" });
      const firstParticipants = participantRows.filter((p) => p.courtMatchId === firstCourtMatch?.id);
      expect(firstParticipants).toHaveLength(4); // profiled player + partner + 2 opponents

      const ratingRows = db.select().from(ratingObservations).all();
      expect(ratingRows).toHaveLength(2);
      expect(ratingRows.find((r) => r.source === "ntrp")).toMatchObject({
        value: 4.0,
        ratingType: "C",
        observedOn: "2025-12-31",
      });
      expect(ratingRows.find((r) => r.source === "tr_dynamic")).toMatchObject({
        value: 3.6663,
        observedOn: "2026-07-27",
      });

      const playerRows = db.select().from(players).all();
      const profiled = playerRows.find((p) => p.canonicalName === "Avery Ashby");
      expect(profiled).toBeDefined();
      expect(profiled?.tennisrecordUrl).toBe(matchHistory.source.url);
    } finally {
      sqlite.close();
    }
  });

  it("a season with no matches writes zero court matches and still succeeds", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const fetcher = createStubFetcher({ [empty.source.url]: { body: empty.html } });
      const result = await pullPlayer({ db, fetchPage: fetcher, url: empty.source.url });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.courtMatchCount).toBe(0);
      expect(db.select().from(courtMatches).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  // The claim `docs/runbooks/pre-tournament-full-pull.md` step 3 makes to an operator: all-or-nothing
  // is about the DATABASE, not the disk. `archivePage` runs before parsing, so a refused pull still
  // leaves the fetched page and its provenance under TN_RAW_PATH — and the refusal does NOT report
  // the path, because only the `ok` result carries `archivedPath`. Both halves pinned here, because
  // the first draft of that sentence said "nothing of this player's history is on file until it
  // succeeds", which is false about the disk (found by the independent Codex review of this PR,
  // rated low, class A — the claim-vs-code lens).
  it("a REFUSED pull still archives the page it fetched, and reports no path for it", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // One edit from the fixture's first partner, so that name resolves ambiguous and the pull
      // refuses. Asserting the kind below is what fails loudly if this stops being a near-name.
      resolvePlayer(db, { name: "Novo Norbury" });

      const result = await pullPlayer({
        db,
        fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
        url: matchHistory.source.url,
      });

      expect(result.kind).toBe("ambiguous");
      // The path is not on the result at all, so no reporting surface can print it — which is why
      // the runbook tells an operator to find the file by its slug instead.
      expect("archivedPath" in result).toBe(false);

      // CONTENTS, not a file count. Counting the pair leaves the claim satisfied by an archive that
      // captured the wrong bytes: swap `body` for `""` at the `archivePage` call while still parsing
      // the real page, and a count-only assertion stays green with nothing useful on disk — so what
      // the runbook offers an operator ("inspect what was fetched") would be a lie the test agreed
      // with. Found by the fix-verification pass on this very fix, rated medium.
      const dir = join(raw.path(), "tennisrecord");
      const archived = readdirSync(dir);
      const html = archived.filter((f) => f.endsWith(".html"));
      const provenance = archived.filter((f) => f.endsWith(".provenance.json"));
      expect(html).toHaveLength(1);
      expect(provenance).toHaveLength(1);
      expect(readFileSync(join(dir, html[0]!), "utf8")).toBe(matchHistory.html);
      expect(JSON.parse(readFileSync(join(dir, provenance[0]!), "utf8"))).toMatchObject({
        sourceUrl: matchHistory.source.url,
        httpStatus: 200,
        redacted: false,
        bytes: Buffer.byteLength(matchHistory.html, "utf8"),
      });
      // The pair describes ONE capture: the provenance leaf is the html leaf's name plus a suffix.
      expect(provenance[0]).toBe(`${html[0]}.provenance.json`);
    } finally {
      sqlite.close();
    }
  });

  it("SAD: a structurally broken page returns an error and writes ZERO rows (asserted, not assumed)", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const broken = matchHistory.html.replace(/<div class="large">/, '<div class="gone">');
      expect(broken).not.toBe(matchHistory.html);

      const fetcher = createStubFetcher({ [matchHistory.source.url]: { body: broken } });
      const result = await pullPlayer({ db, fetchPage: fetcher, url: matchHistory.source.url });

      expect(result.kind).toBe("error");
      expect(db.select().from(players).all()).toHaveLength(0);
      expect(db.select().from(courtMatches).all()).toHaveLength(0);
      expect(db.select().from(courtMatchPlayers).all()).toHaveLength(0);
      expect(db.select().from(ratingObservations).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});

/**
 * Issue #98. Every non-`ok` outcome carries a `disposition`, decided where the TYPED error is still
 * in hand — `pullPlayer` flattens each one to a `message: string` on its way out, and a caller that
 * tried to classify from that string would be matching text a fetched page can influence.
 *
 * One case per producing site, because the three sites are independent edits and a single test would
 * pass while two of them still returned an unclassified failure.
 */
describe("pullPlayer disposition (#98)", () => {
  useTnDbPath();
  useTnRawPath();

  /** A fetcher that fails with exactly `failure` — the fetch `catch` site's input. */
  function throwingFetcher(failure: unknown) {
    return async () => {
      throw failure;
    };
  }

  it("reports a 5xx fetch failure as retryable — the rate-limited case #98 measured", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const url = matchHistory.source.url;
      const result = await pullPlayer({
        db,
        fetchPage: throwingFetcher(new FetchError(`fetch failed with status 503: ${url}`, 503, url)),
        url,
      });
      expect(result).toMatchObject({ kind: "error", disposition: "retryable" });
    } finally {
      sqlite.close();
    }
  });

  it("reports a 404 fetch failure as permanent — retrying reproduces it", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const url = matchHistory.source.url;
      const result = await pullPlayer({
        db,
        fetchPage: throwingFetcher(new FetchError(`fetch failed with status 404: ${url}`, 404, url)),
        url,
      });
      expect(result).toMatchObject({ kind: "error", disposition: "permanent" });
    } finally {
      sqlite.close();
    }
  });

  it("reports a parse failure as permanent — the page changed shape", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const broken = matchHistory.html.replace(/<div class="large">/, '<div class="gone">');
      expect(broken).not.toBe(matchHistory.html);
      const result = await pullPlayer({
        db,
        fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: broken } }),
        url: matchHistory.source.url,
      });
      expect(result).toMatchObject({ kind: "error", disposition: "permanent" });
    } finally {
      sqlite.close();
    }
  });

  it("reports an ambiguous identity as permanent — it refuses identically until someone rules", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Novo Norbury" });
      const result = await pullPlayer({
        db,
        fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
        url: matchHistory.source.url,
      });
      expect(result).toMatchObject({ kind: "ambiguous", disposition: "permanent" });
    } finally {
      sqlite.close();
    }
  });

  it("reports an unknown target as permanent — no retry finds a player who is not on file", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const result = await pullPlayer({
        db,
        fetchPage: createStubFetcher({}),
        target: "Nobody On File",
      });
      expect(result).toMatchObject({ kind: "unknown-target", disposition: "permanent" });
    } finally {
      sqlite.close();
    }
  });

  /**
   * The OTHER `unknown-target` branch, and the one an operator actually meets: a player who IS on
   * file but has no stored handle, because a `--players` cascade created them from a roster row that
   * carried no profile link. `resolveTargetUrl` finds the row, sees `tennisrecordUrl === null`, and
   * refuses with the same message a never-seen name gets.
   *
   * This is the trace behind a runbook correction (`docs/runbooks/pre-tournament-full-pull.md` step 2):
   * that step used to tell an operator to pull such a player individually by name, which cannot work.
   * Pinned here so the doc's claim rests on an executed check rather than on a reading of the code.
   * (Found by the independent Codex review of PR #119, rated medium.)
   */
  it("refuses a resolved player who has no stored handle — the no-profile-link roster case", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // Exactly what `pullTeam` does for a roster row with no profile link: resolve the name,
      // creating the row, and never supply a URL.
      const created = resolvePlayer(db, { name: "Uma Unlinked" });
      expect(created.kind).toBe("created");
      if (created.kind === "ambiguous") throw new Error("expected a resolved row");
      expect(created.row.tennisrecordUrl, "the roster page supplied no URL").toBeNull();

      const result = await pullPlayer({ db, fetchPage: createStubFetcher({}), target: "Uma Unlinked" });

      expect(result).toMatchObject({
        kind: "unknown-target",
        message: 'unknown player target "Uma Unlinked"',
        disposition: "permanent",
      });
    } finally {
      sqlite.close();
    }
  });

  /**
   * The THIRD catch site — the one around the write transaction, which the two above never reach.
   * `db` is an injected seam, so a transaction that throws a contention code is reachable without
   * mocking anything inside the pull. Left uncovered, this site would return `unclassified` for a
   * `SQLITE_BUSY` that the classifier itself calls retryable, and only a test that gets INSIDE the
   * transaction would notice.
   */
  it("reports SQLITE_BUSY from the write transaction as retryable", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const contended = {
        ...db,
        transaction: () => {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        },
      } as unknown as typeof db;

      const result = await pullPlayer({
        db: contended,
        fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
        url: matchHistory.source.url,
      });
      expect(result).toMatchObject({ kind: "error", disposition: "retryable" });
    } finally {
      sqlite.close();
    }
  });
});
