import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrateToAllButLast } from "./helpers/migrations.js";

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

  // #160. The two tests above cover a command that HANDLES its own failure. The bug was the other
  // half: an error a command re-throws (11 of 14 do, deliberately — `if (!isEventRefusal(err))
  // throw err;`) reached `logRequest`, was used to label a telemetry row, and was then discarded.
  // `tn` exited 1 with zero bytes on both streams. These assert at the only layer that can prove
  // it: a real process, where "printed nothing" is observable rather than argued about.
  it("#160: an error the command RE-THROWS still reaches stderr — it used to vanish entirely", () => {
    // A corrupt database file: no refusal predicate in any command matches the resulting
    // SqliteError, so it propagates exactly like the production `no such column` did. Chosen over
    // a behind-migrations database on purpose — part D would intercept that one, and this test
    // exists to prove the GENERIC reporter works for errors nothing anticipated.
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const dbPath = join(dir, "corrupt.db");
    writeFileSync(dbPath, "this is not a database, it is a sandwich");

    const result = spawnSync(TN_BIN, ["player", "show", "Anyone"], {
      env: { ...process.env, TN_DB_PATH: dbPath },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    // The whole defect, in one assertion.
    expect(result.stderr.trim()).not.toBe("");
    expect(result.stderr).toMatch(/^player show status=error message=".+" class=".+"$/m);
  });

  it("#160: a database behind its migrations says so, instead of naming a column", () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-"));
    const dbPath = join(dir, "behind.db");
    const { applied, available } = migrateToAllButLast(dbPath);

    const result = spawnSync(TN_BIN, ["player", "show", "Anyone"], {
      env: { ...process.env, TN_DB_PATH: dbPath },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    // What the operator gets to act on: both counts and the command. Before this, the same
    // situation produced `SqliteError: no such column: plays` at best, and silence in fact.
    expect(result.stderr).toContain(`is at ${applied} of ${available} migrations`);
    expect(result.stderr).toContain("run `tn db migrate`");
    // Exactly one diagnostic for one fault — telemetry must not add its own line about
    // request_log, which is not what is wrong.
    expect(result.stderr).not.toContain("telemetry: request_log write failed");
  });
});
