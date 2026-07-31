import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { playerAliases, players, teams } from "../src/db/schema.js";
import { resolvePlayer, resolveTeam } from "../src/ingest/identity.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("resolvePlayer", () => {
  useTnDbPath();

  function freshDb() {
    runMigrations();
    return openDb();
  }

  it("tier 1: matches by usta_uaid, ignoring the given name", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(players).values({ canonicalName: "Jane Doe", ustaUaid: "12345" }).run();
      const result = resolvePlayer(db, { ustaUaid: "12345", name: "Some Other Spelling" });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.canonicalName).toBe("Jane Doe");
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("tier 1: matches by tennisrecord_url", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(players)
        .values({ canonicalName: "Nova Norbury", tennisrecordUrl: "https://tr/profile?a" })
        .run();
      const result = resolvePlayer(db, {
        tennisrecordUrl: "https://tr/profile?a",
        name: "Different Name",
      });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.canonicalName).toBe("Nova Norbury");
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("tier 2: matches via player_aliases, case-insensitively", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(players).values({ canonicalName: "Jane Doe" }).run();
      const seeded = db.select().from(players).all()[0]!;
      db.insert(playerAliases).values({ playerId: seeded.id, alias: "JD" }).run();

      const result = resolvePlayer(db, { name: "jd" });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.id).toBe(seeded.id);
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("tier 3: two near-identical stored names resolve as ambiguous with BOTH candidates, and creates/modifies nothing", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(players)
        .values([{ canonicalName: "Alex Stone" }, { canonicalName: "Alex Stove" }])
        .run();
      const before = db.select().from(players).all();

      // "Alex Ston" is one edit from "Alex Stone" (insert "e") and two edits from "Alex Stove"
      // (substitute "n"->"v", insert "e") — both within the fuzzy radius, neither an exact match.
      const result = resolvePlayer(db, { name: "Alex Ston" });

      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.candidates.map((c) => c.canonicalName).sort()).toEqual([
          "Alex Stone",
          "Alex Stove",
        ]);
      }
      expect(db.select().from(players).all()).toEqual(before);
      expect(db.select().from(playerAliases).all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("brand-new name: creates exactly one player, canonical_name preserving the page's own spelling", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = resolvePlayer(db, { name: "EMORY ELLERBY" });

      expect(result.kind).toBe("created");
      if (result.kind === "created") expect(result.row.canonicalName).toBe("EMORY ELLERBY");

      const rows = db.select().from(players).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.canonicalName).toBe("EMORY ELLERBY");
    } finally {
      sqlite.close();
    }
  });

  it("EDGE: the same name appearing twice on one roster resolves to one player, not two", () => {
    const { db, sqlite } = freshDb();
    try {
      const first = resolvePlayer(db, { name: "Ellis Eastwick" });
      const second = resolvePlayer(db, { name: "Ellis Eastwick" });

      expect(first.kind).toBe("created");
      expect(second.kind).toBe("matched");
      if (first.kind === "created" && second.kind === "matched") {
        expect(second.row.id).toBe(first.row.id);
      }
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});

describe("resolveTeam", () => {
  useTnDbPath();

  function freshDb() {
    runMigrations();
    return openDb();
  }

  it("tier 1: matches by tennisrecord_url", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(teams).values({ name: "Norbury, Nova", tennisrecordUrl: "https://tr/team?a" }).run();
      const result = resolveTeam(db, { tennisrecordUrl: "https://tr/team?a", name: "Different" });

      expect(result.kind).toBe("matched");
      if (result.kind === "matched") expect(result.row.name).toBe("Norbury, Nova");
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("matches an existing team by exact case-insensitive name", () => {
    const { db, sqlite } = freshDb();
    try {
      db.insert(teams).values({ name: "Norbury, Nova" }).run();
      const result = resolveTeam(db, { name: "norbury, nova" });

      expect(result.kind).toBe("matched");
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("creates exactly one team for a brand-new name, preserving spelling", () => {
    const { db, sqlite } = freshDb();
    try {
      const result = resolveTeam(db, { name: "Granborough, Galen" });

      expect(result.kind).toBe("created");
      if (result.kind === "created") expect(result.row.name).toBe("Granborough, Galen");
      expect(db.select().from(teams).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});

// Codex adversarial review, PR #31 [medium]: tier 2 folded case in SQLite (`lower()`, ASCII-only)
// while the canonical-name half of the SAME tier folded in JS (Unicode). One identity ladder cannot
// run two different notions of "the same name" — the gap creates a SECOND row for someone on file.
describe("identity ladder — Unicode case folding", () => {
  useTnDbPath();

  it("REGRESSION: a non-ASCII alias resolves case-insensitively instead of creating a split identity", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const created = resolvePlayer(db, { name: "Jane Smith" });
      if (created.kind === "ambiguous") throw new Error("unexpected ambiguous");
      db.insert(playerAliases).values({ playerId: created.row.id, alias: "Élodie Ünwin" }).run();

      const resolved = resolvePlayer(db, { name: "élodie ünwin" });

      expect(resolved.kind).toBe("matched");
      if (resolved.kind === "matched") expect(resolved.row.id).toBe(created.row.id);
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
