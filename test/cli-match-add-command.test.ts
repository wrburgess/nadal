import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { courtMatches, players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";
import { useTnScorecardPhotosPath } from "./helpers/tn-scorecard-photos.js";

// Task 5, #18: `tn match add <payload-file>` end-to-end through `dispatch`, mirroring
// `test/cli-event-add-command.test.ts`'s shape.

type TestDb = ReturnType<typeof openDb>["db"];

function seedRosters(db: TestDb) {
  const home = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M", nameKey: nameKey("HOA/Burgess-Zingg/40&over3.5M") }).returning().get();
  const visiting = db.insert(teams).values({ name: "Report Opponent", nameKey: nameKey("Report Opponent") }).returning().get();
  const rosterNames: [number, string][] = [
    [home.id, "Ada Ashby"],
    [home.id, "Bo Bramwell"],
    [home.id, "Cy Calder"],
    [visiting.id, "Opp One"],
    [visiting.id, "Opp Two"],
    [visiting.id, "Opp Three"],
  ];
  for (const [teamId, name] of rosterNames) {
    const player = db.insert(players).values({ canonicalName: name, nameKey: nameKey(name) }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId, eventId: null }).run();
  }
  return { home, visiting };
}

function validPayload(homeTeam: string, visitingTeam: string) {
  return {
    playedOn: "2026-08-28",
    homeTeam,
    visitingTeam,
    courts: [
      { slot: "S1", discipline: "singles", homePlayers: ["Ada Ashby"], visitingPlayers: ["Opp One"] },
      {
        slot: "D1",
        discipline: "doubles",
        homePlayers: ["Bo Bramwell", "Cy Calder"],
        visitingPlayers: ["Opp Two", "Opp Three"],
        winnerSide: "home",
        score: "6-3 6-4",
      },
    ],
  };
}

function writeTempFile(name: string, contents: string | Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "tn-match-add-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("tn match add (end-to-end via dispatch)", () => {
  useTnDbPath();
  const rawPath = useTnRawPath();
  const scorecardPhotos = useTnScorecardPhotosPath();
  afterEach(() => vi.restoreAllMocks());

  /** `archivePage` only creates `raw/scorecard/` on an actual write, so "nothing archived" is
   * exactly "this directory does not exist" as much as "it exists and is empty". */
  function rawScorecardEntries(): string[] {
    const dir = join(rawPath.path(), "scorecard");
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  it("writes the match and prints a deterministic summary line, exit 0", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const { home, visiting } = seedRosters(db);
    sqlite.close();

    const payloadPath = writeTempFile("payload.json", JSON.stringify(validPayload(home.name, visiting.name)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", payloadPath]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^match add status=ok home="HOA\/Burgess-Zingg\/40&over3\.5M" visiting="Report Opponent" playedOn="2026-08-28" teamMatchId="\d+" courts=2$/,
      ),
    );

    const check = openDb();
    try {
      expect(check.db.select().from(teamMatches).all()).toHaveLength(1);
      expect(check.db.select().from(courtMatches).all()).toHaveLength(2);
    } finally {
      check.sqlite.close();
    }
  });

  it("a .png handed to the CLI directly refuses — exit 1, status=error, naming the agent path", async () => {
    runMigrations();
    const pngPath = writeTempFile("scorecard.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", pngPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("match_add"));

    const check = openDb();
    try {
      expect(check.db.select().from(teamMatches).all()).toHaveLength(0);
    } finally {
      check.sqlite.close();
    }
  });

  it("a nonexistent payload file refuses as a typed refusal, not an uncaught throw", async () => {
    runMigrations();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", "/no/such/payload.json"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));
  });

  it("malformed JSON refuses as a typed refusal, not an uncaught throw", async () => {
    runMigrations();
    const badPath = writeTempFile("bad.json", "{ this is not json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", badPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));
  });

  it("a payload failing the scorecard schema (e.g. zero courts) refuses as a typed refusal", async () => {
    runMigrations();
    const payload = { playedOn: "2026-08-28", homeTeam: "A", visitingTeam: "B", courts: [] };
    const payloadPath = writeTempFile("empty-courts.json", JSON.stringify(payload));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", payloadPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));
  });

  // PR #54 verify findings 1-2, exercised over the CLI surface for symmetry with the MCP-level
  // tests in test/mcp-tools.test.ts — both presenters call the same service, so both must refuse.
  it("a duplicate resolved player within one court refuses over the CLI too", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const { home, visiting } = seedRosters(db);
    sqlite.close();

    const payload = validPayload(home.name, visiting.name);
    payload.courts[1] = { ...payload.courts[1]!, homePlayers: ["Bo Bramwell", "Bo Bramwell"] };
    const payloadPath = writeTempFile("payload.json", JSON.stringify(payload));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", payloadPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("duplicate participant"));
  });

  it("homeTeam/visitingTeam naming the same team refuses over the CLI too", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const { home } = seedRosters(db);
    sqlite.close();

    const payloadPath = writeTempFile("payload.json", JSON.stringify(validPayload(home.name, home.name)));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", payloadPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("cannot play itself"));
  });

  it("flagged (unresolved) names exit 1 with the names named in the summary", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const home = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M", nameKey: nameKey("HOA/Burgess-Zingg/40&over3.5M") }).returning().get();
    const visiting = db.insert(teams).values({ name: "Report Opponent", nameKey: nameKey("Report Opponent") }).returning().get();
    // Deliberately no roster seeded at all — every name in the payload will flag.
    sqlite.close();

    const payloadPath = writeTempFile("payload.json", JSON.stringify(validPayload(home.name, visiting.name)));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", payloadPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Ada Ashby"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Bo Bramwell"));
  });

  it("--json emits the structured refusal", async () => {
    runMigrations();
    const badPath = writeTempFile("bad.json", "not json at all");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", badPath, "--json"]);

    expect(code).toBe(1);
    const line = errSpy.mock.calls.at(-1)?.[0] as string;
    const parsed: unknown = JSON.parse(line);
    expect(parsed).toMatchObject({ status: "error" });
  });

  // Codex adversarial review of PR #54 round 3, Medium finding 4's own sweep (a title claiming more
  // than the assertion enforces): this test previously only checked that the summary line CONTAINED
  // the substring `archivedPath=`, which passes even if the code fabricated that string without ever
  // archiving anything. Strengthened to actually read the archived file's bytes back off disk.
  it("archives the sourceImage photo and reports the archived path, with the original bytes intact", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const { home, visiting } = seedRosters(db);
    sqlite.close();

    // A small synthetic buffer, never a photograph (test/fixtures/README.md: no scorecard photo is
    // ever committed) — but a REAL 8-byte PNG signature (Codex round 5: archiveScorecardImage now
    // sniffs magic bytes, so a fake/truncated signature would refuse this test's own happy path).
    // Written inside the configured scorecard-photos root (Codex round 5: sourceImage must resolve
    // there now, not to an arbitrary temp directory).
    const sourceBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const imagePath = join(scorecardPhotos.path(), "court1.png");
    writeFileSync(imagePath, sourceBytes);
    const payload = { ...validPayload(home.name, visiting.name), sourceImage: imagePath };
    const payloadPath = writeTempFile("payload.json", JSON.stringify(payload));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", payloadPath]);

    expect(code).toBe(0);
    const line = logSpy.mock.calls.find((call) => typeof call[0] === "string" && call[0].includes("archivedPath="))?.[0] as
      | string
      | undefined;
    expect(line, "expected a summary line containing archivedPath=").toBeDefined();
    const match = /archivedPath="([^"]+)"/.exec(line!);
    expect(match, `expected a quoted archivedPath value in: ${line}`).not.toBeNull();
    const archivedPath = match![1]!;

    expect(existsSync(archivedPath)).toBe(true);
    expect(new Uint8Array(readFileSync(archivedPath))).toEqual(sourceBytes);
    expect(existsSync(`${archivedPath}.provenance.json`)).toBe(true);
  });

  // Codex adversarial review (PR #54 round 5), rated Critical: `archiveScorecardImage` used to run
  // BEFORE `addMatchFromScorecard`, so a payload naming a real, valid `sourceImage` that then
  // refused for an unrelated reason (an unknown team here) still persisted the photo — "a refused
  // ingest must persist nothing" did not hold for it. Archiving now runs only AFTER the service call
  // succeeds (src/ingest/match-add.ts's `addMatchFromScorecardWithArchive`).
  it("REGRESSION (Codex round 5, rated Critical): a refused ingest (unknown team) leaves the sourceImage photo unarchived", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const visiting = db
      .insert(teams)
      .values({ name: "Report Opponent", nameKey: nameKey("Report Opponent") })
      .returning()
      .get();
    sqlite.close();

    const sourceBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const imagePath = join(scorecardPhotos.path(), "court1.png");
    writeFileSync(imagePath, sourceBytes);
    const payload = { ...validPayload("No Such Team", visiting.name), sourceImage: imagePath };
    const payloadPath = writeTempFile("payload.json", JSON.stringify(payload));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", payloadPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));

    const check = openDb();
    try {
      expect(check.db.select().from(teamMatches).all()).toHaveLength(0);
    } finally {
      check.sqlite.close();
    }
    // The assertion that actually proves the fix: before it, this ran unconditionally BEFORE the
    // service call and left a file here even on this exact refusal.
    expect(rawScorecardEntries()).toHaveLength(0);
  });

  // The ordering-interaction Codex explicitly asked to be a deliberate, documented decision rather
  // than an implicit one: once archiving moves AFTER the DB write, a post-commit archive failure can
  // no longer share the write's failure boundary — the match rows already exist. Chosen shape:
  // report it like `tn team pull`'s existing `status=partial` (a requested-but-unfulfilled detail
  // alongside an otherwise-successful, already-committed write), never an opaque `status=error` that
  // would read as "nothing happened" when the match was, in fact, recorded.
  it("REGRESSION (Codex round 5 ordering decision): an archive failure AFTER a successful write reports status=partial with the match rows still committed", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const { home, visiting } = seedRosters(db);
    sqlite.close();

    // A source path OUTSIDE the configured scorecard-photos root — guaranteed to fail archiving,
    // isolating the "committed write, failed archive" interaction from anything else.
    const outsideImagePath = writeTempFile(
      "court1.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    );
    const payload = { ...validPayload(home.name, visiting.name), sourceImage: outsideImagePath };
    const payloadPath = writeTempFile("payload.json", JSON.stringify(payload));
    // `emitSummary` sends anything other than `status=ok` to stderr (src/cli/emit.ts), same as
    // every other non-ok status this command already emits.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", payloadPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=partial"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("archiveError="));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("teamMatchId="));

    const check = openDb();
    try {
      expect(check.db.select().from(teamMatches).all()).toHaveLength(1);
    } finally {
      check.sqlite.close();
    }
  });

  it("refuses a short invocation with the usage line", async () => {
    runMigrations();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("usage: tn match add"));
  });

  it("refuses an unrecognized flag rather than ignoring it — no new value flag is declared", async () => {
    runMigrations();
    const payloadPath = writeTempFile("payload.json", JSON.stringify(validPayload("A", "B")));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["match", "add", payloadPath, "--source-url", "https://example.test"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --source-url"));
  });
});
