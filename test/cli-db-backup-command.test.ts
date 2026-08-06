import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { runMigrations } from "../src/db/client.js";
import { useTnDbPath } from "./helpers/tn-db.js";

/**
 * The identical whitespace-delimited key/value parser `test/cli-db-migrate-command.test.ts` defines
 * for itself — not shared, matching that file's own convention of not extracting a cross-file test
 * helper for it. An unquoted value is read up to the next space (so an unescaped space in it WOULD
 * end the value early, exactly the vulnerability an unquoted field has); a quoted value is scanned
 * to its true closing quote.
 */
function parseSummaryFields(line: string): Record<string, string> {
  const rest = line.replace(/^\S+\s+\S+\s*/, ""); // drop the "db backup " prefix
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (rest[i] === " ") i++;
    if (i >= rest.length) break;
    const eq = rest.indexOf("=", i);
    if (eq === -1) break;
    const key = rest.slice(i, eq);
    i = eq + 1;
    let value: string;
    if (rest[i] === '"') {
      i++;
      const start = i;
      while (i < rest.length) {
        if (rest[i] === "\\") {
          i += 2;
          continue;
        }
        if (rest[i] === '"') break;
        i++;
      }
      value = rest.slice(start, i).replace(/\\(.)/g, "$1");
      i++;
    } else {
      const start = i;
      while (i < rest.length && rest[i] !== " ") i++;
      value = rest.slice(start, i);
    }
    fields[key] = value;
  }
  return fields;
}

// Issue #110, Testing Strategy table, `test/cli-db-backup-command.test.ts` rows (10-16).
describe("tn db backup (end-to-end via dispatch)", () => {
  const fixture = useTnDbPath("cmd.db");

  it("10: exits 0, prints one status=ok summary line, and the named destination exists on disk", async () => {
    runMigrations(fixture.path());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["db", "backup"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toMatch(/^db backup status=ok source=".+" destination=".+" tables=\d+ rows=\d+$/);
    const fields = parseSummaryFields(printed);
    expect(existsSync(fields.destination as string)).toBe(true);

    logSpy.mockRestore();
  });

  it("11: --json prints a parseable status=ok payload naming the real destination", async () => {
    runMigrations(fixture.path());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["db", "backup", "--json"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed) as {
      status: string;
      source: string;
      destination: string;
      tables: number;
      rows: number;
    };
    expect(parsed.status).toBe("ok");
    expect(parsed.source).toBe(fixture.path());
    expect(existsSync(parsed.destination)).toBe(true);

    logSpy.mockRestore();
  });

  it("12: --quiet suppresses stdout, exits 0, and still writes the backup file (quiet suppresses output, not work)", async () => {
    runMigrations(fixture.path());
    const backupsDir = join(dirname(fixture.path()), "backups");
    expect(existsSync(backupsDir)).toBe(false);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["db", "backup", "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
    expect(existsSync(backupsDir)).toBe(true);
    // Filtered to `.db` entries, not a bare directory-length check: `.backup()` itself (not this
    // command's own verification readback) leaves empty `-wal`/`-shm` sidecars next to a WAL-mode
    // destination — confirmed empirically, not assumed — so the directory legitimately holds three
    // entries for one backup. Counting only the `.db` file is what "still writes the backup file"
    // actually asserts.
    expect(readdirSync(backupsDir).filter((name) => name.endsWith(".db"))).toHaveLength(1);

    logSpy.mockRestore();
  });

  it("13: an unrecognized flag exits 1, reports status=error, and creates no backup file (the db migrate #44 defect class)", async () => {
    runMigrations(fixture.path());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["db", "backup", "--jsno"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('db backup status=error message="unrecognized flag --jsno"');
    expect(logSpy).not.toHaveBeenCalled();
    expect(existsSync(join(dirname(fixture.path()), "backups"))).toBe(false);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("14: a stray positional exits 1, names the argument, and creates no backup file (db backup takes no positionals)", async () => {
    runMigrations(fixture.path());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["db", "backup", "extra-arg"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^db backup status=error message=".+"$/));
    expect(errorSpy.mock.calls[0]?.[0]).toContain("extra-arg");
    expect(logSpy).not.toHaveBeenCalled();
    expect(existsSync(join(dirname(fixture.path()), "backups"))).toBe(false);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("15: a missing source exits 1, reports status=error, and creates no database at the resolved path", async () => {
    // Blocking the PARENT with a regular file makes BOTH `backupDatabase`'s own open attempt AND
    // telemetry's own `openDb()` call (which runs unconditionally after every dispatched command,
    // success or failure — src/telemetry/request-log.ts) fail for the same ENOTDIR reason.
    //
    // That blocking was originally a WORKAROUND: without it, telemetry's `openDb()` silently
    // CREATED an empty database at this exact path once dispatch finished, which is the defect
    // `docs/findings.md` recorded as `bug · open · (#110, verify — belongs to #111, not folded)`.
    // Issue #111 fixed it (`openDb` no longer creates by default), so the workaround is no longer
    // load-bearing — test 17 below now exercises the plain, unblocked case this one could not.
    // Kept as-is because ENOTDIR is still a distinct state worth pinning, not because it is needed
    // to make the assertion below reachable.
    const blockerFile = join(mkdtempSync(join(tmpdir(), "tn-")), "blocker");
    writeFileSync(blockerFile, "not a directory");
    const missingPath = join(blockerFile, "nested", "cmd.db");
    process.env.TN_DB_PATH = missingPath;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["db", "backup"]);

    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    const printed = errorSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("db backup"));
    expect(printed, "no db backup summary line was emitted").toBeDefined();
    expect(printed).toMatch(/^db backup status=error message=".+"$/);
    expect(existsSync(missingPath)).toBe(false);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("16: a source path with a space and an embedded status=error decodes intact through the quoted field", async () => {
    const trickyDir = mkdtempSync(join(tmpdir(), "tn-"));
    const trickyPath = join(trickyDir, "weird status=error dir", "cmd.db");
    process.env.TN_DB_PATH = trickyPath;
    runMigrations(trickyPath);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["db", "backup"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    const fields = parseSummaryFields(printed);
    expect(fields.status).toBe("ok"); // not overwritten by the embedded "status=error"
    expect(fields.source).toBe(trickyPath); // decodes back to the exact real path

    logSpy.mockRestore();
  });

  // Closes the `bug · open · (#110, verify — belongs to #111, not folded)` entry in
  // `docs/findings.md`, which recorded exactly this end-to-end observation:
  //
  //   `TN_DB_PATH=…/absent.db tn db backup` prints `status=error … nothing to back up`, exits 1 —
  //   and `absent.db` exists afterward.
  //
  // The service layer never created it (`test/db-backup.test.ts` scenario 3 already asserted that);
  // `dispatch`'s telemetry wrapper did, after the command had already refused. Test 15 above could
  // only assert "nothing was created" by blocking the parent so telemetry failed too — this is the
  // plain case it had to avoid, with an ordinary existing parent directory and nothing standing in
  // telemetry's way but the fix itself.
  it("17: a missing source with an EXISTING parent leaves no database behind, and telemetry stays silent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-absent-source-"));
    const missingPath = join(dir, "absent.db");
    process.env.TN_DB_PATH = missingPath;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await dispatch(["db", "backup"]);

      expect(code).toBe(1);
      expect(logSpy).not.toHaveBeenCalled();
      const lines = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.find((l) => l.startsWith("db backup"))).toMatch(/^db backup status=error message=".+"$/);

      // The finding, directly: the refusal must not manufacture the artifact it refused over.
      expect(existsSync(missingPath)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);

      // And telemetry must not add a second, less useful diagnostic ahead of the command's own —
      // there is nothing to log to yet, which is a benign state rather than a failure.
      expect(lines.filter((l) => l.startsWith("telemetry:"))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
