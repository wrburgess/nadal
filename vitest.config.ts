import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // #173. Fails the run if any path that existed in raw/ or reports/ before it is missing, or
    // has changed type, inode, size or mtime after it — the invariant itself, rather than a static
    // scan for the spellings that happened to break it. Contractor review, PR #174 wave 4: that is
    // the fingerprint's real strength, and "altered" overstated it, since a same-size edit
    // restoring mtime passes. See test/helpers/operator-data-canary.ts for why the scan was
    // withdrawn and what the fingerprint does and does not prove.
    globalSetup: ["test/helpers/operator-data-canary.ts"],
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
      // tools/gate and tools/review are IN this total and report 0%, which is not a gap — their
      // tests are `node:test` suites this runner cannot discover, and they run under
      // `npm run test:tools`, a `config/checks.md` row and a CI step (#146).
      //
      // Measured when the carve-out lifted: 96.83% -> 89.46% lines, against a 75% floor. Say the
      // consequence plainly rather than let the number speak: roughly 1,400 lines counted here are
      // verified somewhere else, so this percentage asserts less about those two directories than
      // it appears to. It is honest only while `tools-tests` stays in the gate. If that row is ever
      // dropped, exclude these two directories again in the same commit — a floor computed over
      // code nothing executes is worse than one that never claimed to cover it.
      exclude: [...coverageConfigDefaults.exclude],
      thresholds: { lines: 75, functions: 75 },
    },
  },
});
