import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DB_PATH, dbPath, openDb, runMigrations } from "../src/db/client.js";
import { playerAliases, players, teams } from "../src/db/schema.js";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-")), "test.db");
}

describe("dbPath()", () => {
  const original = process.env.TN_DB_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.TN_DB_PATH;
    else process.env.TN_DB_PATH = original;
  });

  it("falls back to DEFAULT_DB_PATH when TN_DB_PATH is unset", () => {
    delete process.env.TN_DB_PATH;
    expect(dbPath()).toBe(DEFAULT_DB_PATH);
  });

  it("honors TN_DB_PATH when set", () => {
    process.env.TN_DB_PATH = "/tmp/tn-custom-path.db";
    expect(dbPath()).toBe("/tmp/tn-custom-path.db");
  });
});

describe("openDb() + schema", () => {
  it("round-trips rows through the generated schema and its column mapping", () => {
    const path = freshDbPath();
    runMigrations(path);
    const { db, sqlite } = openDb(path);

    db.insert(teams).values({ name: "IA/Versteeg/40&Over3.5M", section: "Iowa" }).run();
    const foundTeams = db.select().from(teams).all();
    expect(foundTeams).toHaveLength(1);
    expect(foundTeams[0]?.name).toBe("IA/Versteeg/40&Over3.5M");
    expect(foundTeams[0]?.section).toBe("Iowa");

    db.insert(players).values({ canonicalName: "Jane Doe" }).run();
    const foundPlayers = db.select().from(players).all();
    expect(foundPlayers).toHaveLength(1);
    const player = foundPlayers[0]!;
    expect(player.canonicalName).toBe("Jane Doe");

    db.insert(playerAliases).values({ playerId: player.id, alias: "J. Doe" }).run();
    const foundAliases = db.select().from(playerAliases).all();
    expect(foundAliases).toHaveLength(1);
    expect(foundAliases[0]?.alias).toBe("J. Doe");
    expect(foundAliases[0]?.playerId).toBe(player.id);

    sqlite.close();
  });
});
