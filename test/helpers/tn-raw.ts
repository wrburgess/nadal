import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/**
 * Registers beforeEach/afterEach hooks (call once per describe block, or at module scope) that:
 *  - point TN_RAW_PATH at a fresh `mkdtempSync` directory before each test,
 *  - restore whatever TN_RAW_PATH held before this fixture ran — using undefined-safe semantics
 *    (delete when it was unset, rather than resetting it to the string "undefined"),
 *  - remove the temp directory afterward, so tests stop leaking one mkdtemp dir per run.
 *
 * Twin of `useTnDbPath` in test/helpers/tn-db.ts. Returns an accessor for the current test's
 * generated raw root.
 */
export function useTnRawPath(): { path(): string } {
  const original = process.env.TN_RAW_PATH;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tn-raw-"));
    process.env.TN_RAW_PATH = dir;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TN_RAW_PATH;
    else process.env.TN_RAW_PATH = original;
    rmSync(dir, { recursive: true, force: true });
  });

  return { path: () => dir };
}
