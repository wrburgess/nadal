import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/**
 * Registers beforeEach/afterEach hooks (call once per describe block, or at module scope) that:
 *  - point TN_SCORECARD_PHOTOS_PATH at a fresh `mkdtempSync` directory before each test,
 *  - restore whatever TN_SCORECARD_PHOTOS_PATH held before this fixture ran — using undefined-safe
 *    semantics (delete when it was unset, rather than resetting it to the string "undefined"),
 *  - remove the temp directory afterward, so tests stop leaking one mkdtemp dir per run.
 *
 * Twin of `useTnRawPath` in test/helpers/tn-raw.ts. Returns an accessor for the current test's
 * generated scorecard-photos root — every `sourceImage` a test writes must land inside this
 * directory (or a subdirectory of it) now that `archiveScorecardImage` refuses anything outside the
 * configured root (#18, Codex adversarial review, rated Critical).
 */
export function useTnScorecardPhotosPath(): { path(): string } {
  const original = process.env.TN_SCORECARD_PHOTOS_PATH;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tn-scorecard-photos-"));
    process.env.TN_SCORECARD_PHOTOS_PATH = dir;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TN_SCORECARD_PHOTOS_PATH;
    else process.env.TN_SCORECARD_PHOTOS_PATH = original;
    rmSync(dir, { recursive: true, force: true });
  });

  return { path: () => dir };
}
