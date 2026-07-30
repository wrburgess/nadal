import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const TN_BIN = join(REPO_ROOT, "bin", "tn");

describe("tn binary exit code (real process, not the in-process dispatch() return value)", () => {
  it("exits non-zero and prints a status=error line on stderr when a command fails", () => {
    // The only real-binary test before this one (cli-db-migrate-cwd.test.ts) covers just the
    // success path, where execFileSync can't distinguish "the process exited 0" from "the process
    // exited with no exit code set at all" — main.ts's `process.exitCode = code` line is otherwise
    // 0%-covered. Force a real failure (ENOTDIR: TN_DB_PATH nested inside a path segment that is a
    // regular file, so mkdirSync(dirname(path), { recursive: true }) throws — same technique as
    // cli-db-migrate-command.test.ts's in-process equivalent) and assert on spawnSync's own
    // `status`, which only reflects what the OS actually saw as this process's exit code.
    const blockerFile = join(mkdtempSync(join(tmpdir(), "tn-")), "blocker");
    writeFileSync(blockerFile, "not a directory");
    const dbPath = join(blockerFile, "nested", "test.db");

    const result = spawnSync(TN_BIN, ["db", "migrate"], {
      env: { ...process.env, TN_DB_PATH: dbPath },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    // The command's own one-line status=error summary is the first stderr line. Telemetry's own
    // write attempt (inside logRequest's wrapper) hits the exact same broken path and fails too,
    // surfacing as a second "telemetry: request_log write failed" diagnostic line per item 5's
    // contract — check the first line specifically, rather than anchoring the whole trimmed
    // stderr, so this test stays about the exit-code/first-line contract it exists to cover.
    const [firstLine] = result.stderr.trim().split("\n");
    expect(firstLine).toMatch(/^db migrate status=error message=".+"$/);
  });
});
