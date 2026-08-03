// Issue #94, the second half. Reporting an ambiguity legibly is worth nothing if there is no way to
// ACT on it — before these two operations, every write path (`team pull`, `player pull`, `match
// add`) routed through `resolvePlayer`, and nothing in `src/cli` or `src/mcp` wrote `players` or
// `player_aliases` directly. So a reported ambiguity was permanent: `NE/Penland` could not be
// pulled at all, and three `OK/Dickason` roster members had rows with no enrichment.
//
// The two rulings a human can make, and nothing else:
//   distinct — DIFFERENT people who happen to have similar names.
//   alias    — the SAME person, spelled two ways.

import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { playerAliases, players } from "../src/db/schema.js";
import { declareDistinctPlayer, recordPlayerAlias } from "../src/ingest/disambiguate.js";
import { resolvePlayer } from "../src/ingest/identity.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("declareDistinctPlayer", () => {
  useTnDbPath();

  it("creates the player, and reports who it is now distinct FROM", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Mason Davis" });

      const result = declareDistinctPlayer(db, { name: "Karson Davis" });

      expect(result.kind).toBe("created");
      if (result.kind !== "created") throw new Error("expected created");
      expect(result.player.canonicalName).toBe("Karson Davis");
      expect(result.distinctFrom).toEqual(["Mason Davis"]);
    } finally {
      sqlite.close();
    }
  });

  // The whole point: the pull that was refused must now go through. Asserted by re-running the
  // resolution the pull actually runs, not by inspecting rows — "a row exists" and "the ladder now
  // resolves it" are different claims, and only the second one unblocks anything.
  it("makes the name RESOLVE afterwards — the ladder stops reporting it ambiguous", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Mason Davis" });
      expect(resolvePlayer(db, { name: "Karson Davis" }).kind).toBe("ambiguous");

      declareDistinctPlayer(db, { name: "Karson Davis" });

      const after = resolvePlayer(db, { name: "Karson Davis" });
      expect(after.kind).toBe("matched");
      if (after.kind !== "matched") throw new Error("expected matched");
      expect(after.row.canonicalName).toBe("Karson Davis");
      // ...and the neighbour it was distinguished from still resolves to ITSELF, not to the new row.
      const neighbour = resolvePlayer(db, { name: "Mason Davis" });
      expect(neighbour.kind).toBe("matched");
      if (neighbour.kind !== "matched") throw new Error("expected matched");
      expect(neighbour.row.id).not.toBe(after.row.id);
    } finally {
      sqlite.close();
    }
  });

  it("records the name as its own first alias, exactly as resolvePlayer's own creation path does", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Mason Davis" });
      const result = declareDistinctPlayer(db, { name: "Karson Davis" });
      if (result.kind !== "created") throw new Error("expected created");

      const aliases = db.select().from(playerAliases).all().filter((a) => a.playerId === result.player.id);
      expect(aliases.map((a) => a.alias)).toEqual(["Karson Davis"]);
      expect(aliases[0]?.nameKey).not.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("reports every near neighbour, not just the first", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      db.insert(players).values({ canonicalName: "Mason Davis" }).run();
      db.insert(players).values({ canonicalName: "Karsen Davis" }).run();
      backfillNameKeys(db);

      const result = declareDistinctPlayer(db, { name: "Karson Davis" });

      expect(result.kind).toBe("created");
      if (result.kind !== "created") throw new Error("expected created");
      expect([...result.distinctFrom].sort()).toEqual(["Karsen Davis", "Mason Davis"]);
    } finally {
      sqlite.close();
    }
  });

  // Idempotence, so re-running a runbook step is not an error. This is `ok`, not a refusal: the end
  // state the caller asked for is the state on disk.
  it("a name already on file is a no-op, NOT a second row — a duplicate key would make it permanently ambiguous", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Mason Davis" });
      declareDistinctPlayer(db, { name: "Karson Davis" });

      const again = declareDistinctPlayer(db, { name: "Karson Davis" });

      expect(again.kind).toBe("already-on-file");
      if (again.kind !== "already-on-file") throw new Error("expected already-on-file");
      expect(again.player.canonicalName).toBe("Karson Davis");
      expect(db.select().from(players).all().filter((p) => p.canonicalName === "Karson Davis")).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  // The typo guard. `tn player distinct "Karsen Davis"` — one letter off what the report actually
  // named — must not silently mint a person nobody meant to create. The command exists to resolve a
  // REPORTED ambiguity, so a name the ladder was never blocked on is refused rather than accepted:
  // the caller either mistyped, or wants a pull, which is what creates players.
  it("REFUSES a name that is near nothing — that is a typo, not a ruling", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Mason Davis" });

      const result = declareDistinctPlayer(db, { name: "Wilhelmina Fotheringay" });

      expect(result.kind).toBe("not-ambiguous");
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("REFUSES when two rows already share the name — creating a third cannot fix a merge", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      db.insert(players).values({ canonicalName: "Karson Davis" }).run();
      db.insert(players).values({ canonicalName: "karson davis" }).run();
      backfillNameKeys(db);

      const result = declareDistinctPlayer(db, { name: "Karson Davis" });

      expect(result.kind).toBe("already-ambiguous");
      if (result.kind !== "already-ambiguous") throw new Error("expected already-ambiguous");
      expect([...result.candidates].sort()).toEqual(["Karson Davis", "karson davis"]);
      expect(db.select().from(players).all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("REFUSES a blank name rather than creating a player nobody can name", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      expect(declareDistinctPlayer(db, { name: "   " }).kind).toBe("empty-name");
      expect(db.select().from(players).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});

describe("recordPlayerAlias", () => {
  useTnDbPath();

  it("records the second spelling, and the ladder then resolves it to the known player", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const known = resolvePlayer(db, { name: "Robert Smith" });
      if (known.kind !== "created") throw new Error("expected created");

      const result = recordPlayerAlias(db, { knownTarget: "Robert Smith", alias: "Bob Smith" });

      expect(result.kind).toBe("recorded");
      if (result.kind !== "recorded") throw new Error("expected recorded");
      expect(result.player.id).toBe(known.row.id);
      expect(result.alias).toBe("Bob Smith");

      const resolved = resolvePlayer(db, { name: "Bob Smith" });
      expect(resolved.kind).toBe("matched");
      if (resolved.kind !== "matched") throw new Error("expected matched");
      expect(resolved.row.id).toBe(known.row.id);
    } finally {
      sqlite.close();
    }
  });

  // The case the issue is actually about: an incoming spelling one edit from an on-file name, which
  // the ladder refuses as ambiguous. After the ruling it resolves to the on-file player, and NO new
  // player row appears — that is what makes this the "same person" ruling rather than the other one.
  it("resolves a fuzzy near-name to the known player without creating a second row", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Mason Davis" });
      expect(resolvePlayer(db, { name: "Masen Davis" }).kind).toBe("ambiguous");

      recordPlayerAlias(db, { knownTarget: "Mason Davis", alias: "Masen Davis" });

      const resolved = resolvePlayer(db, { name: "Masen Davis" });
      expect(resolved.kind).toBe("matched");
      if (resolved.kind !== "matched") throw new Error("expected matched");
      expect(resolved.row.canonicalName).toBe("Mason Davis");
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("is idempotent — recording the same alias twice reports it, and writes one row", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Robert Smith" });
      recordPlayerAlias(db, { knownTarget: "Robert Smith", alias: "Bob Smith" });

      const again = recordPlayerAlias(db, { knownTarget: "Robert Smith", alias: "Bob Smith" });

      expect(again.kind).toBe("already-recorded");
      expect(db.select().from(playerAliases).all().filter((a) => a.alias === "Bob Smith")).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("the player's own canonical name is already an alias — recording it again is a no-op", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Robert Smith" });
      expect(recordPlayerAlias(db, { knownTarget: "Robert Smith", alias: "Robert Smith" }).kind).toBe(
        "already-recorded",
      );
    } finally {
      sqlite.close();
    }
  });

  // The one that would quietly corrupt the ladder. Both rows would then hold the same `name_key`,
  // so `resolvePlayer`'s exact tier returns TWO ids and reports ambiguous forever — with no
  // operation able to undo it, since nothing removes an alias.
  it("REFUSES an alias already held by a DIFFERENT player — that would make the name permanently ambiguous", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Robert Smith" });
      const other = resolvePlayer(db, { name: "Bob Smith" });
      if (other.kind !== "created") throw new Error("expected created");

      const result = recordPlayerAlias(db, { knownTarget: "Robert Smith", alias: "Bob Smith" });

      expect(result.kind).toBe("held-by-another");
      if (result.kind !== "held-by-another") throw new Error("expected held-by-another");
      expect(result.holder.canonicalName).toBe("Bob Smith");
      expect(db.select().from(playerAliases).all().filter((a) => a.playerId === other.row.id)).toHaveLength(1);
      // And the ladder is unharmed: "Bob Smith" still resolves to exactly one player.
      expect(resolvePlayer(db, { name: "Bob Smith" }).kind).toBe("matched");
    } finally {
      sqlite.close();
    }
  });

  it("REFUSES an unknown known-target rather than creating one", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const result = recordPlayerAlias(db, { knownTarget: "Nobody On File", alias: "Bob Smith" });
      expect(result.kind).toBe("unknown-target");
      expect(db.select().from(players).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("REFUSES an ambiguous known-target, reporting the same three facts every other refusal does", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      db.insert(players).values({ canonicalName: "Nova Norbury" }).run();
      db.insert(players).values({ canonicalName: "Nova Norbary" }).run();
      backfillNameKeys(db);

      const result = recordPlayerAlias(db, { knownTarget: "Nova Norbiry", alias: "Nova N" });

      expect(result.kind).toBe("ambiguous-target");
      if (result.kind !== "ambiguous-target") throw new Error("expected ambiguous-target");
      expect(result.incoming).toBe("Nova Norbiry");
      expect(result.context).toBe("player name target");
      expect([...result.candidates].sort()).toEqual(["Nova Norbary", "Nova Norbury"]);
    } finally {
      sqlite.close();
    }
  });

  it("REFUSES a blank alias", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      resolvePlayer(db, { name: "Robert Smith" });
      expect(recordPlayerAlias(db, { knownTarget: "Robert Smith", alias: "  " }).kind).toBe("empty-alias");
      expect(db.select().from(playerAliases).all()).toHaveLength(1); // only the creation-time one
    } finally {
      sqlite.close();
    }
  });

  it("accepts a usta: prefix-ID as the known target, like every other target-taking operation", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      db.insert(players).values({ canonicalName: "Robert Smith", ustaUaid: "900000123" }).run();
      backfillNameKeys(db);

      const result = recordPlayerAlias(db, { knownTarget: "usta:900000123", alias: "Bob Smith" });

      expect(result.kind).toBe("recorded");
      const resolved = resolvePlayer(db, { name: "Bob Smith" });
      expect(resolved.kind).toBe("matched");
    } finally {
      sqlite.close();
    }
  });
});
