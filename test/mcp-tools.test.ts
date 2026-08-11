// Real in-process MCP client/server dispatch — an `InMemoryTransport` pair connecting a genuine
// `@modelcontextprotocol/sdk` `Client` to `createMcpServer()`'s real `McpServer`, rather than calling
// `MCP_TOOLS` handlers directly. This is deliberate: the plan's highest-value assertion here is that
// the SDK's OWN request/response/validation machinery is exercised end to end, not just this
// module's handler functions in isolation.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { courtMatchPlayers, courtMatches, events, players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import * as fetchModule from "../src/ingest/fetch.js";
import * as teamPullModule from "../src/ingest/team-pull.js";
import { resolvePlayer } from "../src/ingest/identity.js";
import { setEventRoster } from "../src/ingest/roster-set.js";
import { createMcpServer } from "../src/mcp/server.js";
import { encodeEventFormat } from "../src/query/event-format.js";
import { addEvent } from "../src/query/events.js";
import { getTeamProfile } from "../src/query/team-profile.js";
import { evidenceWindow, windowSnapshot, windowStart } from "../src/cli/window.js";
import { loadFixture } from "./helpers/fixtures.js";
import { removeRosterRow } from "./helpers/roster-html.js";
import { seedTeamWithRosters } from "./helpers/roster.js";
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

  // Issue #111 on the MCP surface specifically. This is the surface the defect was WORST on and the
  // one docs/runbooks/agent-chat-over-mcp.md already documents at length: an MCP server inherits its
  // working directory from the client's own config, so before this fix a server started with the
  // wrong cwd silently created an empty database and then answered every query from it — an agent
  // driving nadal got confident, well-formed, empty answers with nothing anywhere saying why.
  //
  // `openDb()` now refuses, and the assertion that matters is that the refusal arrives as a legible
  // tool result rather than a crash or an opaque failure: `src/mcp/server.ts` relies on the SDK
  // converting ANY handler throw into `{ isError: true }`, and MissingDatabaseError is not an
  // McpToolError, so nothing but that general conversion carries it. Worth pinning, because the
  // ~14 `openDb()` call sites in src/mcp/tools.ts inherit the new `create: false` default without
  // this PR touching a line of that file.
  it("a non-bootstrap tool against a missing database refuses legibly instead of creating an empty one", async () => {
    const client = await connectedClient();

    // No runMigrations() — the fixture's TN_DB_PATH names a path that does not exist yet.
    expect(existsSync(dbFixture.path())).toBe(false);

    const result = await client.callTool({ name: "team_show", arguments: { target: "Team A" } });

    expect(result.isError).toBe(true);
    const message = textOf(result);
    expect(message).toContain(resolve(dbFixture.path()));
    expect(message).toContain("tn db migrate");

    // The whole point: the refusal did not bootstrap the very database it refused to open.
    expect(existsSync(dbFixture.path())).toBe(false);

    // "Not a crash" proven concretely, the same way the sibling refusal test above does it: the
    // same connection still answers after the failure.
    const after = await client.callTool({ name: "db_migrate", arguments: {} });
    expect(after.isError).not.toBe(true);
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
      // #122 round-1 Finding 1: `getTeamProfile` now takes `window` (an `EvidenceWindowDisclosure`),
      // not a bare `since` — this pins the parity claim against the SAME shape the real handler
      // builds (src/mcp/tools.ts's `team_show`: `windowSnapshot(evidenceWindow(anchor))`).
      expected = getTeamProfile(db2, team.id, { window: windowSnapshot(evidenceWindow()) });
    } finally {
      sqlite2.close();
    }
    expect(payload).toEqual(expected);
  });

  // #122 round-1 fold (found while fixing Finding 1, pre-existing): the CLI's `tn team show
  // <team> <event>` passes the resolved event's id into `getTeamProfile`, so its roster is scoped
  // to the event's registrations (#113) — MCP's `team_show` resolved the same event for league
  // scope and window but dropped `eventId`, so the two doors described different rosters for the
  // same arguments (ARCHITECTURE.md §5 question 3, the exact drift the parity discipline exists
  // to catch). This pins the MCP door to the registered scope.
  it("team_show scopes its roster to the named event's registrations, like the CLI door", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    seedTeamWithRosters(db, {
      teamName: "OK/Dickason",
      season: ["Alice Adams", "Bob Brown", "Cara Cole"],
      registered: { eventName: "Springfield Sectionals", names: ["Alice Adams"] },
    });
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "team_show",
      arguments: { target: "OK/Dickason", event: "Springfield Sectionals" },
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as {
      rosterSource: string;
      roster: { canonicalName: string }[];
      absentRoster: { canonicalName: string }[];
    };

    expect(payload.rosterSource).toBe("registered");
    expect(payload.roster.map((r) => r.canonicalName)).toEqual(["Alice Adams"]);
    // The not-registered watch list is part of the same #113 contract — present, not dropped.
    expect(payload.absentRoster.map((r) => r.canonicalName).sort()).toEqual(["Bob Brown", "Cara Cole"]);
  });

  // Issue #49: an explicit wire-shape pin. `player_show`'s handler returns `getPlayerProfile`
  // VERBATIM (src/mcp/tools.ts), so the new `retiredAt` field is additive and automatic — but
  // `test/mcp-tool-parity.test.ts` only checks tool-name/command parity, not payload shape, so
  // nothing else in the suite would notice a silent regression here.
  it("player_show carries retiredAt on a team membership — the new field survives the real MCP wire", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Former Team" }).returning().get();
    const player = db.insert(players).values({ canonicalName: "Departed Player" }).returning().get();
    db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    db.update(teamMemberships)
      .set({ retiredAt: "2026-07-01T00:00:00.000Z" })
      .where(eq(teamMemberships.playerId, player.id))
      .run();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({ name: "player_show", arguments: { target: player.canonicalName } });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as { teamMemberships: { teamId: number; retiredAt: string | null }[] };

    // #131 added `eventName` (the LEFT-joined `events.name`) to this shape. Pinned here as well as
    // in `test/query-player-profile.test.ts` on purpose: this test's own header says nothing else in
    // the suite would notice a silent regression on the MCP wire, and the CLI's `--json` and this
    // tool return the SAME object — so a field that reaches one door and not the other is guarded by
    // nothing. `eventName` is null on a season row and never on a registration.
    expect(payload.teamMemberships).toEqual([
      {
        teamId: team.id,
        teamName: "Former Team",
        eventId: null,
        eventName: null,
        retiredAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
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
    // #129: `player` carries an EVENT-scoped membership above, so they are on the roster the
    // dossier's own availability grid renders for this event.
    expect(JSON.parse(textOf(availResult))).toMatchObject({
      availability: "available",
      day: "2026-08-29",
      onEventRoster: true,
    });

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

  // #129: the writer's own roster check is deliberately wider than the dossier's roster — a
  // season-roster player who has not registered for the resolved event still writes over MCP too,
  // and the result says so rather than leaving it a silent gap between the write and the dossier.
  it("player_avail reports onEventRoster: false for a season-roster player not registered for the resolved event", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Home Team" }).returning().get();
    const event = db
      .insert(events)
      .values({ name: "Springfield Sectionals 2026", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" })
      .returning()
      .get();
    // One EVENT-scoped member — gives the event a registered roster at all.
    const registered = db.insert(players).values({ canonicalName: "Randy Rostered" }).returning().get();
    db.insert(teamMemberships).values({ playerId: registered.id, teamId: team.id, eventId: event.id }).run();
    // A second, SEASON-only member, deliberately not registered for the event above.
    const unregistered = db.insert(players).values({ canonicalName: "Nate Notregistered" }).returning().get();
    db.insert(teamMemberships).values({ playerId: unregistered.id, teamId: team.id, eventId: null }).run();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    await client.callTool({ name: "team_home", arguments: { target: team.name } });

    const availResult = await client.callTool({
      name: "player_avail",
      arguments: { target: unregistered.canonicalName, day: "2026-08-29", status: "available" },
    });
    expect(availResult.isError).not.toBe(true);
    // Stored regardless — a missing signal, not a refusal.
    expect(JSON.parse(textOf(availResult))).toMatchObject({
      availability: "available",
      event: "Springfield Sectionals 2026",
      onEventRoster: false,
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

  // #63: event_add's new optional `format` input, and the twins lineup_plan/report_build gain for
  // an optional `event`.
  it("event_add accepts an optional format over MCP and returns the parsed courts", async () => {
    runMigrations();
    const client = await connectedClient();

    const result = await client.callTool({
      name: "event_add",
      arguments: {
        target: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "S1:singles,D1:doubles",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      event: "Springfield Sectionals 2026",
      kind: "tournament",
      startsOn: "2026-08-28",
      endsOn: "2026-08-30",
      created: true,
      format: [
        { slot: "S1", discipline: "singles" },
        { slot: "D1", discipline: "doubles" },
      ],
    });
  });

  it("event_add refuses an invalid format over MCP as a tool error, writing nothing", async () => {
    runMigrations();
    const client = await connectedClient();

    const result = await client.callTool({
      name: "event_add",
      arguments: {
        target: "Springfield",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "garbage",
      },
    });

    expect(result.isError).toBe(true);
    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(events).all(), "a refusal must write nothing").toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  // #97: `event_add`'s league scope, and the `event` input `player_show`/`team_show` gain so an
  // agent working the pairings in chat (spec § Deliverables 3) reads the SAME scoped records the
  // printed binder does. An agent handed unscoped numbers while the binder shows scoped ones is the
  // drift the parity discipline in this file exists to prevent.
  it("event_add accepts an optional leagueScope over MCP and returns the parsed scope", async () => {
    runMigrations();
    const client = await connectedClient();

    const result = await client.callTool({
      name: "event_add",
      arguments: {
        target: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        leagueScope: "exclude:Mixed",
      },
    });

    expect(result.isError).not.toBe(true);
    // Note the absent `format` key: MCP arguments are KEYED rather than ordered, so a scope is
    // nameable here without also supplying a court list — the one place the CLI's positional-order
    // limitation does not apply.
    expect(JSON.parse(textOf(result))).toEqual({
      event: "Springfield Sectionals 2026",
      kind: "tournament",
      startsOn: "2026-08-28",
      endsOn: "2026-08-30",
      created: true,
      leagueScope: { mode: "exclude", prefixes: ["Mixed"] },
    });
  });

  it("event_add refuses an invalid leagueScope over MCP as a tool error, writing nothing", async () => {
    runMigrations();
    const client = await connectedClient();

    const result = await client.callTool({
      name: "event_add",
      arguments: {
        target: "Springfield",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        leagueScope: "drop:Mixed",
      },
    });

    expect(result.isError).toBe(true);
    const { db, sqlite } = openDb();
    try {
      expect(db.select().from(events).all(), "a refusal must write nothing").toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("player_show and team_show scope their records to a named event, and report what they set aside", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Scoped Team" }).returning().get();
    const nova = db.insert(players).values({ canonicalName: "Nova Norbury" }).returning().get();
    db.insert(teamMemberships).values({ playerId: nova.id, teamId: team.id, eventId: null }).run();
    backfillNameKeys(db);
    let mid = 0;
    for (const league of ["Adult 40+ 3.5", "Mixed 40+ 7.0", "Mixed 18+ 7.0"]) {
      mid += 1;
      const cm = upsertCourtMatch(db, {
        teamMatchId: null,
        slot: "D1",
        discipline: "doubles",
        winnerSide: "home",
        score: "6-3 6-4",
        leagueContext: league,
        playedOn: "2026-05-01",
        sourceMatchId: `mcp-scope-${mid}`,
      });
      upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: nova.id, side: "home" });
    }
    addEvent(db, {
      name: "Springfield Sectionals 2026",
      kind: "tournament",
      startsOn: "2026-08-28",
      endsOn: "2026-08-30",
      leagueScope: "exclude:Mixed",
    });
    sqlite.close();
    const client = await connectedClient();

    for (const name of ["player_show", "team_show"] as const) {
      const target = name === "player_show" ? "Nova Norbury" : "Scoped Team";
      const scoped = JSON.parse(
        textOf(await client.callTool({ name, arguments: { target, event: "Springfield Sectionals 2026" } })),
      ) as { evidenceScope: { retained: number; excluded: number; scope: unknown } };
      const unscoped = JSON.parse(textOf(await client.callTool({ name, arguments: { target } }))) as {
        evidenceScope: { retained: number; excluded: number; scope: unknown };
      };

      expect(scoped.evidenceScope, name).toMatchObject({ retained: 1, excluded: 2 });
      expect(scoped.evidenceScope.scope, name).toEqual({ mode: "exclude", prefixes: ["Mixed"] });
      // The two reads DIFFER, and the unscoped one says positively that it is unscoped.
      expect(unscoped.evidenceScope, name).toMatchObject({ retained: 3, excluded: 0, scope: null });
    }
  });

  it("player_show refuses an unknown event rather than returning unscoped records", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(players).values({ canonicalName: "Nova Norbury" }).returning().get();
    backfillNameKeys(db);
    sqlite.close();
    const client = await connectedClient();

    const result = await client.callTool({
      name: "player_show",
      arguments: { target: "Nova Norbury", event: "Nope" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unknown event");
  });

  it("lineup_plan accepts an optional event over MCP, and its format replaces the derived slot set", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Event Team" }).returning().get();
    const opponent = db.insert(teams).values({ name: "Event Opponent" }).returning().get();
    const p1 = db.insert(players).values({ canonicalName: "Ada Ashby" }).returning().get();
    const p2 = db.insert(players).values({ canonicalName: "Bo Bramwell" }).returning().get();
    for (const p of [p1, p2]) {
      db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
    }
    const tm = db
      .insert(teamMatches)
      .values({ homeTeamId: team.id, visitingTeamId: opponent.id, sourceMatchId: "mcp-event-tm" })
      .returning()
      .get();
    const cm = upsertCourtMatch(db, {
      teamMatchId: tm.id,
      slot: "D1",
      discipline: "doubles",
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: "mcp-event-cm",
    });
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: p1.id, side: "home" });
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: p2.id, side: "home" });
    db.insert(events)
      .values({
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: encodeEventFormat([{ slot: "D1", discipline: "doubles" }]),
      })
      .run();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "lineup_plan",
      arguments: { target: team.name, event: "Springfield Sectionals 2026" },
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as { slotSource: string; slotEvent: { name: string } | null };
    expect(payload.slotSource).toBe("event-format");
    expect(payload.slotEvent).toMatchObject({ name: "Springfield Sectionals 2026" });
  });

  it("lineup_plan over MCP with an unknown event returns a structured error result naming it", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(teams).values({ name: "Event Team" }).run();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "lineup_plan",
      arguments: { target: "Event Team", event: "No Such Event" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No Such Event");
  });

  it("report_build accepts an optional event over MCP and every dossier uses its courts", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Report Event Team" }).returning().get();
    const opponent = db.insert(teams).values({ name: "Report Event Opponent" }).returning().get();
    const p1 = db.insert(players).values({ canonicalName: "Ada Ashby" }).returning().get();
    const p2 = db.insert(players).values({ canonicalName: "Bo Bramwell" }).returning().get();
    for (const p of [p1, p2]) {
      db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
    }
    const tm = db
      .insert(teamMatches)
      .values({ homeTeamId: team.id, visitingTeamId: opponent.id, sourceMatchId: "mcp-report-event-tm" })
      .returning()
      .get();
    const cm = upsertCourtMatch(db, {
      teamMatchId: tm.id,
      slot: "D1",
      discipline: "doubles",
      winnerSide: "home",
      score: "6-3 6-4",
      leagueContext: "40+ 3.5",
      playedOn: "2026-05-01",
      sourceMatchId: "mcp-report-event-cm",
    });
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: p1.id, side: "home" });
    upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: p2.id, side: "home" });
    db.insert(events)
      .values({
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: encodeEventFormat([{ slot: "D1", discipline: "doubles" }]),
      })
      .run();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "report_build",
      arguments: { target: team.name, event: "Springfield Sectionals 2026" },
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as { teams: number; files: number };
    expect(payload.teams).toBe(1);
    expect(payload.files).toBe(2);
  });

  it("match_add writes the same rows as the CLI — same service, asserted through the tool", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const home = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    const visiting = db.insert(teams).values({ name: "Report Opponent" }).returning().get();
    const rosterNames: [number, string][] = [
      [home.id, "Ada Ashby"],
      [home.id, "Bo Bramwell"],
      [home.id, "Cy Calder"],
      [visiting.id, "Opp One"],
      [visiting.id, "Opp Two"],
      [visiting.id, "Opp Three"],
    ];
    const playerIdByName = new Map<string, number>();
    for (const [teamId, name] of rosterNames) {
      const player = db.insert(players).values({ canonicalName: name }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId, eventId: null }).run();
      playerIdByName.set(name, player.id);
    }
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "match_add",
      arguments: {
        playedOn: "2026-08-28",
        homeTeam: home.name,
        visitingTeam: visiting.name,
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
      },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as { teamMatchId: number; courts: number };
    expect(parsed).toMatchObject({ courts: 2 });

    // Codex adversarial review of PR #54 round 3, Medium finding 4: asserting only `{courts: 2}`
    // (the echoed input count) and a single team_matches row would stay green even if the handler
    // wrote the parent and NOTHING else — zero court_matches, zero court_match_players. Assert the
    // actual rows instead: both courts, their result fields, and all six participants by side.
    const check = openDb();
    try {
      const teamMatchRows = check.db.select().from(teamMatches).all();
      expect(teamMatchRows).toHaveLength(1);
      expect(teamMatchRows[0]!.id).toBe(parsed.teamMatchId);

      const courtRows = check.db.select().from(courtMatches).all();
      expect(courtRows).toHaveLength(2);
      expect(courtRows.every((c) => c.teamMatchId === parsed.teamMatchId)).toBe(true);

      const s1 = courtRows.find((c) => c.slot === "S1")!;
      expect(s1).toMatchObject({ discipline: "singles", winnerSide: null, score: null });
      const d1 = courtRows.find((c) => c.slot === "D1")!;
      expect(d1).toMatchObject({ discipline: "doubles", winnerSide: "home", score: "6-3 6-4" });

      const participantRows = check.db.select().from(courtMatchPlayers).all();
      expect(participantRows).toHaveLength(6);

      const s1Sides = new Map(
        participantRows.filter((p) => p.courtMatchId === s1.id).map((p) => [p.playerId, p.side]),
      );
      expect(s1Sides).toEqual(
        new Map([
          [playerIdByName.get("Ada Ashby")!, "home"],
          [playerIdByName.get("Opp One")!, "visiting"],
        ]),
      );

      const d1Sides = new Map(
        participantRows.filter((p) => p.courtMatchId === d1.id).map((p) => [p.playerId, p.side]),
      );
      expect(d1Sides).toEqual(
        new Map([
          [playerIdByName.get("Bo Bramwell")!, "home"],
          [playerIdByName.get("Cy Calder")!, "home"],
          [playerIdByName.get("Opp Two")!, "visiting"],
          [playerIdByName.get("Opp Three")!, "visiting"],
        ]),
      );
    } finally {
      check.sqlite.close();
    }
  });

  it("match_add refusal returns the structured flag list rather than throwing", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const home = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    const visiting = db.insert(teams).values({ name: "Report Opponent" }).returning().get();
    // Deliberately no roster seeded — every player name in the payload will flag.
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "match_add",
      arguments: {
        playedOn: "2026-08-28",
        homeTeam: home.name,
        visitingTeam: visiting.name,
        courts: [{ slot: "S1", discipline: "singles", homePlayers: ["Ada Ashby"], visitingPlayers: ["Opp One"] }],
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Ada Ashby");

    const check = openDb();
    try {
      expect(check.db.select().from(teamMatches).all(), "a refusal must write nothing").toHaveLength(0);
    } finally {
      check.sqlite.close();
    }
  });

  // PR #54 verify finding 3: a cross-field invariant declared only on `scorecardPayloadSchema`
  // itself (rather than in the service) would not survive `inputShape: { ...schema.shape }` here,
  // since that spread carries only PER-KEY validators. Exercised over the REAL MCP transport
  // (not the service function directly) so this proves the guard actually reaches this surface,
  // not just that the service function has one.
  it("match_add refuses a duplicate resolved player within one court over MCP too — the guard is not schema-only", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const home = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    const visiting = db.insert(teams).values({ name: "Report Opponent" }).returning().get();
    for (const [teamId, name] of [
      [home.id, "Bo Bramwell"],
      [visiting.id, "Opp Two"],
      [visiting.id, "Opp Three"],
    ] as const) {
      const player = db.insert(players).values({ canonicalName: name }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId, eventId: null }).run();
    }
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "match_add",
      arguments: {
        playedOn: "2026-08-28",
        homeTeam: home.name,
        visitingTeam: visiting.name,
        courts: [
          {
            slot: "D1",
            discipline: "doubles",
            homePlayers: ["Bo Bramwell", "Bo Bramwell"],
            visitingPlayers: ["Opp Two", "Opp Three"],
          },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("duplicate participant");

    const check = openDb();
    try {
      expect(check.db.select().from(teamMatches).all(), "a refusal must write nothing").toHaveLength(0);
    } finally {
      check.sqlite.close();
    }
  });

  it("match_add refuses homeTeam/visitingTeam naming the same team over MCP too", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    for (const name of ["Ada Ashby", "Bo Bramwell", "Cy Calder"]) {
      const player = db.insert(players).values({ canonicalName: name }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId: team.id, eventId: null }).run();
    }
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "match_add",
      arguments: {
        playedOn: "2026-08-28",
        homeTeam: team.name,
        visitingTeam: team.name,
        courts: [{ slot: "S1", discipline: "singles", homePlayers: ["Ada Ashby"], visitingPlayers: ["Bo Bramwell"] }],
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cannot play itself");
  });

  // Codex adversarial review (PR #54 round 8, rated Medium, specifically flagged as an MCP-surface
  // regression rather than CLI-only): `slot` canonicalization (src/ingest/scorecard.ts) runs in the
  // ONE schema both `tn match add` and `match_add` parse through, but round 7's own regressions only
  // exercised it via `addMatchFromScorecard` directly and the CLI — never through the SDK's own
  // request/response/validation machinery this file's other tests deliberately exercise. Proves the
  // case-fold reaches a real `match_add` tool call, not just the schema or the CLI presenter.
  it("match_add canonicalizes slot CASE too, over MCP — 'D1' then 'd1' update the SAME court, not a second one", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const home = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    const visiting = db.insert(teams).values({ name: "Report Opponent" }).returning().get();
    for (const [teamId, name] of [
      [home.id, "Bo Bramwell"],
      [home.id, "Cy Calder"],
      [visiting.id, "Opp Two"],
      [visiting.id, "Opp Three"],
    ] as const) {
      const player = db.insert(players).values({ canonicalName: name }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId, eventId: null }).run();
    }
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const courtBase = { discipline: "doubles" as const, homePlayers: ["Bo Bramwell", "Cy Calder"], visitingPlayers: ["Opp Two", "Opp Three"] };

    const first = await client.callTool({
      name: "match_add",
      arguments: {
        playedOn: "2026-08-28",
        homeTeam: home.name,
        visitingTeam: visiting.name,
        courts: [{ ...courtBase, slot: "D1" }],
      },
    });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({
      name: "match_add",
      arguments: {
        playedOn: "2026-08-28",
        homeTeam: home.name,
        visitingTeam: visiting.name,
        courts: [{ ...courtBase, slot: "d1" }],
      },
    });
    expect(second.isError).toBeFalsy();

    const check = openDb();
    try {
      expect(check.db.select().from(teamMatches).all()).toHaveLength(1);
      expect(check.db.select().from(courtMatches).all()).toHaveLength(1); // not a second row
    } finally {
      check.sqlite.close();
    }
  });

  // Codex adversarial review (PR #54 round 9, rated Medium, again specifically flagged as an
  // MCP-surface regression): `trim().toUpperCase()` (round 7/8) does no Unicode compatibility
  // normalization, so a full-width spelling ("ｄ１") reached the service as a genuinely different
  // string from its plain-ASCII form ("D1"/"d1") — the schema now runs `.normalize("NFKC")` first
  // (src/ingest/scorecard.ts), folding the compatibility variant to the same canonical value. Proves
  // that fold reaches a real `match_add` tool call too, mirroring the round-8 case test above.
  it("match_add canonicalizes a FULL-WIDTH slot too, over MCP — 'D1' then 'ｄ１' update the SAME court, not a second one", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const home = db.insert(teams).values({ name: "HOA/Burgess-Zingg/40&over3.5M" }).returning().get();
    const visiting = db.insert(teams).values({ name: "Report Opponent" }).returning().get();
    for (const [teamId, name] of [
      [home.id, "Bo Bramwell"],
      [home.id, "Cy Calder"],
      [visiting.id, "Opp Two"],
      [visiting.id, "Opp Three"],
    ] as const) {
      const player = db.insert(players).values({ canonicalName: name }).returning().get();
      db.insert(teamMemberships).values({ playerId: player.id, teamId, eventId: null }).run();
    }
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const courtBase = { discipline: "doubles" as const, homePlayers: ["Bo Bramwell", "Cy Calder"], visitingPlayers: ["Opp Two", "Opp Three"] };

    const first = await client.callTool({
      name: "match_add",
      arguments: {
        playedOn: "2026-08-28",
        homeTeam: home.name,
        visitingTeam: visiting.name,
        courts: [{ ...courtBase, slot: "D1" }],
      },
    });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({
      name: "match_add",
      arguments: {
        playedOn: "2026-08-28",
        homeTeam: home.name,
        visitingTeam: visiting.name,
        courts: [{ ...courtBase, slot: "ｄ１" }],
      },
    });
    expect(second.isError).toBeFalsy();

    const check = openDb();
    try {
      expect(check.db.select().from(teamMatches).all()).toHaveLength(1);
      expect(check.db.select().from(courtMatches).all()).toHaveLength(1); // not a second row
    } finally {
      check.sqlite.close();
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
    // Linked to a real team match for this team — court matches must belong to the team to count
    // as its history (see `getLineupPlan`).
    const opponent = db.insert(teams).values({ name: "MCP Opponent" }).returning().get();
    const tm = db
      .insert(teamMatches)
      .values({ homeTeamId: team.id, visitingTeamId: opponent.id, sourceMatchId: "mcp-tm-1" })
      .returning()
      .get();
    const cm = upsertCourtMatch(db, {
      teamMatchId: tm.id,
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
    // Issue #90 added `season` + `anchoredTo` to this payload so an MCP caller can tell an
    // event-anchored binder from one that fell back to the clock; #122 renamed the first field to
    // `since` (the ISO lower bound, superseding a bare year) when the season boundary became a
    // 12-month lookback. Asserted exactly (`toEqual`, not `toMatchObject`) — this pin is what caught
    // the two fields arriving, which is its whole job. No event was named here, so the honest answer
    // is today's 12-month window, anchored to today.
    //
    // #113 adds `roster` on the SINGLE-TEAM path, matching the CLI's `roster=` field — a result
    // field reaching one door and not the other is guarded by nothing (ARCHITECTURE.md §5 Q3). With
    // no event named there is no registration to scope by, so the honest answer is "season".
    expect(payload).toEqual({
      target: team.name,
      teams: 1,
      files: 2,
      root: payload.root,
      since: windowStart(new Date()),
      anchoredTo: "today",
      roster: "season",
    });
  });

  // Door parity for #113's disclosure: the same fact, on the same terms, as `tn report build`'s
  // `roster=`. Driven through the REAL `roster_set` service so the registered state is one the
  // production writer actually produces.
  it("report_build over MCP reports roster=registered once an event has a registered roster", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const team = db.insert(teams).values({ name: "Team Registered" }).returning().get();
    const alice = db.insert(players).values({ canonicalName: "Alice Anders" }).returning().get();
    db.insert(players).values({ canonicalName: "Bo Bramwell" }).returning().get();
    db.insert(teamMemberships).values({ playerId: alice.id, teamId: team.id, eventId: null }).run();
    db.insert(events)
      .values({
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        format: JSON.stringify([{ slot: "S1", discipline: "singles" }]),
      })
      .run();
    backfillNameKeys(db);
    const written = setEventRoster(db, {
      team: "Team Registered",
      event: "Springfield Sectionals 2026",
      players: ["Alice Anders"],
    });
    expect(written.ok).toBe(true);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "report_build",
      arguments: { target: team.name, event: "Springfield Sectionals 2026" },
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(textOf(result)) as { roster: string };
    expect(payload.roster).toBe("registered");
  });

  // The batch path carries NO `roster` field, deliberately: a run over every team mixes registered
  // and season teams, and one scalar cannot describe that without lying about some of them.
  it("report_build over MCP omits roster entirely on the sectionals batch path", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(teams).values({ name: "Team Batch" }).returning().get();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({ name: "report_build", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).not.toHaveProperty("roster");
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

  // Issue #49. The MCP handler hand-builds its result object rather than spreading `pullTeam`'s,
  // so a field added to the CLI summary does NOT reach MCP on its own — the first cut of this PR
  // reported `retired=N` on the CLI while the MCP tool silently omitted it, letting an MCP-driven
  // pull retire real teammates with nothing in the response to say so. Asserted with a real
  // retirement (not `toBe(0)` on a first pull, which a hardcoded zero would also satisfy).
  it("team_pull over MCP reports retiredCount, so an MCP-driven pull cannot silently retire a departed member", async () => {
    runMigrations();
    const teamFixture = loadFixture("tennisrecord/team");
    let body = teamFixture.html;
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body,
      fetchedAt: new Date().toISOString(),
    }));

    const client = await connectedClient();
    const first = await client.callTool({ name: "team_pull", arguments: { target: teamFixture.source.url } });
    expect(first.isError).not.toBe(true);
    expect((JSON.parse(textOf(first)) as { retiredCount: number }).retiredCount).toBe(0);

    // Same URL, a roster page that no longer lists one member — the departure this must surface.
    body = removeRosterRow(teamFixture.html, "Ellis Eastwick");
    expect(body).not.toBe(teamFixture.html);
    const second = await client.callTool({ name: "team_pull", arguments: { target: teamFixture.source.url } });
    expect(second.isError).not.toBe(true);
    const payload = JSON.parse(textOf(second)) as { rosterCount: number; retiredCount: number };
    expect(payload.rosterCount).toBe(17);
    expect(payload.retiredCount).toBe(1);

    vi.restoreAllMocks();
  });

  // Issue #108, and the same hazard #49 records above: this handler hand-builds its result object,
  // so `years` does not reach MCP just because the CLI prints it. Driven through the real SDK
  // request/response machinery rather than by calling the handler directly — the surface-parity
  // lesson from PR #54 round 8, where a fix landed on the schema and the CLI and missed MCP.
  it("team_pull over MCP accepts `since` and reports the seasons it actually cascaded (#108)", async () => {
    runMigrations();
    const teamFixture = loadFixture("tennisrecord/team");
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: url === teamFixture.source.url ? teamFixture.html : "<html><body>not a match history</body></html>",
      fetchedAt: new Date().toISOString(),
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const client = await connectedClient();

    // Default: the shipped range, more than one season.
    const ranged = await client.callTool({
      name: "team_pull",
      arguments: { target: teamFixture.source.url, players: true },
    });
    expect(ranged.isError).not.toBe(true);
    const rangedYears = (JSON.parse(textOf(ranged)) as { years: string[] }).years;
    expect(rangedYears.length).toBeGreaterThan(1);

    // `since` narrows it, through the schema, over the wire.
    const narrowed = await client.callTool({
      name: "team_pull",
      arguments: { target: teamFixture.source.url, players: true, since: "2026" },
    });
    expect(narrowed.isError).not.toBe(true);
    expect((JSON.parse(textOf(narrowed)) as { years: string[] }).years).toEqual(["2026"]);

    vi.restoreAllMocks();
  });

  it("team_pull over MCP surfaces an invalid `since` as a named refusal, not a crash (#108)", async () => {
    runMigrations();
    const teamFixture = loadFixture("tennisrecord/team");
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: teamFixture.html,
      fetchedAt: new Date().toISOString(),
    }));

    const client = await connectedClient();
    const result = await client.callTool({
      name: "team_pull",
      arguments: { target: teamFixture.source.url, players: true, since: "nope" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("four-digit year");

    vi.restoreAllMocks();
  });

  /**
   * Issue #98. An agent driving nadal over MCP is the caller LEAST able to read a stderr warning
   * line, and until now it received bare names — so it could not tell a rate-limited pull worth
   * re-running from a dead profile URL worth investigating. The handler hand-builds its result, so
   * this field does not follow the service's shape on its own; that is what this pins.
   */
  it("team_pull over MCP returns a disposition and a reason per skipped entry (#98)", async () => {
    runMigrations();
    const teamFixture = loadFixture("tennisrecord/team");
    // Every cascaded player page is structurally broken, so each pull returns a ParseError —
    // classified `permanent`, since retrying reproduces it.
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: url === teamFixture.source.url ? teamFixture.html : "<html><body>not a match history</body></html>",
      fetchedAt: new Date().toISOString(),
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const client = await connectedClient();
    const result = await client.callTool({
      name: "team_pull",
      arguments: { target: teamFixture.source.url, players: true, since: "2026" },
    });

    expect(result.isError).not.toBe(true);
    const skipped = (
      JSON.parse(textOf(result)) as {
        skippedRosterEntries: Array<{ entry: string; disposition: string; reason: string }>;
      }
    ).skippedRosterEntries;

    expect(skipped).toHaveLength(18);
    // Asserted on VALUES, not on `typeof` — a shape check passes against three empty strings.
    for (const row of skipped) {
      expect(row.entry).toMatch(/ \(year=2026\)$/);
      expect(row.disposition).toBe("permanent");
      expect(row.reason).toContain("selector:");
    }

    vi.restoreAllMocks();
  });

  /**
   * `sanitizeJson` recursed into arrays and flat strings before #98; the skipped entries are now
   * NESTED objects, and `reason` is a second attacker-influenced string beside the scraped name (a
   * ParseError quotes the document it choked on). This proves the guard reaches inside the record
   * rather than only the array it sits in — an omission that would be invisible in every other test.
   */
  it("team_pull sanitizes inside the nested skipped-entry records, not only the flat fields (#98)", async () => {
    runMigrations();
    const RTL_OVERRIDE = String.fromCharCode(0x202e);
    const ESC = String.fromCharCode(0x1b);
    const teamFixture = loadFixture("tennisrecord/team");

    vi.spyOn(teamPullModule, "pullTeam").mockResolvedValue({
      kind: "ok",
      team: {
        id: 1,
        name: "Cascade Test",
        section: null,
        district: null,
        tennislinkUrl: null,
        rosterObservedAt: null,
        rosterObservedUrl: null,
        tennisrecordUrl: null,
        isHome: null,
        nameKey: null,
        nameKeyLength: null,
      },
      rosterCount: 1,
      matchCount: 0,
      archivedPath: "raw/tennisrecord/x.html",
      skippedRosterEntries: [
        {
          entry: `Ann${RTL_OVERRIDE} Ashby (year=2026)`,
          disposition: "permanent",
          reason: `parse failed${ESC}[2J at row 3`,
        },
      ],
      retiredCount: 0,
      years: ["2026"],
    });

    const client = await connectedClient();
    const result = await client.callTool({
      name: "team_pull",
      arguments: { target: teamFixture.source.url, players: true },
    });

    const skipped = (
      JSON.parse(textOf(result)) as {
        skippedRosterEntries: Array<{ entry: string; disposition: string; reason: string }>;
      }
    ).skippedRosterEntries;

    expect(skipped).toEqual([
      { entry: "Ann  Ashby (year=2026)", disposition: "permanent", reason: "parse failed [2J at row 3" },
    ]);

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

  it("player_pull over MCP routes wtn-profile: to the saved-page path, not the live fetcher, and says it needs no login", async () => {
    // Parity with src/cli/commands/player-pull.ts, pinned because it was briefly broken and the
    // breakage was silent: `startsWith("wtn:")` does not match `wtn-profile:…` (`-` vs `:`), so
    // adding the target to the CLI alone left THIS surface dropping it through to the live-fetch
    // branch. An agent driving nadal over MCP would have had a saved-page target attempted as a
    // network fetch. Asserting the error names the missing inputs proves it reached the saved-page
    // branch at all; asserting "login" is absent proves it did not inherit usta:/wtn:'s reason.
    runMigrations();
    const client = await connectedClient();
    const result = await client.callTool({ name: "player_pull", arguments: { target: "wtn-profile:MER9000003" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires from and sourceUrl");
    expect(textOf(result)).toContain("no login needed");
    expect(textOf(result)).not.toContain("login-assisted");
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

  // Issue #94. The two disambiguation rulings over MCP. Agent chat is nadal's primary interface
  // (spec § Interfaces), and it is where an ambiguity is most likely to be READ — a resolution path
  // reachable only from the CLI would leave the agent able to report the problem and unable to fix
  // it. Both go through the same `src/ingest/disambiguate.ts` services the CLI calls.
  it("player_distinct creates the player over MCP and names who it is now distinct from", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(players).values({ canonicalName: "Mason Davis" }).run();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({ name: "player_distinct", arguments: { target: "Karson Davis" } });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      player: "Karson Davis",
      created: true,
      distinctFrom: ["Mason Davis"],
      // Empty on the single-name form, and present rather than omitted so an agent reading this
      // shape never has to distinguish "no counterpart minted" from "this field does not exist".
      alsoCreated: [],
    });
  });

  // #142's case over MCP: the pair form is on this surface too, because agent chat is where a
  // cascade's warnings are read and acted on conversationally.
  it("player_distinct settles an ambiguity whose both sides rolled back, given the counterpart", async () => {
    runMigrations();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "player_distinct",
      arguments: { target: "Maria Negron", nearName: "Marie Negron" },
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      player: "Maria Negron",
      created: true,
      distinctFrom: ["Marie Negron"],
      alsoCreated: ["Marie Negron"],
    });
  });

  it("player_distinct refuses a counterpart that is not near the target", async () => {
    runMigrations();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "player_distinct",
      arguments: { target: "Maria Negron", nearName: "Wilhelmina Fotheringay" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("further apart than the fuzzy radius");
  });

  it("player_distinct refuses a name that is near nothing — the typo guard reaches this surface too", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(players).values({ canonicalName: "Mason Davis" }).run();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "player_distinct",
      arguments: { target: "Wilhelmina Fotheringay" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is not ambiguous");
  });

  it("player_alias records the second spelling, and the ladder then resolves it to the known player", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const known = db.insert(players).values({ canonicalName: "Robert Smith" }).returning().get();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "player_alias",
      arguments: { target: "Robert Smith", alias: "Bob Smith" },
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({ player: "Robert Smith", alias: "Bob Smith", recorded: true });

    const { db: db2, sqlite: sqlite2 } = openDb();
    const resolved = resolvePlayer(db2, { name: "Bob Smith" });
    sqlite2.close();
    expect(resolved.kind).toBe("matched");
    if (resolved.kind !== "matched") throw new Error("expected matched");
    expect(resolved.row.id).toBe(known.id);
  });

  it("player_alias refuses a spelling another player already answers to", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    db.insert(players).values({ canonicalName: "Robert Smith" }).run();
    db.insert(players).values({ canonicalName: "Bob Smith" }).run();
    backfillNameKeys(db);
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "player_alias",
      arguments: { target: "Robert Smith", alias: "Bob Smith" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("already belongs to Bob Smith");
  });

  // Task 6 (#113): `roster_set` mirrors `match_add`'s inline-payload shape — the source is a
  // login-gated registration page, so the primary door is an agent handing over what it read,
  // exactly like a scorecard photo.
  it("roster_set writes the same rows as the CLI — same service, asserted through the tool", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const fixture = seedTeamWithRosters(db, {
      teamName: "OK/Dickason/40&over3.5M",
      season: ["Alice Anders", "Bo Bramwell", "Cy Calder"],
    });
    db.insert(events).values({ name: "Springfield Sectionals 2026", kind: "tournament" }).returning().get();
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "roster_set",
      arguments: {
        team: "OK/Dickason/40&over3.5M",
        event: "Springfield Sectionals 2026",
        players: ["Alice Anders", "Bo Bramwell"],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      team: "OK/Dickason/40&over3.5M",
      event: "Springfield Sectionals 2026",
      registered: 2,
      retired: 0,
    });

    const check = openDb();
    try {
      const rows = check.db
        .select()
        .from(teamMemberships)
        .where(eq(teamMemberships.teamId, fixture.teamId))
        .all();
      expect(rows.filter((r) => r.eventId !== null)).toHaveLength(2);
    } finally {
      check.sqlite.close();
    }
  });

  it("roster_set refusal returns the structured message as a tool error, writing nothing", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    seedTeamWithRosters(db, { teamName: "Team A", season: ["Alice Anders"] });
    sqlite.close();

    const client = await connectedClient();
    const result = await client.callTool({
      name: "roster_set",
      arguments: { team: "Team A", event: "No Such Event", players: ["Alice Anders"] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('unknown event "No Such Event"');

    const check = openDb();
    try {
      expect(check.db.select().from(teamMemberships).all().every((r) => r.eventId === null)).toBe(true);
    } finally {
      check.sqlite.close();
    }
  });
});
