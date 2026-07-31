// Issue #32, Testing Strategy suite F: one test per write site that must maintain `name_key`. The
// assessment originally missed sites 4 and 5 (both in src/ingest/upsert.ts) because a deliberate
// "\0null" sentinel in that file makes plain grep/ripgrep classify it as binary and skip it — see
// the posted plan's "Correction to the assessment" and docs/findings.md. Site 5 is the important
// one: it's a RENAME path, and a stale key there is the same silent-duplicate failure as a missing
// one.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { playerAliases, players, teams } from "../src/db/schema.js";
import { resolvePlayer, resolveTeam } from "../src/ingest/identity.js";
import { upsertPlayer, upsertTeam } from "../src/ingest/upsert.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("write-path name_key coverage (the anti-staleness guard)", () => {
  useTnDbPath();

  function freshDb() {
    runMigrations();
    return openDb();
  }

  it("SITE 1 (identity.ts resolvePlayer INSERT players): stored name_key equals nameKey(source)", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = resolvePlayer(db, { name: "Nova Norbury" });
      if (result.kind !== "created") throw new Error("expected created");
      expect(result.row.nameKey).toBe(nameKey("Nova Norbury"));
    } finally {
      sqlite.close();
    }
  });

  it("SITE 2 (identity.ts resolvePlayer INSERT player_aliases): stored name_key equals nameKey(alias)", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = resolvePlayer(db, { name: "Nova Norbury" });
      if (result.kind !== "created") throw new Error("expected created");
      const alias = db.select().from(playerAliases).where(eq(playerAliases.playerId, result.row.id)).all()[0];
      expect(alias?.nameKey).toBe(nameKey("Nova Norbury"));
    } finally {
      sqlite.close();
    }
  });

  it("SITE 3 (identity.ts resolveTeam INSERT teams): stored name_key equals nameKey(source)", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = resolveTeam(db, { name: "Granborough, Galen" });
      if (result.kind !== "created") throw new Error("expected created");
      expect(result.row.nameKey).toBe(nameKey("Granborough, Galen"));
    } finally {
      sqlite.close();
    }
  });

  it("SITE 4 (upsert.ts upsertTeam INSERT-on-conflict): stored name_key equals nameKey(source), including on the conflict-update path", () => {
    const { db, sqlite } = freshDb();
    try {
      const created = upsertTeam(db, { name: "Clayview Country Club" });
      expect(created.nameKey).toBe(nameKey("Clayview Country Club"));

      // Re-upserting the same team (on-conflict path) leaves the key correct too.
      const reupserted = upsertTeam(db, { name: "Clayview Country Club", section: "Iowa" });
      expect(reupserted.nameKey).toBe(nameKey("Clayview Country Club"));
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("SITE 5 (upsert.ts upsertPlayer UPDATE canonical_name — the rename path the assessment missed): a rename resolves the NEW spelling to the SAME row, and the OLD key is gone", () => {
    const { db, sqlite } = freshDb();
    try {
      const created = resolvePlayer(db, { name: "Jhon Smyth" });
      if (created.kind !== "created") throw new Error("expected created");
      expect(created.row.nameKey).toBe(nameKey("Jhon Smyth"));

      const renamed = upsertPlayer(db, { id: created.row.id, canonicalName: "John Smith" });
      expect(renamed.nameKey).toBe(nameKey("John Smith"));
      expect(renamed.nameKey).not.toBe(nameKey("Jhon Smyth"));

      // The row itself is the only row on file, and its own alias table still has the ORIGINAL
      // spelling as an alias (resolvePlayer recorded it at creation, and upsertPlayer never
      // touches player_aliases) — tier 2 still resolves it via that alias, proving nothing was
      // lost, while a fresh lookup by the NEW canonical spelling also resolves to the same row.
      const byOldAlias = resolvePlayer(db, { name: "Jhon Smyth" });
      expect(byOldAlias.kind).toBe("matched");
      if (byOldAlias.kind === "matched") expect(byOldAlias.row.id).toBe(created.row.id);

      const rows = db.select().from(players).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.nameKey).toBe(nameKey("John Smith"));
      expect(rows[0]?.canonicalName).toBe("John Smith");
    } finally {
      sqlite.close();
    }
  });
});
