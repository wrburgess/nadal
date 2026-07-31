// Real in-process MCP client/server dispatch — an `InMemoryTransport` pair connecting a genuine
// `@modelcontextprotocol/sdk` `Client` to `createMcpServer()`'s real `McpServer`, rather than calling
// `MCP_TOOLS` handlers directly. This is deliberate: the plan's highest-value assertion here is that
// the SDK's OWN request/response/validation machinery is exercised end to end, not just this
// module's handler functions in isolation.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { events, players, teamMemberships, teams } from "../src/db/schema.js";
import * as fetchModule from "../src/ingest/fetch.js";
import { createMcpServer } from "../src/mcp/server.js";
import { getTeamProfile } from "../src/query/team-profile.js";
import { sixMonthsAgo } from "../src/cli/window.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

type ToolTextContent = { type: "text"; text: string };

async function connectedClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as ToolTextContent[];
  return content[0]!.text;
}

function requestLogRows(dbPath: string) {
  const sqlite = new Database(dbPath);
  const rows = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
  sqlite.close();
  return rows;
}

describe("MCP tool dispatch (real client/server over InMemoryTransport)", () => {
  const dbFixture = useTnDbPath("mcp.db");
  useTnRawPath();
  let reportsDir: string;
  const originalReportsPath = process.env.TN_REPORTS_PATH;

  beforeEach(() => {
    reportsDir = mkdtempSync(join(tmpdir(), "tn-mcp-reports-"));
    process.env.TN_REPORTS_PATH = reportsDir;
  });

  afterEach(() => {
    if (originalReportsPath === undefined) delete process.env.TN_REPORTS_PATH;
    else process.env.TN_REPORTS_PATH = originalReportsPath;
    rmSync(reportsDir, { recursive: true, force: true });
  });

  it("db_migrate can be the first tool called against a brand-new, unmigrated database — server construction never opens the DB", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "db_migrate", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({ status: "ok" });
  });

  it("team_show over MCP returns the SAME payload as calling the shared service function directly — proves the service layer is shared, not re-implemented", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Team A" }).returning().get();
    const player = db.insert(players).values({ canonicalName: "Player One" }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({ name: "team_show", arguments: { target: team.name } });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result));

    const { db: db2, sqlite: sqlite2 } = openDb();
    let expected: unknown;
    try {
      expected = getTeamProfile(db2, team.id, { since: sixMonthsAgo() });
    } finally {
      sqlite2.close();
    }
    expect(payload).toEqual(expected);
  });

  it("a required argument missing returns a structured error result, not a crash — and the server keeps working afterward", async () => {
    runMigrations();
    const client = await connectedClient();

    const result = await client.callTool({ name: "team_show", arguments: {} });
    expect(result.isError).toBe(true);

    // "Not a crash" proven concretely: the same connection answers a valid call right after.
    const followUp = await client.callTool({ name: "db_migrate", arguments: {} });
    expect(followUp.isError).not.toBe(true);
  });

  it("an unknown tool name returns a structured error result", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "bogus_tool", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("an unknown target on team_show returns a structured error result naming the reason", async () => {
    runMigrations();
    const client = await connectedClient();
    const result = await client.callTool({ name: "team_show", arguments: { target: "No Such Team" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No Such Team");
  });

  it("a tool that throws produces BOTH an error result AND an error:<ClassName> telemetry row", async () => {
    runMigrations();
    const client = await connectedClient();

    const result = await client.callTool({ name: "team_show", arguments: { target: "No Such Team" } });
    expect(result.isError).toBe(true);

    const rows = requestLogRows(dbFixture.path());
    const teamShowRows = rows.filter((r) => r.surface === "mcp" && r.command === "team_show");
    expect(teamShowRows).toHaveLength(1);
    expect(String(teamShowRows[0]?.outcome)).toMatch(/^error:/);
  });

  it("a successful tool call writes an mcp-surface telemetry row with outcome=ok", async () => {
    runMigrations();
    const client = await connectedClient();

    await client.callTool({ name: "db_migrate", arguments: {} });

    const rows = requestLogRows(dbFixture.path());
    const migrateRows = rows.filter((r) => r.surface === "mcp" && r.command === "db_migrate");
    expect(migrateRows).toHaveLength(1);
    expect(migrateRows[0]?.outcome).toBe("ok");
  });

  it("team_home / player_avail / player_note round-trip through MCP using the same write services as the CLI", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Home Team" }).returning().get();
    sqlite.close();

    const client = await connectedClient();

    const homeResult = await client.callTool({ name: "team_home", arguments: { target: team.name } });
    expect(homeResult.isError).not.toBe(true);
    expect(JSON.parse(textOf(homeResult))).toEqual({ team: team.name });

    const { db: db2, sqlite: sqlite2 } = openDb();
    const event = db2
      .insert(events)
      .values({ name: "Event", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
      .returning()
      .get();
    const player = db2.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
    db2.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: event.id }).run();
    sqlite2.close();

    const availResult = await client.callTool({
      name: "player_avail",
      arguments: { target: player.canonicalName, day: "2026-08-29", status: "available" },
    });
    expect(availResult.isError).not.toBe(true);
    expect(JSON.parse(textOf(availResult))).toMatchObject({ availability: "available", day: "2026-08-29" });

    const noteResult = await client.callTool({
      name: "player_note",
      arguments: { target: player.canonicalName, text: "Big serve on big points." },
    });
    expect(noteResult.isError).not.toBe(true);
    expect(JSON.parse(textOf(noteResult))).toMatchObject({ note: "Big serve on big points." });
  });

  it("report_build over MCP writes real files via the hardened output-root guard", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(teams).values({ name: "Team R" }).run();
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({ name: "report_build", arguments: {} });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as { teams: number; files: number };
    expect(payload.teams).toBe(1);
    expect(payload.files).toBeGreaterThan(0);
  });

  it("report_build over MCP with an explicit team target builds exactly that team's dossier", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Team Solo" }).returning().get();
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({ name: "report_build", arguments: { target: team.name } });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as { target: string; teams: number; files: number; root: string };
    expect(payload).toEqual({ target: team.name, teams: 1, files: 2, root: payload.root });
  });

  it("an ambiguous target returns a structured error result listing candidates", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(teams).values([{ name: "Team Alpha" }, { name: "Team Alpho" }]).run();
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({ name: "team_show", arguments: { target: "Team Alph" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ambiguous");
  });

  it("team_pull over MCP calls the exact same pullTeam service the CLI uses (no re-implementation), via a stubbed fetcher", async () => {
    runMigrations();
    const teamFixture = loadFixture("tennisrecord/team");
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: teamFixture.html,
      fetchedAt: new Date().toISOString(),
    }));

    const client = await connectedClient();
    const result = await client.callTool({ name: "team_pull", arguments: { target: teamFixture.source.url } });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as { team: string; rosterCount: number };
    expect(payload.rosterCount).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });

  it("player_pull over MCP calls the exact same pullPlayer service the CLI uses, via a stubbed fetcher", async () => {
    runMigrations();
    const matchHistory = loadFixture("tennisrecord/match-history");
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: matchHistory.html,
      fetchedAt: new Date().toISOString(),
    }));

    const client = await connectedClient();
    const result = await client.callTool({ name: "player_pull", arguments: { target: matchHistory.source.url } });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as { player: string; courtMatchCount: number };
    expect(payload.courtMatchCount).toBe(14);

    vi.restoreAllMocks();
  });

  it("player_pull over MCP requires from+sourceUrl together for a usta:/wtn: (login-gated) target", async () => {
    runMigrations();
    const client = await connectedClient();
    const result = await client.callTool({ name: "player_pull", arguments: { target: "usta:https://example.test" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("login-assisted");
  });

  it("player_note with a pairTarget records a pairing note via MCP, resolving the SECOND name the same way as the first", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Pair Team" }).returning().get();
    const a = db.insert(players).values({ canonicalName: "Player A" }).returning().get();
    const b = db.insert(players).values({ canonicalName: "Player B" }).returning().get();
    db.insert(teamMemberships).values({ playerId: a.id, teamId: team.id, eventId: null }).run();
    db.insert(teamMemberships).values({ playerId: b.id, teamId: team.id, eventId: null }).run();
    sqlite.close();

    const client = await connectedClient();
    await client.callTool({ name: "team_home", arguments: { target: team.name } });
    const result = await client.callTool({
      name: "player_note",
      arguments: { target: "Player A", pairTarget: "Player B", text: "Strong together." },
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as { pairPlayerId: number };
    expect(payload.pairPlayerId).toBe(b.id);
  });

  it("player_note with an unresolvable pairTarget returns a structured error result", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Solo Team" }).returning().get();
    const a = db.insert(players).values({ canonicalName: "Solo Player" }).returning().get();
    db.insert(teamMemberships).values({ playerId: a.id, teamId: team.id, eventId: null }).run();
    sqlite.close();

    const client = await connectedClient();
    await client.callTool({ name: "team_home", arguments: { target: team.name } });
    const result = await client.callTool({
      name: "player_note",
      arguments: { target: "Solo Player", pairTarget: "No Such Player", text: "Text." },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("pairTarget");
  });
});
