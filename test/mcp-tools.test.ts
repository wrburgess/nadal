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
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { backfillNameKeys } from "../src/db/name-key.js";
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
    backfillNameKeys(db2); // #32: index-backed name resolution needs the key populated
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

  it("event_add creates the event over MCP, then player_avail resolves against it", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Home Team" }).returning().get();
    const player = db.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
    sqlite.close();

    const client = await connectedClient();
    await client.callTool({ name: "team_home", arguments: { target: team.name } });

    const addResult = await client.callTool({
      name: "event_add",
      arguments: {
        target: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
      },
    });
    expect(addResult.isError).not.toBe(true);
    expect(JSON.parse(textOf(addResult))).toEqual({
      event: "Springfield Sectionals 2026",
      kind: "tournament",
      startsOn: "2026-08-28",
      endsOn: "2026-08-30",
      created: true,
    });

    // The point of the tool: the availability writer now has an event to resolve against, over the
    // same surface, with no out-of-band SQL in between.
    const availResult = await client.callTool({
      name: "player_avail",
      arguments: { target: player.canonicalName, day: "2026-08-29", status: "available" },
    });
    expect(availResult.isError).not.toBe(true);
    expect(JSON.parse(textOf(availResult))).toMatchObject({
      availability: "available",
      event: "Springfield Sectionals 2026",
    });
  });

  it("event_add refuses an invalid kind as a tool error rather than crashing the server", async () => {
    runMigrations();
    const client = await connectedClient();

    const result = await client.callTool({
      name: "event_add",
      arguments: { target: "Springfield", kind: "sectionals", startsOn: "2026-08-28", endsOn: "2026-08-30" },
    });

    expect(result.isError).toBe(true);
    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(events).all(), "a refusal must write nothing").toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  // Found by the independent Codex review of PR #47 (rated medium). MCP tool results carry scraped
  // player and team names and were passed through a bare `JSON.stringify`, which escapes the C0
  // controls but leaves RIGHT-TO-LEFT OVERRIDE and U+2028/U+2029 intact — so the guard the CLI's
  // `--json` path had gained did not cover the second transport over the same services.
  it("sanitizes control and bidi characters out of tool results, matching the CLI --json path", async () => {
    const RTL_OVERRIDE = String.fromCharCode(0x202e);
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: `Team${RTL_OVERRIDE}Versteeg` }).returning().get();
    const p1 = db.insert(players).values({ canonicalName: `Ada${RTL_OVERRIDE}Ashby` }).returning().get();
    const p2 = db.insert(players).values({ canonicalName: "Bo Bramwell" }).returning().get();
    for (const p of [p1, p2]) {
      db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
    }
    const cm = upsertCourtMatch(db, {
      teamMatchId: null,
      slot: "D1",
      discipline: "doubles",
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: "mcp-hostile-1",
    });
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: p1.id, side: "home" });
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: p2.id, side: "home" });
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({ name: "lineup_plan", arguments: { target: team.name } });

    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text, "a bidi override must not reach an MCP client").not.toContain(RTL_OVERRIDE);
    // Still valid JSON of the same shape — sanitizing is not mangling.
    const payload = JSON.parse(text) as { slots: { players: { canonicalName: string }[] }[] };
    expect(payload.slots[0]!.players.some((pl) => pl.canonicalName.startsWith("Ada"))).toBe(true);
  });

  // The other half of the MCP boundary (Codex review of PR #47 round 5, rated medium): refusal
  // messages quote scraped data — `unknown target "<name>"`, `ambiguous target: <candidates>` — so
  // sanitizing only the success path left a hostile name one failed lookup away from an MCP client.
  it("sanitizes control and bidi characters out of tool ERROR results too, not only successes", async () => {
    const RTL_OVERRIDE = String.fromCharCode(0x202e);
    const ESC = String.fromCharCode(0x1b);
    runMigrations();
    const client = await connectedClient();

    // An unknown target, whose message echoes the caller's string back.
    const unknown = await client.callTool({
      name: "team_show",
      arguments: { target: `No${RTL_OVERRIDE}Such${ESC}[2JTeam` },
    });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).not.toContain(RTL_OVERRIDE);
    expect(textOf(unknown)).not.toContain(ESC);
    expect(textOf(unknown), "the diagnostic stays useful").toContain("No");
  });

  it("sanitizes an ambiguous-target refusal, whose message quotes several scraped names", async () => {
    const RTL_OVERRIDE = String.fromCharCode(0x202e);
    runMigrations();
    const { db, sqlite } = openDb();
    // Both names sit within FUZZY_MAX_DISTANCE (2) of the search term, so the lookup lands on the
    // AMBIGUOUS tier and its message quotes both candidates — which is the point: here the hostile
    // characters come from stored rows, not from the caller's own input. The override goes last
    // because `nameKey` does not strip category-Cf characters (findings-log note), so a mid-name
    // one would change the key and the test would pass on an "unknown target" refusal instead.
    db.insert(teams).values({ name: `VersteegA${RTL_OVERRIDE}` }).run();
    db.insert(teams).values({ name: `VersteegB${RTL_OVERRIDE}` }).run();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({ name: "team_show", arguments: { target: "Versteeg" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain(RTL_OVERRIDE);
    expect(textOf(result)).toContain("ambiguous");
  });

  it("still records the ORIGINAL error class in telemetry — sanitizing the message must not blur it", async () => {
    runMigrations();
    const client = await connectedClient();

    await client.callTool({ name: "team_show", arguments: { target: `Ghost${String.fromCharCode(0x202e)}Team` } });

    const rows = requestLogRows(dbFixture.path()).filter((r) => r.surface === "mcp" && r.command === "team_show");
    expect(rows).toHaveLength(1);
    // `error:McpToolError`, not `error:Error` — the sanitizing catch sits OUTSIDE logMcpTool so the
    // telemetry row still names the real class.
    expect(String(rows[0]?.outcome)).toBe("error:McpToolError");
  });

  it("report_build over MCP writes real files via the hardened output-root guard", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(teams).values({ name: "Team R" }).run();
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
    backfillNameKeys(db); // #32: index-backed name resolution needs the key populated
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
