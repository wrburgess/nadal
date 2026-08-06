// Issue #111: the actual defect this file exists to catch. `dbPath()`'s unset default used to be
// the BARE relative string `"data/nadal.db"`, resolved by every caller against `process.cwd()` —
// so `tn player pull …` (or ANY command) invoked from anywhere other than the repo root silently
// created (and, on a later run, silently read from) a SECOND, empty `data/nadal.db` under that
// caller's own cwd, rather than the repo's real database. A green `status=ok` was the defect's own
// signature: every command still "succeeded", just against the wrong file.
//
// This is deliberately an end-to-end, subprocess-driven test rather than a unit test of `dbPath()`
// in isolation: running the REAL `tn` binary with `TN_DB_PATH` unset from a real, unrelated cwd is
// the only way to observe the caller's-cwd-independence property this issue is actually about.
// Running it against the REAL repo checkout would write to the operator's live database 23 days
// before a tournament — not permitted — so `makeTnPackageCopy()` materializes a throwaway package
// root instead: a real on-disk copy `tn`'s own module resolution reports as `PACKAGE_ROOT`, entirely
// separate from this checkout's own `data/`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTnPackageCopy } from "./helpers/tn-package-copy.js";

describe("tn's default database path is anchored to the package root, not the caller's cwd", () => {
  it("migrate/write/read from unrelated cwds all reach the SAME database, with no stray data/ under either cwd", () => {
    const pkg = makeTnPackageCopy();
    const cwdA = mkdtempSync(join(tmpdir(), "tn-cwd-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "tn-cwd-b-"));
    const tnBin = join(pkg.root, "bin", "tn");

    // TN_DB_PATH unset THROUGHOUT — the whole point is observing the *default*, not an override.
    const env = { ...process.env };
    delete env.TN_DB_PATH;

    try {
      // 1. Migrate from cwd A.
      const migrateOutput = execFileSync(tnBin, ["db", "migrate"], { cwd: cwdA, env, encoding: "utf8" });
      expect(migrateOutput.trim()).toMatch(/^db migrate status=ok path="/);

      // The database landed under the PACKAGE ROOT the copied module resolves to — not under
      // cwd A, and cwd A got no `data/` directory of its own (the assertion that fails today).
      expect(existsSync(join(pkg.root, "data", "nadal.db"))).toBe(true);
      expect(existsSync(join(cwdA, "data"))).toBe(false);

      // 2. A write from A: `event add` creates a fresh row (`created="true"`) with no network
      // dependency — a plain local DB write.
      const writeOutput = execFileSync(
        tnBin,
        ["event", "add", "Springfield Sectionals", "tournament", "2026-08-28", "2026-08-30"],
        { cwd: cwdA, env, encoding: "utf8" },
      );
      expect(writeOutput).toContain('created="true"');

      // 3. A read from an UNRELATED cwd B: the identical idempotent `event add` call reports
      // `created="false"` — proof it found the SAME already-existing row, since a genuinely
      // different (fresh) database at this issue's old bare-relative default would report
      // `created="true"` again.
      const readOutput = execFileSync(
        tnBin,
        ["event", "add", "Springfield Sectionals", "tournament", "2026-08-28", "2026-08-30"],
        { cwd: cwdB, env, encoding: "utf8" },
      );
      expect(readOutput).toContain('created="false"');

      // Neither caller's cwd ever accumulated its own stray `data/` directory.
      expect(existsSync(join(cwdA, "data"))).toBe(false);
      expect(existsSync(join(cwdB, "data"))).toBe(false);
    } finally {
      pkg.cleanup();
      rmSync(cwdA, { recursive: true, force: true });
      rmSync(cwdB, { recursive: true, force: true });
    }
  });
});
