import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { players } from "../src/db/schema.js";
import { useTnDbPath } from "./helpers/tn-db.js";

/**
 * Issue #130. `players.gender` holds `Competition Category: MALE` on all 77 rows that had a
 * gender before the parser fix (`src/parsers/usta/profile.ts`) and the normalized writers
 * (`src/ingest/normalize-gender.ts`) existed. Those 77 rows are already on disk, written by the
 * OLD, buggy code path — nothing this PR changes touches them retroactively, which is exactly
 * what a migration-time backfill is for (`backfillNameKeys`, `src/db/name-key.ts:268`, is the
 * precedent this one follows).
 *
 * Every seed below uses a RAW `better-sqlite3` `INSERT`, never `db.insert(players)` — the fix this
 * test is pinning does not touch any write PATH, only what runs once at migration time, so seeding
 * through a write path would not prove the backfill did the work (rules/testing.md: a fixture must
 * not satisfy its own test by construction).
 */
describe("gender backfill", () => {
  const dbFixture = useTnDbPath();

  function rawInsert(canonicalName: string, gender: string | null): void {
    const raw = new Database(dbFixture.path());
    raw
      .prepare("INSERT INTO players (canonical_name, gender, name_key) VALUES (?, ?, ?)")
      .run(canonicalName, gender, canonicalName.toLowerCase());
    raw.close();
  }

  it("normalizes a seeded raw USTA label to the stored vocabulary", () => {
    runMigrations();
    rawInsert("Jane Doe", "Competition Category: MALE");

    runMigrations(); // triggers the backfill, same as an existing local DB upgrading

    const { db, sqlite } = openDb();
    try {
      const row = db.select().from(players).where(eq(players.canonicalName, "Jane Doe")).all()[0];
      expect(row?.gender).toBe("Male");
    } finally {
      sqlite.close();
    }
  });

  it("normalizes FEMALE (as printed) to Female", () => {
    runMigrations();
    rawInsert("Fiona Frost", "FEMALE");

    runMigrations();

    const { db, sqlite } = openDb();
    try {
      const row = db.select().from(players).where(eq(players.canonicalName, "Fiona Frost")).all()[0];
      expect(row?.gender).toBe("Female");
    } finally {
      sqlite.close();
    }
  });

  it("leaves an already-normalized value untouched", () => {
    runMigrations();
    rawInsert("Micah Merrivale", "Male");

    runMigrations();

    const { db, sqlite } = openDb();
    try {
      const row = db.select().from(players).where(eq(players.canonicalName, "Micah Merrivale")).all()[0];
      expect(row?.gender).toBe("Male");
    } finally {
      sqlite.close();
    }
  });

  it("FAILS CLOSED: an unrecognised value becomes NULL, not left raw", () => {
    runMigrations();
    rawInsert("Mixed Martin", "Mixed");

    runMigrations();

    const { db, sqlite } = openDb();
    try {
      const row = db.select().from(players).where(eq(players.canonicalName, "Mixed Martin")).all()[0];
      expect(row?.gender).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("leaves a NULL gender as NULL — nothing to normalize, and nothing invented", () => {
    runMigrations();
    rawInsert("Noel Nobody", null);

    runMigrations();

    const { db, sqlite } = openDb();
    try {
      const row = db.select().from(players).where(eq(players.canonicalName, "Noel Nobody")).all()[0];
      expect(row?.gender).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("is idempotent — a second backfill pass changes nothing", () => {
    runMigrations();
    rawInsert("Jane Doe", "Competition Category: MALE");
    rawInsert("Mixed Martin", "Mixed");
    rawInsert("Noel Nobody", null);

    runMigrations();
    const { db: db1, sqlite: sqlite1 } = openDb();
    const afterFirst = db1.select().from(players).all();
    sqlite1.close();

    runMigrations();
    const { db: db2, sqlite: sqlite2 } = openDb();
    const afterSecond = db2.select().from(players).all();
    sqlite2.close();

    expect(afterSecond).toEqual(afterFirst);
  });
});
