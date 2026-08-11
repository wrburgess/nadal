import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { nameKey } from "../src/db/name-key.js";
import { players } from "../src/db/schema.js";
import { pullArchivedWtnProfile } from "../src/ingest/wtn-profile-pull.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const fixture = loadFixture("wtn/profile-full");

describe("pullArchivedWtnProfile", () => {
  useTnDbPath();
  const raw = useTnRawPath();

  it("writes ageRange and normalized gender onto the player already linked by wtnTennisId", async () => {
    // Realistic ordering (#128): a player's `wtn_tennis_id` is normally already on file BEFORE this
    // route ever runs — it was captured off the USTA-embedded WTN widget (`src/ingest/archived.ts`)
    // the first time this player's USTA profile was pulled. This route enriches that same row with
    // the two fields ONLY the standalone WTN profile page can supply.
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const seeded = db
        .insert(players)
        .values({ canonicalName: "Micah Merrivale", nameKey: nameKey("Micah Merrivale"), wtnTennisId: "MER9000003" })
        .returning()
        .get();

      const savedPath = join(raw.path(), "saved-wtn-profile.html");
      writeFileSync(savedPath, fixture.html, "utf8");

      const result = await pullArchivedWtnProfile({ db, path: savedPath, sourceUrl: fixture.source.url });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.player.id).toBe(seeded.id);
      expect(result.player.ageRange).toBe("41-50");
      // Issue #130's normalization, exercised end to end: the page prints "Male" (already the
      // stored vocabulary here, unlike USTA's "MALE") and the write path still routes it through
      // `normalizeGender` — the third of the three writers task 4 wires, so it cannot drift later.
      expect(result.player.gender).toBe("Male");
      // canonicalName is left UNTOUCHED. The fixture's lowercase spelling ("micah merrivale") is NOT
      // a redaction artifact — the live page genuinely renders the name lower-case and capitalizes
      // it with a CSS text-transform, so lower-case is what any capture of this page contains. That
      // is precisely why this route does not rename: worldtennisnumber.com is not this project's
      // source of truth for how a name is cased, and its job here is enrichment.
      expect(result.player.canonicalName).toBe("Micah Merrivale");

      expect(result.archivedPath.startsWith(raw.path())).toBe(true);
      const archived = readdirSync(join(raw.path(), "wtn"));
      expect(archived.some((f) => f.endsWith(".html"))).toBe(true);

      const rows = db.select().from(players).all();
      expect(rows).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("creates a new player via the name-tier fallback and links wtnTennisId, when no id match exists on file", async () => {
    // The exceptional path — nothing on file yet has this wtnTennisId, so resolution falls to the
    // page's own name. `resolvePlayer` itself does the create; this route's job (mirroring
    // `pullArchivedUstaProfile`) is only to make sure the just-resolved id ends up persisted even
    // on that fallback path, so a second pull of the same profile hits the id tier directly.
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const savedPath = join(raw.path(), "saved-wtn-profile-new.html");
      writeFileSync(savedPath, fixture.html, "utf8");

      const result = await pullArchivedWtnProfile({ db, path: savedPath, sourceUrl: fixture.source.url });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.player.canonicalName).toBe("micah merrivale");
      expect(result.player.wtnTennisId).toBe("MER9000003");
      expect(result.player.ageRange).toBe("41-50");
      expect(result.player.gender).toBe("Male");
    } finally {
      sqlite.close();
    }
  });

  it("REFUSES a name-tier match onto an existing player, rather than branding them with another person's ITF id", async () => {
    // Codex adversarial review round 1, class A. Two people can share a name. Here the database
    // already holds a DIFFERENT "Micah Merrivale" — one with no ITF id — and the captured profile
    // belongs to the person whose id is MER9000003. The id tier misses, the name tier hits the
    // wrong row, and an unconditional write would put MER9000003 plus that stranger's age range and
    // gender onto them PERMANENTLY: every later pull for the real owner would then resolve by id
    // straight onto the wrong row, and `players_wtn_tennis_id_unique` would block the right one
    // from ever taking the id back.
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const stranger = db
        .insert(players)
        .values({ canonicalName: "micah merrivale", nameKey: nameKey("micah merrivale") })
        .returning()
        .get();
      expect(stranger.wtnTennisId).toBeNull();

      const savedPath = join(raw.path(), "saved-wtn-profile-collision.html");
      writeFileSync(savedPath, fixture.html, "utf8");

      const result = await pullArchivedWtnProfile({ db, path: savedPath, sourceUrl: fixture.source.url });

      expect(result.kind).toBe("error");

      // The stranger's row is untouched in every field this route can write.
      const row = db.select().from(players).where(eq(players.id, stranger.id)).all()[0];
      expect(row?.wtnTennisId).toBeNull();
      expect(row?.ageRange).toBeNull();
      expect(row?.gender).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("returns ambiguous with no partial write when the page's name is near more than one player on file", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      // Two players sharing one folded name key with the profile's own name ("micah merrivale"),
      // neither carrying the profile's wtnTennisId — so id-tier resolution fails through to the
      // exact-name tier, which reports every candidate rather than guessing.
      db.insert(players).values({ canonicalName: "Micah Merrivale", nameKey: nameKey("Micah Merrivale") }).run();
      db.insert(players).values({ canonicalName: "MICAH MERRIVALE", nameKey: nameKey("MICAH MERRIVALE") }).run();

      const savedPath = join(raw.path(), "saved-wtn-profile-ambiguous.html");
      writeFileSync(savedPath, fixture.html, "utf8");

      const result = await pullArchivedWtnProfile({ db, path: savedPath, sourceUrl: fixture.source.url });

      expect(result.kind).toBe("ambiguous");
      if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
      expect(result.incoming).toBe("micah merrivale");
      expect(result.candidates.sort()).toEqual(["MICAH MERRIVALE", "Micah Merrivale"].sort());

      // No partial write: still exactly the two seeded rows, neither touched.
      const rows = db.select().from(players).all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.ageRange === null && r.gender === null)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("a parse failure returns {kind: 'error'} and leaves an existing row unchanged", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const seeded = db
        .insert(players)
        .values({ canonicalName: "Micah Merrivale", nameKey: nameKey("Micah Merrivale"), wtnTennisId: "MER9000003" })
        .returning()
        .get();

      // Break the parse (issue #128's own duplicate-block guard) rather than inventing a new
      // failure mode — this is a real ParseError this parser already throws, exercised end to end.
      const IDENTITY_BLOCK =
        '<div class="profile-header-module__playerDetailsHeader___p1yB3"><h2 class="profile-header-module__textWhite___QQsdG">micah merrivale</h2><p class="profile-header-module__textWhite___QQsdG">Male<span class="profile-header-module__playerStatsPadding___X3N39">|</span>41-50<span class="profile-header-module__playerStatsPadding___X3N39">|</span><img src="https://prd-itf-web.clubspark.pro//Content/Public/Clubspark/itf/global/img/flags/US.png" alt="USA" title="USA" class="generic-components-module__flag___e-xb1"> USA</p></div>';
      const broken = fixture.html.replace(IDENTITY_BLOCK, IDENTITY_BLOCK + IDENTITY_BLOCK);
      expect(broken).not.toBe(fixture.html);

      const savedPath = join(raw.path(), "saved-wtn-profile-broken.html");
      writeFileSync(savedPath, broken, "utf8");

      const result = await pullArchivedWtnProfile({ db, path: savedPath, sourceUrl: fixture.source.url });

      expect(result.kind).toBe("error");

      const row = db.select().from(players).where(eq(players.id, seeded.id)).all()[0];
      expect(row).toMatchObject({ ageRange: null, gender: null, canonicalName: "Micah Merrivale" });
    } finally {
      sqlite.close();
    }
  });

  it("still archives the page even when the parse fails (archive-before-parse)", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const broken = fixture.html.replace(/playerDetailsHeader/g, "somethingElse");
      expect(broken).not.toBe(fixture.html);

      const savedPath = join(raw.path(), "saved-wtn-profile-broken-2.html");
      writeFileSync(savedPath, broken, "utf8");

      const wtnDir = join(raw.path(), "wtn");
      const before = existsSync(wtnDir) ? readdirSync(wtnDir).length : 0;
      const result = await pullArchivedWtnProfile({ db, path: savedPath, sourceUrl: fixture.source.url });
      expect(result.kind).toBe("error");

      const after = readdirSync(wtnDir).length;
      expect(after).toBeGreaterThan(before);
    } finally {
      sqlite.close();
    }
  });

  it("running it twice on the same file matches the same player, not a duplicate", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const savedPath = join(raw.path(), "saved-wtn-profile-twice.html");
      writeFileSync(savedPath, fixture.html, "utf8");

      const first = await pullArchivedWtnProfile({ db, path: savedPath, sourceUrl: fixture.source.url });
      const second = await pullArchivedWtnProfile({ db, path: savedPath, sourceUrl: fixture.source.url });

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
