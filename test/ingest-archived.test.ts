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
