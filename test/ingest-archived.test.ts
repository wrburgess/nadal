import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { players, ratingObservations } from "../src/db/schema.js";
import { pullArchivedUstaProfile } from "../src/ingest/archived.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const fixture = loadFixture("usta/profile-wtn-both");

describe("pullArchivedUstaProfile", () => {
  useTnDbPath();
  const raw = useTnRawPath();

  it("archives the handed-in file, then parses BOTH usta and wtn from the same bytes", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const savedPath = join(raw.path(), "saved-usta-profile.html");
      writeFileSync(savedPath, fixture.html, "utf8");

      const result = await pullArchivedUstaProfile({
        db,
        path: savedPath,
        sourceUrl: fixture.source.url,
      });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.player.canonicalName).toBe("Umber Ulverton");
      expect(result.player.ustaUaid).toBe("900000002");
      expect(result.player.wtnTennisId).toBe("BRA9000002");
      expect(result.archivedPath.startsWith(raw.path())).toBe(true);

      const ratings = db.select().from(ratingObservations).all();
      expect(ratings.find((r) => r.source === "ntrp")).toMatchObject({ value: 3.5, ratingType: "C" });

      const rows = db.select().from(players).all();
      expect(rows).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("dates a WTN observation from the widget, not from the day we captured the page (#132)", async () => {
    // The defect this pins produced 133 rows in the live database dated `2026-08-10` carrying a
    // number the page itself stamped `08/05/2026`. The two dates have to be far apart in the
    // assertion or it cannot tell them apart: the fixture's WTN sections read `Updated 11/26/2025`
    // and today is whatever day this suite runs, so a pass here is only meaningful because those
    // can never coincide.
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const savedPath = join(raw.path(), "saved-usta-profile-dates.html");
      writeFileSync(savedPath, fixture.html, "utf8");

      const result = await pullArchivedUstaProfile({ db, path: savedPath, sourceUrl: fixture.source.url });
      expect(result.kind).toBe("ok");

      const ratings = db.select().from(ratingObservations).all();
      const today = new Date().toISOString().slice(0, 10);

      expect(ratings.find((r) => r.source === "wtn_singles")).toMatchObject({
        value: 31.65,
        observedOn: "2025-11-26",
      });
      expect(ratings.find((r) => r.source === "wtn_doubles")).toMatchObject({
        value: 30.15,
        observedOn: "2025-11-26",
      });
      expect(ratings.filter((r) => r.observedOn === today)).toHaveLength(0);

      // The sibling write, unchanged: NTRP already stored the publisher's own date and this issue
      // must not disturb it. Without this the WTN fix could pass while silently re-dating NTRP.
      expect(ratings.find((r) => r.source === "ntrp")).toMatchObject({ observedOn: "2025-12-31" });
    } finally {
      sqlite.close();
    }
  });

  it("gives each discipline its own date rather than one date for the widget (#132)", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // Derived from the real fixture bytes, changing only the doubles section's Updated date, so
      // a writer that read one date for the whole widget is caught end to end and not only at the
      // parser boundary.
      const skewed = fixture.html.replace(
        '<p class="v-form-wtn-widget__section-subtitle">Last Played 11/15/2025</p><p class="v-form-wtn-widget__section-subtitle">Updated 11/26/2025</p>',
        '<p class="v-form-wtn-widget__section-subtitle">Last Played 11/15/2025</p><p class="v-form-wtn-widget__section-subtitle">Updated 12/03/2025</p>',
      );
      expect(skewed).not.toBe(fixture.html);

      const savedPath = join(raw.path(), "saved-usta-profile-skewed.html");
      writeFileSync(savedPath, skewed, "utf8");

      const result = await pullArchivedUstaProfile({ db, path: savedPath, sourceUrl: fixture.source.url });
      expect(result.kind).toBe("ok");

      const ratings = db.select().from(ratingObservations).all();
      expect(ratings.find((r) => r.source === "wtn_singles")?.observedOn).toBe("2025-11-26");
      expect(ratings.find((r) => r.source === "wtn_doubles")?.observedOn).toBe("2025-12-03");
    } finally {
      sqlite.close();
    }
  });

  it("running it twice on the same file matches the same player, not a duplicate", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const savedPath = join(raw.path(), "saved-usta-profile-2.html");
      writeFileSync(savedPath, fixture.html, "utf8");

      const first = await pullArchivedUstaProfile({ db, path: savedPath, sourceUrl: fixture.source.url });
      const second = await pullArchivedUstaProfile({ db, path: savedPath, sourceUrl: fixture.source.url });

      expect(first.kind).toBe("ok");
      expect(second.kind).toBe("ok");
      if (first.kind === "ok" && second.kind === "ok") {
        expect(second.player.id).toBe(first.player.id);
      }
      expect(db.select().from(players).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
