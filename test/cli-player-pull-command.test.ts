import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations } from "../src/db/client.js";
import * as fetchModule from "../src/ingest/fetch.js";
import * as playerPullModule from "../src/ingest/player-pull.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const matchHistory = loadFixture("tennisrecord/match-history");
const usta = loadFixture("usta/profile-wtn-both");
const wtnProfile = loadFixture("wtn/profile-full");

function requestLogRows(dbPath: string) {
  const sqlite = new Database(dbPath);
  const rows = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
  sqlite.close();
  return rows;
}

describe("tn player pull (end-to-end via dispatch)", () => {
  const dbFixture = useTnDbPath("cmd.db");
  useTnRawPath();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints exactly one status=ok summary line and exits 0", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: matchHistory.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "pull", matchHistory.source.url]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toMatch(
      /^player pull status=ok player=".+" matches=14 archived=".+"$/,
    );
  });

  it("round-trips a player name containing a double quote, a backslash, and a newline, un-spoofed", async () => {
    runMigrations();
    vi.spyOn(playerPullModule, "pullPlayer").mockResolvedValue({
      kind: "ok",
      player: {
        id: 1,
        canonicalName: 'Weird"Player\\Name\nstatus=error',
        ustaUaid: null,
        wtnTennisId: null,
        trNameKey: null,
        ageRange: null,
        gender: null,
        tennisrecordUrl: null,
        nameKey: null,
        nameKeyLength: null,
      },
      courtMatchCount: 0,
      archivedPath: "raw/tennisrecord/x.html",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "pull", "https://www.tennisrecord.com/x"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed.split("\n")).toHaveLength(1);
    const match = /player="((?:[^"\\]|\\.)*)"/.exec(printed);
    expect(match).not.toBeNull();
    const decoded = (match?.[1] ?? "").replace(/\\(.)/g, "$1");
    expect(decoded).toBe('Weird"Player\\Name status=error');
  });

  it("--from ingests an archived TennisRecord page without calling the fetcher", async () => {
    runMigrations();
    const raw = process.env.TN_RAW_PATH ?? "raw";
    const savedPath = join(raw, "saved-match-history.html");
    writeFileSync(savedPath, matchHistory.html, "utf8");
    const fetchSpy = vi.spyOn(fetchModule, "fetchPage");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "player",
      "pull",
      "tr:ignored",
      "--from",
      savedPath,
      "--source-url",
      matchHistory.source.url,
    ]);

    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls[0]?.[0]).toMatch(/^player pull status=ok/);
  });

  it("a usta: target with --from ingests via the login-assisted archived path, without calling the fetcher", async () => {
    runMigrations();
    const raw = process.env.TN_RAW_PATH ?? "raw";
    const savedPath = join(raw, "saved-usta.html");
    writeFileSync(savedPath, usta.html, "utf8");
    const fetchSpy = vi.spyOn(fetchModule, "fetchPage");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "player",
      "pull",
      "usta:900000002",
      "--from",
      savedPath,
      "--source-url",
      usta.source.url,
    ]);

    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls[0]?.[0]).toMatch(/^player pull status=ok player="Umber Ulverton"/);
  });

  it("a usta: target with no --from exits 1 (this tool never automates a login)", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "pull", "usta:900000002"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("login-assisted"));
  });

  it("a wtn-profile: target with --from ingests via the login-assisted archived path (#128), without calling the fetcher", async () => {
    // Issue #128's new route: enriching `ageRange`/`gender` off a player's OWN WTN profile page —
    // a different page from the `wtn:` target above, which names the USTA-embedded ITF widget and
    // is unchanged by this issue (its meaning is documented and this test does not touch it).
    runMigrations();
    const raw = process.env.TN_RAW_PATH ?? "raw";
    const savedPath = join(raw, "saved-wtn-profile.html");
    writeFileSync(savedPath, wtnProfile.html, "utf8");
    const fetchSpy = vi.spyOn(fetchModule, "fetchPage");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "player",
      "pull",
      "wtn-profile:MER9000003",
      "--from",
      savedPath,
      "--source-url",
      wtnProfile.source.url,
    ]);

    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // No player named "micah merrivale" is on file, so identity resolution creates one from the
    // page's own spelling (`resolvePlayer`'s name-tier fallback) — the same outcome an unmatched
    // `usta:`/`wtn:` pull would report.
    expect(logSpy.mock.calls[0]?.[0]).toMatch(/^player pull status=ok player="micah merrivale"/);
  });

  it("a wtn-profile: target with no --from exits 1, and says WHY without claiming a login is needed", async () => {
    // Codex adversarial review round 3, class C. This target still requires a saved page, but for a
    // different reason than `usta:`/`wtn:` do: the page is PUBLIC and merely client-rendered. The
    // error used to say "login-assisted path", which sends an operator to sign in to a site that
    // needs no account — and contradicted docs/runbooks/capture-wtn-profile.md, shipped in the same
    // PR, which says explicitly not to.
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "pull", "wtn-profile:MER9000003"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--from"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no login needed"));
    // The false claim must be gone, not merely accompanied by a true one.
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("login-assisted"));
  });

  it("an unknown target exits 1 with a message on stderr and writes no player row", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "pull", "Somebody Nobody Has Ever Pulled"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^player pull status=error message=".+"$/));

    const rows = new Database(dbFixture.path()).prepare("SELECT * FROM players").all();
    expect(rows).toHaveLength(0);
  });

  it("an unrecognized flag exits 1", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "pull", "some-target", "--bogus"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --bogus"));
  });

  it("logs a request_log row on both the ok and the error path", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: matchHistory.html,
      fetchedAt: new Date().toISOString(),
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await dispatch(["player", "pull", matchHistory.source.url]);
    await dispatch(["player", "pull", "--bogus-flag", "x"]);

    const rows = requestLogRows(dbFixture.path());
    const commands = rows.map((r) => r.command);
    expect(commands.filter((c) => c === "player pull")).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(["ok", "error:exit-1"]));
  });
});
