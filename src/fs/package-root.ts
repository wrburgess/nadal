import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Issue #111: every one of `dbPath()`/`rawRoot()`/`reportsRoot()`/`scorecardPhotosRoot()` used to
// return a BARE repo-relative default (`"data/nadal.db"`, `"raw"`, …) with no anchor at all — fine
// for a check that only ever `resolve()`s against `process.cwd()`, wrong the moment a caller's cwd
// isn't the repo root: `cd docs && tn player pull …` silently created (and read from) a SECOND,
// empty `./docs/data/nadal.db` rather than the repo's real database. Anchoring to THIS module's own
// on-disk location — not `process.cwd()` — makes the default independent of the caller's cwd,
// exactly like `src/db/client.ts` already anchors `MIGRATIONS_FOLDER` and `src/fs/output-root.ts`
// already anchors its own (now-removed) `PACKAGE_ROOT`.
//
// A separate module, deliberately not folded into `output-root.ts`: that file pulls in
// `node:child_process` and the whole git-tracking guard (`assertNotGitTracked`), and `src/db/
// client.ts` — which has no privacy-guard concerns at all — must not import any of that just to
// anchor a database path. `output-root.ts` imports `PACKAGE_ROOT` from here instead of defining its
// own, so there is exactly one definition repo-wide.
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `override ?? join(PACKAGE_ROOT, relativePath)` — the accessor-level anchor every `DEFAULT_*`
 * constant's accessor now shares. `relativePath` (e.g. `DEFAULT_DB_PATH`) stays a BARE directory
 * name in its own module: several of those constants double as the `permittedDir` argument to
 * `assertRootSafe`/`assertOutputPathSafe`, which compare against `resolve(PACKAGE_ROOT,
 * permittedDir)` themselves — anchoring the CONSTANT would make that comparison compare two already
 * -absolute paths for no reason and would be one more place a future reader has to re-derive "is
 * this still repo-relative". The anchor belongs in the accessor, exactly once, here.
 *
 * `??`, not `||`: preserved verbatim from every accessor this replaces, so an explicit but
 * EMPTY-STRING override (`TN_DB_PATH=""`) keeps behaving exactly as it does today — as a set,
 * empty-string value passed straight through — rather than silently being treated as "unset" and
 * falling through to the repo-relative default.
 */
export function repoDefault(override: string | undefined, relativePath: string): string {
  return override ?? join(PACKAGE_ROOT, relativePath);
}
