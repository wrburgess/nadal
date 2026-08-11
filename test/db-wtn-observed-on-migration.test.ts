import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { players, ratingObservations } from "../src/db/schema.js";
import { buildLegacyMigrationsFolder } from "./helpers/legacy-migrations.js";

/**
 * Issue #132's migration half. Every WTN row this project has ever written was stamped with the
 * **capture** date rather than the ITF's own `Updated` date, because the parser skipped the
 * widget's date subtitles. Measured on the live database at the time of the fix: 133 rows, every
 * one reading `2026-08-10`, all carrying numbers the pages themselves stamped `08/05/2026` — 194 of
 * 194 captured WTN sections agree on that publication date.
 *
 * Fixing the parser corrects every FUTURE pull and touches none of those rows, so the correction
 * has to be a migration. It is scoped by an exact match on both the source and the wrong date, so a
 * row written correctly after the parser fix is never re-dated.
 *
 * The seed below goes in through the ORM against a pre-0012 schema, NOT through the ingest layer
 * this PR also changes — a migration test whose fixture is built by the fixed writer cannot fail.
 */
const WRONG_DATE = "2026-08-10";
const PUBLISHED_DATE = "2026-08-05";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tn-wtn-redate-")), "test.db");
}

/** A database migrated only as far as 0011 — i.e. the state every existing local DB is in. */
function seedPreMigrationDb(
  path: string,
  rows: { source: string; value: number; observedOn: string }[],
): void {
  const sqlite = new Database(path);
  try {
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: buildLegacyMigrationsFolder(11) });
    const player = db
      .insert(players)
      .values({ canonicalName: "Umber Ulverton" })
      .returning()
      .all()[0]!;
    for (const row of rows) {
      db.insert(ratingObservations)
        .values({ playerId: player.id, source: row.source, value: row.value, observedOn: row.observedOn })
        .run();
    }
  } finally {
    sqlite.close();
  }
}

function readRatings(path: string): { source: string; value: number; observedOn: string }[] {
  const { db, sqlite } = openDb(path);
  try {
    return db
      .select({
        source: ratingObservations.source,
        value: ratingObservations.value,
        observedOn: ratingObservations.observedOn,
      })
      .from(ratingObservations)
      .all();
  } finally {
    sqlite.close();
  }
}

describe("migration 0012 — re-dating WTN observations to their publication date (#132)", () => {
  it("re-dates the capture-stamped WTN rows without touching their values", () => {
    const path = freshDbPath();
    seedPreMigrationDb(path, [
      { source: "wtn_singles", value: 30.35, observedOn: WRONG_DATE },
      { source: "wtn_doubles", value: 29.69, observedOn: WRONG_DATE },
    ]);

    runMigrations(path);

    expect(readRatings(path)).toEqual([
      { source: "wtn_singles", value: 30.35, observedOn: PUBLISHED_DATE },
      { source: "wtn_doubles", value: 29.69, observedOn: PUBLISHED_DATE },
    ]);
  });

  it("leaves every other source alone, even on the same wrong-looking date", () => {
    // The scope guard. `ntrp` and `tr_dynamic` always stored their publisher's own date, so a row
    // of theirs that happens to fall on 2026-08-10 is CORRECT and re-dating it would be a new
    // defect of exactly the shape this migration exists to remove.
    const path = freshDbPath();
    seedPreMigrationDb(path, [
      { source: "wtn_singles", value: 30.35, observedOn: WRONG_DATE },
      { source: "ntrp", value: 3.5, observedOn: WRONG_DATE },
      { source: "tr_dynamic", value: 3.49, observedOn: WRONG_DATE },
    ]);

    runMigrations(path);

    const bySource = new Map(readRatings(path).map((r) => [r.source, r.observedOn]));
    expect(bySource.get("wtn_singles")).toBe(PUBLISHED_DATE);
    expect(bySource.get("ntrp")).toBe(WRONG_DATE);
    expect(bySource.get("tr_dynamic")).toBe(WRONG_DATE);
  });

  it("leaves a WTN row on any other date alone", () => {
    // Narrow by construction: this migration can only recognise the instance it can identify. A WTN
    // row captured on some other day carries the same defect and is indistinguishable from a
    // correctly-dated one, so it is left rather than guessed at — a limitation the PR states.
    const path = freshDbPath();
    seedPreMigrationDb(path, [{ source: "wtn_singles", value: 30.35, observedOn: "2026-07-01" }]);

    runMigrations(path);

    expect(readRatings(path)[0]?.observedOn).toBe("2026-07-01");
  });

  it("does not abort when the correctly-dated row already exists", () => {
    // `rating_obs_unique` is (player_id, source, observed_on). A database already re-pulled under
    // the fixed parser holds BOTH rows, and a bare UPDATE would violate that index — aborting the
    // whole migration transaction and, because `applyMigrations` is all-or-nothing, blocking every
    // later migration on that database forever. The two rows are the same publication, so the
    // capture-stamped one is the duplicate and is dropped.
    const path = freshDbPath();
    seedPreMigrationDb(path, [
      { source: "wtn_singles", value: 30.35, observedOn: WRONG_DATE },
      { source: "wtn_singles", value: 30.35, observedOn: PUBLISHED_DATE },
      { source: "wtn_doubles", value: 29.69, observedOn: WRONG_DATE },
    ]);

    expect(() => runMigrations(path)).not.toThrow();

    const ratings = readRatings(path);
    expect(ratings.filter((r) => r.source === "wtn_singles")).toEqual([
      { source: "wtn_singles", value: 30.35, observedOn: PUBLISHED_DATE },
    ]);
    expect(ratings.filter((r) => r.source === "wtn_doubles")).toEqual([
      { source: "wtn_doubles", value: 29.69, observedOn: PUBLISHED_DATE },
    ]);
  });

  it("lets a genuinely later publication become the latest observation, which is the point", () => {
    // Recording a correction to this PR's own plan, which claimed "no trajectory reorders". True of
    // the live database — every WTN row there sits alone at 2026-08-10 — but false in general, and
    // the general case is the one worth pinning. A row correctly dated 2026-08-07 by the fixed
    // parser was RANKED BEHIND the mis-dated 2026-08-10 row before this migration, so the dossier
    // showed the older number as current. Re-dating reorders them, and that reorder is the defect
    // being fixed rather than a side effect of fixing it.
    const path = freshDbPath();
    seedPreMigrationDb(path, [
      { source: "wtn_singles", value: 30.35, observedOn: WRONG_DATE },
      { source: "wtn_singles", value: 31.1, observedOn: "2026-08-07" },
    ]);

    runMigrations(path);

    const singles = readRatings(path)
      .filter((r) => r.source === "wtn_singles")
      .sort((a, b) => a.observedOn.localeCompare(b.observedOn));
    expect(singles).toEqual([
      { source: "wtn_singles", value: 30.35, observedOn: PUBLISHED_DATE },
      { source: "wtn_singles", value: 31.1, observedOn: "2026-08-07" },
    ]);
    // Both rows survive — they are two different publications, not a duplicate — and the later one
    // is now genuinely last.
    expect(singles[singles.length - 1]?.value).toBe(31.1);
  });

  it("is a no-op on a second run", () => {
    const path = freshDbPath();
    seedPreMigrationDb(path, [{ source: "wtn_singles", value: 30.35, observedOn: WRONG_DATE }]);

    runMigrations(path);
    const afterFirst = readRatings(path);
    runMigrations(path);

    expect(readRatings(path)).toEqual(afterFirst);
  });

  it("does nothing at all to a fresh database", () => {
    const path = freshDbPath();

    expect(() => runMigrations(path)).not.toThrow();
    expect(readRatings(path)).toEqual([]);
  });
});
