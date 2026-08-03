// Issue #87: `package.json` declares `"bin": { "tn": "bin/tn" }`, and `npm link` installs that
// launcher as a SYMLINK in the global bin directory. The launcher derived its repo root from
// `dirname "$0"` without resolving the symlink, so `$DIR` became the Node installation and the
// `tsx` exec failed with "No such file or directory" — the declared entry point never worked.
//
// These tests drive the REAL binary through `spawnSync`, following the convention in
// test/cli-main-exit-code.test.ts. An in-process `dispatch()` test cannot reach this defect at all:
// it lives in the shell launcher, above every line of TypeScript in this repo.
//
// Each case asserts on the help banner, so a pass means the launcher actually located BOTH
// node_modules/.bin/tsx and src/cli/main.ts from the resolved root — not merely that it exited 0.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const TN_BIN = join(REPO_ROOT, "bin", "tn");
const BANNER = "tn <noun> <verb> <target> [payload] [flags]";

// `cwd` defaults to a directory that is NEITHER the repo root nor any link's directory, so a
// launcher that resolved a relative link target against `$PWD` — the classic hand-rolled-loop
// defect — cannot pass by coincidence.
// The spawn timeout sits BELOW vitest.config.ts's 30s testTimeout on purpose: a wedged launcher
// then surfaces as this call returning with `signal: "SIGTERM"` — a legible failure naming the
// process — instead of vitest killing the test first and reporting only "timed out in 30000ms".
function runLauncher(launcherPath: string, cwd: string = tmpdir()): SpawnSyncReturns<string> {
  return spawnSync(launcherPath, ["--help"], { cwd, encoding: "utf8", timeout: 20_000 });
}

// Every temp directory is realpath'd before a link is built inside it. On macOS `os.tmpdir()` is
// itself a symlink (`/var` -> `/private/var`), so a relative link target computed from the logical
// path dangles when the kernel resolves it from the real one — the link then fails to EXEC, and
// the case would report a spawn error instead of exercising the launcher at all.
function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

function expectBanner(result: SpawnSyncReturns<string>): void {
  // stderr is asserted too: the pre-fix failure printed its diagnostic there and exited non-zero,
  // so a status-only assertion would report the ENOENT as an unexplained failure.
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.split("\n")[0]).toBe(BANNER);
}

describe("bin/tn resolves its repo root through symlinks (the `npm link` install shape)", () => {
  it("runs when invoked by its real path", () => {
    // The path that already worked. This is the regression anchor: every other case here changes
    // how the launcher is reached, and this one guards against fixing those by breaking this.
    expectBanner(runLauncher(TN_BIN));
  });

  it("runs when invoked through a symlink in another directory", () => {
    // Exactly what `npm link` creates: <prefix>/bin/tn -> <repo>/bin/tn. The defect this fixes.
    const globalBin = makeTempDir("tn-gbin-");
    const linked = join(globalBin, "tn");
    symlinkSync(TN_BIN, linked);

    expectBanner(runLauncher(linked));
  });

  it("runs when invoked through a chain of symlinks", () => {
    // A single-step resolution passes the case above and still fails here. Node-version managers
    // layer a shim directory over an install directory, so chains are the normal case, not exotic.
    const first = makeTempDir("tn-chain-a-");
    const second = makeTempDir("tn-chain-b-");
    const middle = join(second, "tn");
    const outer = join(first, "tn");
    symlinkSync(TN_BIN, middle);
    symlinkSync(middle, outer);

    expectBanner(runLauncher(outer));
  });

  it("runs when the symlink's target is relative", () => {
    // `ln -s ../real/tn` — a relative target must resolve against the LINK's own directory, not
    // against the process's working directory. The cases above use absolute targets and cannot
    // distinguish the two; `runLauncher` runs from an unrelated cwd to make the difference visible.
    //
    // The target is deliberately SHORT and does not climb past its own root. A long
    // `relative(here, TN_BIN)` chain would be a false green: `..` at `/` is a no-op, so once a
    // target climbs to the filesystem root the working directory stops mattering and a launcher
    // resolving against `$PWD` reaches the same file anyway. Verified by mutation — with the long
    // form, breaking the fix in exactly this way left this test GREEN.
    const root = makeTempDir("tn-rel-");
    const realDir = join(root, "real");
    const linkDir = join(root, "links");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    const middle = join(realDir, "tn");
    const linked = join(linkDir, "tn");
    symlinkSync(TN_BIN, middle);
    symlinkSync(relative(linkDir, middle), linked);

    expectBanner(runLauncher(linked));
  });

  it("runs when a relative target passes through a directory whose name contains spaces", () => {
    // Every path the resolution touches — $0, the link target, the derived root — has to survive
    // word splitting. A space in a macOS path is ordinary, not exotic, and an unquoted expansion
    // anywhere in the loop would split it into arguments and fail here while passing every case
    // above. Combined with a relative target so both hazards apply to the same path at once.
    const root = makeTempDir("tn-space-");
    const spaced = join(root, "with space", "bin");
    const linkDir = join(root, "another dir");
    mkdirSync(spaced, { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    const middle = join(spaced, "tn");
    const linked = join(linkDir, "tn");
    symlinkSync(TN_BIN, middle);
    symlinkSync(relative(linkDir, middle), linked);

    expectBanner(runLauncher(linked));
  });

  it("runs when invoked by a relative path from the repo root (the documented no-install route)", () => {
    // `docs/runbooks/README.md` offers `./bin/tn` to an HC who would rather not install anything,
    // so that invocation is a documented interface with the same standing as the linked one. `$0`
    // is then a relative path that is NOT a symlink — the branch every other case here skips.
    expectBanner(runLauncher("./bin/tn", REPO_ROOT));
  });
});
