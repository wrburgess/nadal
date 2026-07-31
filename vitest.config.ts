import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Vitest's default is 5000ms, and that default makes THIS suite nondeterministically red — a
    // flaky gate, not a slow one. `docs/findings.md` records the measurement from #44/PR #51 (four
    // consecutive full runs, 2-4 failures each, a DIFFERENT failing set every time, every failure
    // `Test timed out in 5000ms` and never an assertion, every file involved untouched by that
    // diff), and #46 then hit three more instances of it in one run.
    //
    // The cause is not slow code, it is honest work colliding with parallel load: the suite drives
    // REAL on-disk SQLite, spawns REAL `tn` subprocesses, and tokenizes whole HTML fixtures. Those
    // cases measure 2.4s-4.5s ALONE — comfortably under 5s idle, and over it once eight workers
    // compete for cores.
    //
    // Raised here rather than per-test on purpose. #46 first patched the one file that failed, and
    // two DIFFERENT files failed on the next run — the "fix the named instance, miss the class"
    // shape this repo has logged repeatedly. One number, one place, covering every case.
    // 30s is ~6.6x the slowest observed case, so a genuine hang still fails fast instead of
    // hanging CI.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**", "tools/**"],
      thresholds: { lines: 75, functions: 75 },
    },
  },
});
