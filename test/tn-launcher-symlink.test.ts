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
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("runs through npm link's actual on-disk layout", () => {
    // Not a synthesized shape — this is what `npm link` really produced on the machine that filed
    // #87, read back off disk:
    //
    //   <prefix>/bin/tn -> ../lib/node_modules/nadal/bin/tn      (RELATIVE target)
    //   <prefix>/lib/node_modules/nadal -> <the repo>            (a symlinked DIRECTORY mid-path)
    //
    // Both hazards in one path, and the directory link is the one every other case here misses:
    // resolution walks the final component only, so `$DIR` keeps the LOGICAL path through the
    // package link, and POSIX `cd` (logical by default) is what makes that land on the real root.
    // The case above marked this layout a known limitation; measuring it showed it works, so it is
    // pinned here rather than left as a claim in a PR body.
    const prefix = makeTempDir("tn-npmlink-");
    const nodeModules = join(prefix, "lib", "node_modules");
    const binDir = join(prefix, "bin");
    mkdirSync(nodeModules, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    symlinkSync(REPO_ROOT, join(nodeModules, "nadal"));
    symlinkSync("../lib/node_modules/nadal/bin/tn", join(binDir, "tn"));

    expectBanner(runLauncher(join(binDir, "tn")));
  });

  // The two cases below cover the error path an adversarial review surfaced on PR #88: if
  // `readlink` cannot answer for a path that IS a symlink, an unguarded loop treats the empty
  // answer as a relative target, `SELF` becomes "<dir>/", and `$DIR` lands on the PARENT of the
  // real root — a misleading "tsx not found" where that parent is bare, and a DIFFERENT checkout's
  // code executed where it is not.
  //
  // In production that state is reached by a link removed or replaced between `[ -L ]` and
  // `readlink`, which no test can hit deterministically. Stubbing `readlink` earlier on `PATH`
  // reaches the identical branch on purpose rather than by race — the launcher calls it unqualified.
  function withStubbedReadlink(body: string): string {
    const stubDir = makeTempDir("tn-stub-");
    const stub = join(stubDir, "readlink");
    writeFileSync(stub, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return stubDir;
  }

  it("does not depend on `dirname`, so a broken one on PATH cannot derive a wrong root", () => {
    // The fix-verification pass on PR #88 flagged that guarding `readlink` closed one INSTANCE of
    // "an unchecked helper silently yields a wrong execution root" and left the class open through
    // two unchecked `dirname` calls. The answer is not a third guard: the launcher now splits paths
    // with parameter expansion, so `dirname` is never invoked and cannot fail. A broken `dirname`
    // earlier on PATH is the executable form of that claim — it must change nothing.
    const globalBin = makeTempDir("tn-dirname-");
    const linked = join(globalBin, "tn");
    symlinkSync(relative(globalBin, TN_BIN), linked); // relative: exercises the in-loop split too
    const stubDir = makeTempDir("tn-dirname-stub-");
    writeFileSync(join(stubDir, "dirname"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const result = spawnSync(linked, ["--help"], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    });

    expectBanner(result);
  });

  it("fails closed, not silently, when readlink exits non-zero", () => {
    const globalBin = makeTempDir("tn-rl-fail-");
    const linked = join(globalBin, "tn");
    symlinkSync(TN_BIN, linked);
    const stubDir = withStubbedReadlink("exit 1");

    const result = spawnSync(linked, ["--help"], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    // The diagnostic must NAME the path it could not resolve — the whole point is that the failure
    // is legible instead of surfacing later as a confusing "tsx: No such file or directory".
    expect(result.stderr.trim()).toBe(`tn: cannot resolve symlink: ${linked}`);
  });

  it("fails closed when readlink succeeds but returns an empty target", () => {
    // The nastier half: exit 0 with no output. An `|| [ -z "$TARGET" ]` guard is required — a
    // status-only check passes this straight through to the wrong-root execution above.
    const globalBin = makeTempDir("tn-rl-empty-");
    const linked = join(globalBin, "tn");
    symlinkSync(TN_BIN, linked);
    const stubDir = withStubbedReadlink("exit 0");

    const result = spawnSync(linked, ["--help"], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(`tn: cannot resolve symlink: ${linked}`);
  });

  it("runs when invoked by a relative path from the repo root (the documented no-install route)", () => {
    // `docs/runbooks/README.md` offers `./bin/tn` to an HC who would rather not install anything,
    // so that invocation is a documented interface with the same standing as the linked one. `$0`
    // is then a relative path that is NOT a symlink — the branch every other case here skips.
    expectBanner(runLauncher("./bin/tn", REPO_ROOT));
  });
});
