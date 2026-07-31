import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations } from "../src/db/client.js";
import * as fetchModule from "../src/ingest/fetch.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

// Unit tests cover `emitSummary` (test/cli-emit.test.ts) and `parseArgs`/`globalFlags`
// (test/cli-args.test.ts) in isolation. Neither proves the pieces are actually WIRED into a real
// command: `team pull`/`player pull` must read `--json`/`--quiet` out of their own `parsed.flags`
// and pass them through. This file is that wiring check, via the same `dispatch` end-to-end
// pattern the existing pull-command suites use.

const team = loadFixture("tennisrecord/team");
const matchHistory = loadFixture("tennisrecord/match-history");

describe("tn team pull — global flags wired end-to-end", () => {
  useTnDbPath("cmd.db");
  useTnRawPath();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--json emits a parseable JSON object and no summary line", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "--json"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).not.toMatch(/^team pull /);
    const parsed = JSON.parse(printed) as Record<string, unknown>;
    expect(parsed).toMatchObject({ status: "ok", roster: 18, matches: 10 });
  });

  it("--quiet emits nothing on stdout but preserves the exit code", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("-q emits nothing on stdout but preserves the exit code (short alias)", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "-q"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("--quiet does not suppress the stderr error diagnostic on an unknown target", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", "Some Team Nobody Has Pulled Before", "--quiet"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^team pull status=error message=".+"$/));
  });

  it("--quiet wins when --json is also passed", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: team.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "pull", team.source.url, "--json", "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("tn player pull — global flags wired end-to-end", () => {
  useTnDbPath("cmd.db");
  useTnRawPath();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--json emits a parseable JSON object and no summary line", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: matchHistory.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "pull", matchHistory.source.url, "--json"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).not.toMatch(/^player pull /);
    const parsed = JSON.parse(printed) as Record<string, unknown>;
    expect(parsed).toMatchObject({ status: "ok", matches: 14 });
  });

  it("--quiet emits nothing on stdout but preserves the exit code", async () => {
    runMigrations();
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: matchHistory.html,
      fetchedAt: new Date().toISOString(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "pull", matchHistory.source.url, "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("an unrecognized flag still errors even with a global flag present (typo protection preserved)", async () => {
    runMigrations();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "pull", "some-target", "--json", "--bogus"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --bogus"));
  });
});
