import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const TN_BIN = join(REPO_ROOT, "bin", "tn");

const EXPECTED_TABLES = [
  "players", "player_aliases", "teams", "team_memberships", "events",
  "team_matches", "court_matches", "court_match_players",
  "rating_observations", "availability", "captain_notes", "request_log",
].sort();

/**
 * Eight rounds, and the number is derived rather than picked. Measured against the pre-fix code,
 * two concurrent processes left at least one of them failing in **27 of 58 rounds (~47%)** across
 * four separate runs (4/10, 10/20, 11/20, 2/8), so eight clean rounds against a regressed
 * implementation has probability ~0.53^8 ≈ 0.6%. At ~0.8s per round that costs ~6.5s, which leaves
 * real headroom under the suite's 30s timeout even when eight vitest workers are competing for
 * cores (`vitest.config.ts` records why that headroom matters here).
 *
 * **Two processes, not more** — this is the counter-intuitive part and it is measured, not assumed.
 * At four concurrent processes the failure rate *dropped* to 2/15: extra processes add startup
 * jitter, which spreads them past each other instead of into each other. A bigger fan-out would
 * look more thorough and discriminate less.
 *
 * **What this test is and is not.** It proves the whole path end to end, through the real `bin/tn`
 * launcher and two real OS processes — the only test here that does. But it is probabilistic in its
 * ability to *catch* a regression, so it is the second guard, not the first:
 * `test/db-migrate-serialization.test.ts` asserts the ordering invariant deterministically and
 * cannot miss one. It is not probabilistic in the other direction — the fixed implementation was
 * clean across 35 measured rounds — so it does not flake on correct code.
 */
const ROUNDS = 8;

/**
 * This one test carries its own timeout instead of using the suite-wide 30s, and that is not the
 * move `vitest.config.ts` argues against. Its comment rejects patching *the file that happened to
 * fail* while the real cause — honest work colliding with parallel load — goes on hitting different
 * files each run. This test is not one of those: it is the suite's deliberate outlier, spawning 16
 * real `tn` subprocesses on purpose, and it is bounded by how long those take rather than by
 * anything about its assertions.
 *
 * Measured: 6.8s alone, **15.6s with eight vitest workers competing** — over half the shared 30s
 * budget, on a developer machine that is quieter than CI. 120s keeps the same ~7x headroom over the
 * slowest observed case that the shared number was chosen for, so a genuine hang still fails fast.
 */
const TIMEOUT_MS = 120_000;

async function migrate(dbPath: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(TN_BIN, ["db", "migrate"], {
      env: { ...process.env, TN_DB_PATH: dbPath },
      encoding: "utf8",
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim(), code: e.code ?? 1 };
  }
}

/**
 * Issue #117: two `tn db migrate` processes bootstrapping the same NEW database could interleave so
 * that one reported `status=error` while the database was fully and correctly migrated. Two
 * independent mechanisms produced that one symptom, and both are exercised here because both live in
 * the same window — the first open of a brand-new file:
 *
 *   - the migration journal being read outside the transaction that acts on it, so the second
 *     process replayed migration 0000 (`Failed to run the query 'CREATE TABLE availability …'`);
 *   - `PRAGMA journal_mode = WAL` not honouring SQLite's busy handler, so two processes converting
 *     the same fresh database collided (`SQLITE_BUSY: database is locked`) before the migrator was
 *     even reached.
 */
describe("two concurrent `tn db migrate` processes on one new database (#117)", () => {
  it("both report status=ok and the database ends up completely migrated, every round", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const dbPath = join(mkdtempSync(join(tmpdir(), "tn-concurrent-")), "concurrent.db");

      const results = await Promise.all([migrate(dbPath), migrate(dbPath)]);

      for (const [index, result] of results.entries()) {
        const where = `round ${round}, process ${index}`;
        expect(result.code, `${where} exited non-zero: ${result.stdout} ${result.stderr}`).toBe(0);
        expect(result.stdout, where).toBe(`db migrate status=ok path="${dbPath}"`);
        // Exact equality, not "does not contain an error": the telemetry writer prints its own
        // diagnostic line to stderr when a `request_log` insert fails, and a raced bootstrap used to
        // produce exactly that. Asserting emptiness catches the next stderr diagnostic nobody has
        // thought of; a blacklist only catches the ones already named.
        expect(result.stderr, where).toBe("");
      }

      // Both processes claiming success is not the same as the database being right — assert the
      // end state too, or a fix that swallowed the error would pass this test.
      const sqlite = new Database(dbPath, { fileMustExist: true });
      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%drizzle%' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((row) => (row as { name: string }).name)
        .sort();
      const applied = sqlite
        .prepare("SELECT count(*) AS count FROM `__drizzle_migrations`")
        .get() as { count: number };
      sqlite.close();

      expect(tables, `round ${round}`).toEqual(EXPECTED_TABLES);
      // Each migration recorded exactly once: two processes must not both write journal rows.
      expect(applied.count, `round ${round}`).toBe(12);
    }
  }, TIMEOUT_MS);
});
