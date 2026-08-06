import { chmodSync, cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

/**
 * Materializes a THROWAWAY package root for issue #111's cwd-independence regression
 * (`test/db-default-path-cwd.test.ts`): a real, on-disk copy of `src/`, `drizzle/`, `bin/tn`, and
 * `package.json`, with `node_modules` SYMLINKED in rather than copied (it is ~190MB and none of it
 * needs to be duplicated — only its resolution path matters).
 *
 * `src/` MUST be COPIED, not symlinked, and this is the load-bearing detail the whole fixture rests
 * on: Node resolves an ESM specifier's `import.meta.url` to the file's REAL, symlink-resolved path,
 * not the path it was reached through. A symlinked `src/` would make `src/fs/package-root.ts`
 * report the REAL repository as `PACKAGE_ROOT` — the exact thing this fixture exists to avoid — and
 * the regression this test guards against would silently stop being tested at all while still
 * reporting green. `drizzle/`, `bin/tn`, and `package.json` are copied for the same reason
 * (`bin/tn` in particular re-derives its own directory from `$0`, which a symlink would resolve
 * through to the real repo exactly like Node's ESM loader does).
 */
export function makeTnPackageCopy(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "tn-package-copy-"));

  cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "drizzle"), join(root, "drizzle"), { recursive: true });
  cpSync(join(REPO_ROOT, "bin", "tn"), join(root, "bin", "tn"));
  cpSync(join(REPO_ROOT, "package.json"), join(root, "package.json"));
  // `cpSync` does not document preserving the execute bit across platforms — set it explicitly
  // rather than relying on an incidental copy behavior. `bin/tn` is a `#!/bin/sh` launcher and
  // `spawnSync` needs to exec it directly.
  chmodSync(join(root, "bin", "tn"), 0o755);

  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");

  return {
    root,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
