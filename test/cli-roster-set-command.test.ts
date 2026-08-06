// `tn roster set <payload-file>` end-to-end through `dispatch` (Task 5, #113) — mirrors
// `test/cli-match-add-command.test.ts`'s shape: a temp payload file, real on-disk SQLite, real CLI
// dispatch.

import { eq } from "drizzle-orm";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { events, teamMemberships } from "../src/db/schema.js";
import { seedTeamWithRosters } from "./helpers/roster.js";
import { useTnDbPath } from "./helpers/tn-db.js";

function writeTempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tn-roster-set-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("tn roster set (end-to-end via dispatch)", () => {
  useTnDbPath();

  it("happy path: one summary line, exit 0, DB state matches", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    const fixture = seedTeamWithRosters(db, {
      teamName: "OK/Dickason/40&over3.5M",
      season: ["Alice Anders", "Bo Bramwell", "Cy Calder"],
    });
    db.insert(events).values({ name: "Springfield Sectionals 2026", kind: "tournament" }).returning().get();
    sqlite.close();

    const payloadPath = writeTempFile(
      "roster.json",
      JSON.stringify({
        team: "OK/Dickason/40&over3.5M",
        event: "Springfield Sectionals 2026",
        players: ["Alice Anders", "Bo Bramwell"],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["roster", "set", payloadPath]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^roster set status=ok team="OK\/Dickason\/40&over3\.5M" event="Springfield Sectionals 2026" registered=2 retired=0$/,
      ),
    );

    const check = openDb();
    try {
      const rows = check.db.select().from(teamMemberships).where(eq(teamMemberships.teamId, fixture.teamId)).all();
      const eventRows = rows.filter((r) => r.eventId !== null);
      expect(eventRows).toHaveLength(2);
    } finally {
      check.sqlite.close();
    }
  });

  it("file missing -> one refusal line, exit 1, nothing written", async () => {
    runMigrations();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["roster", "set", "/no/such/roster-payload.json"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));

    const check = openDb();
    try {
      expect(check.db.select().from(teamMemberships).all().every((r) => r.eventId === null)).toBe(true);
    } finally {
      check.sqlite.close();
    }
  });

  it("not JSON -> one refusal line, exit 1, nothing written", async () => {
    runMigrations();
    const badPath = writeTempFile("bad.json", "{ not json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["roster", "set", badPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));
  });

  it("schema-invalid (empty players) -> one refusal line, exit 1, nothing written", async () => {
    runMigrations();
    const payloadPath = writeTempFile(
      "empty.json",
      JSON.stringify({ team: "Team A", event: "Event X", players: [] }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["roster", "set", payloadPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("status=error"));
  });

  it("an unknown team refuses without writing anything", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    seedTeamWithRosters(db, { teamName: "Team A", season: ["Alice Anders"] });
    db.insert(events).values({ name: "Event X", kind: "tournament" }).returning().get();
    sqlite.close();

    const payloadPath = writeTempFile(
      "roster.json",
      JSON.stringify({ team: "No Such Team", event: "Event X", players: ["Alice Anders"] }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["roster", "set", payloadPath]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown team"));
  });
});
