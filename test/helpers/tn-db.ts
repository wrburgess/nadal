import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/**
 * Registers beforeEach/afterEach hooks (call once per describe block, or at module scope) that:
 *  - point TN_DB_PATH at a fresh `mkdtempSync` directory before each test,
 *  - restore whatever TN_DB_PATH held before this fixture ran — using undefined-safe semantics
 *    (delete when it was unset, rather than resetting it to the string "undefined"),
 *  - remove the temp directory afterward, so tests stop leaking one mkdtemp dir per run.
 *
 * A test may still overwrite `process.env.TN_DB_PATH` itself mid-test (e.g. to exercise a specific
 * failure path); this fixture only owns the value it sets in its own beforeEach and the original it
 * captured, so that stays safe.
 *
 * Returns an accessor for the current test's generated path.
 */
export function useTnDbPath(filename = "test.db"): { path(): string } {
  const original = process.env.TN_DB_PATH;
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tn-"));
    dbPath = join(dir, filename);
    process.env.TN_DB_PATH = dbPath;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TN_DB_PATH;
    else process.env.TN_DB_PATH = original;
    rmSync(dir, { recursive: true, force: true });
  });

  return { path: () => dbPath };
}

/**
 * Registers just the restore half of the TN_DB_PATH fixture: captures whatever TN_DB_PATH holds
 * right now, and restores it (undefined-safe) in an afterEach. For describe blocks whose own tests
 * set/delete TN_DB_PATH directly (e.g. to test fallback-when-unset behavior) rather than wanting a
 * temp db file created for them.
 */
export function restoreTnDbPathAfterEach(): void {
  const original = process.env.TN_DB_PATH;
  afterEach(() => {
    if (original === undefined) delete process.env.TN_DB_PATH;
    else process.env.TN_DB_PATH = original;
  });
}
