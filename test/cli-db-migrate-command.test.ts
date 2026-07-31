import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import * as client from "../src/db/client.js";
import { buildLegacyMigrationsFolder } from "./helpers/legacy-migrations.js";
import { useTnDbPath } from "./helpers/tn-db.js";

// Unicode line-break characters that are NOT ASCII C0 controls: NEL, Line
// Separator, Paragraph Separator. Some terminals/log consumers render or
// index these as a new line, so they must be stripped too, not just \n/\r.
const NEL = String.fromCharCode(0x85);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * A naive-but-representative whitespace-delimited key/value parser: an unquoted
 * value is read up to the next space (so an unescaped space in it WOULD end the
 * value early, exactly the vulnerability an unquoted field has); a quoted value
 * is scanned to its true closing quote. Later occurrences of a key overwrite
 * earlier ones, mirroring how many simple log parsers behave — which is exactly
 * what lets an injected `status=error` inside an unquoted path spoof the real
 * `status=ok` field if that field isn't quoted.
 */
function parseSummaryFields(line: string): Record<string, string> {
  const rest = line.replace(/^\S+\s+\S+\s*/, ""); // drop the "db migrate " prefix
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (rest[i] === " ") i++;
    if (i >= rest.length) break;
    const eq = rest.indexOf("=", i);
    if (eq === -1) break; // no more key=value pairs — trailing content, not a field
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

describe("tn db migrate (end-to-end via dispatch)", () => {
  useTnDbPath("cmd.db");

  it("applies migrations, prints one status=ok summary line, and exits 0", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["db", "migrate"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^db migrate status=ok path=".+cmd\.db"$/),
    );
    logSpy.mockRestore();
  });

  it("keeps status= from being spoofed by a path containing whitespace and an embedded key=value pair", async () => {
    // Not a contrived attack scenario: any path with a space in it — e.g. a
    // home directory like "/Users/Randy Burgess/..." — already breaks a naive
    // unquoted path= field with today's shape. This case also embeds a literal
    // "status=error" to prove the quoted field can't be mistaken for a second,
    // overriding status field by a whitespace-delimited parser.
    const trickyDir = mkdtempSync(join(tmpdir(), "tn-"));
    const trickyPath = join(trickyDir, "weird status=error dir", "cmd.db");
    process.env.TN_DB_PATH = trickyPath;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["db", "migrate"]);
    expect(code).toBe(0);

    const printed = logSpy.mock.calls[0]?.[0] as string;
    const fields = parseSummaryFields(printed);
    expect(fields.status).toBe("ok"); // not overwritten by the embedded "status=error"
    expect(fields.path).toBe(trickyPath); // decodes back to the exact real path

    logSpy.mockRestore();
  });

  it("prints one status=error summary line and exits non-zero when migration fails", async () => {
    // Point TN_DB_PATH inside a path segment that is a regular file, not a directory,
    // so mkdirSync(dirname(path), { recursive: true }) throws ENOTDIR.
    const blockerFile = join(mkdtempSync(join(tmpdir(), "tn-")), "blocker");
    writeFileSync(blockerFile, "not a directory");
    process.env.TN_DB_PATH = join(blockerFile, "nested", "test.db");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["db", "migrate"]);
    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    // The command's own one-line status=error summary is call #1 — that "one deterministic
    // summary line" contract is unchanged. Telemetry's own openDb() (inside logRequest's
    // wrapper, attempting to persist this very request) hits the exact same broken path and
    // throws too; per item 5's contract that failure is now reported as a second, distinct
    // stderr diagnostic instead of vanishing into a bare `catch {}`.
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^db migrate status=error message=".+"$/),
    );
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("telemetry: request_log write failed"),
    );
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("strips Unicode line-break characters from a real error message end-to-end", async () => {
    // A cross-module spy on client.ts's runMigrations() — as seen by
    // db-migrate.ts, a different module — lets us force a controlled error
    // message, unlike a real fs failure whose message text we don't control.
    const runMigrationsSpy = vi.spyOn(client, "runMigrations").mockImplementation(() => {
      throw new Error(`line one${LINE_SEPARATOR}line two${PARAGRAPH_SEPARATOR}line three${NEL}end`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["db", "migrate"]);

    expect(code).toBe(1);
    // Call #1 is the command's own summary (asserted below for Unicode stripping). Because
    // runMigrations() is mocked to throw before any real migration runs, request_log never gets
    // created either — so telemetry's own insert attempt (inside logRequest's wrapper) also
    // fails, and per item 5's contract that surfaces as call #2 rather than being swallowed.
    expect(errorSpy).toHaveBeenCalledTimes(2);
    const printed = errorSpy.mock.calls[0]?.[0] as string;
    expect(printed).toMatch(/^db migrate status=error message=".+"$/);
    expect(printed).not.toContain(LINE_SEPARATOR);
    expect(printed).not.toContain(PARAGRAPH_SEPARATOR);
    expect(printed).not.toContain(NEL);
    expect(errorSpy.mock.calls[1]?.[0]).toEqual(
      expect.stringContaining("telemetry: request_log write failed"),
    );

    runMigrationsSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// #44 Task 5: the adjacent defect folded into this issue — `db migrate` never parsed its `args` at
// all, so `tn db migrate --jsno bogus-extra-arg` silently ran the real migration and reported
// status=ok. Fixed by giving `run` the same `parseArgs` + `emitSummary` treatment every other
// command already has, which is also what makes `--quiet`/`--json` real here (GRAMMAR.md already
// promised them for every command).
describe("tn db migrate rejects unrecognized flags and extra arguments (#44 folded defect)", () => {
  const fixture = useTnDbPath("arg-parsing.db");

  function tableNames(): string[] {
    const sqlite = new Database(fixture.path());
    const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    sqlite.close();
    return rows.map((r) => r.name);
  }

  it("an unrecognized flag exits 1, reports it on stderr, and applies no migrations", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["db", "migrate", "--jsno"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('db migrate status=error message="unrecognized flag --jsno"');
    expect(logSpy).not.toHaveBeenCalled();
    // The real bug: `runMigrations()` used to run regardless of `args`. Confirm no migration table
    // exists at all — not just that the exit code looks like failure. (The db FILE itself may
    // still exist: dispatch's telemetry wrapper opens it independently to log the request and its
    // own insert then fails on the missing `request_log` table — that failure is expected and
    // reported as a second stderr line; what must NOT have happened is any table getting created.)
    expect(tableNames()).toEqual([]);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("an unexpected extra argument exits 1 and applies no migrations (db migrate takes no positionals)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["db", "migrate", "extra-arg"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^db migrate status=error message=".+"$/));
    expect(errorSpy.mock.calls[0]?.[0]).toContain("extra-arg");
    expect(logSpy).not.toHaveBeenCalled();
    expect(tableNames()).toEqual([]);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("--quiet applies migrations but writes nothing to stdout — the global GRAMMAR.md promises, now true here too", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["db", "migrate", "--quiet"]);

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
    expect(tableNames()).toContain("players");

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // MERGE-BORN regression (#46 integrating #44/PR #51). #46 added a detailed, copy-pasteable
  // recovery to the migration-failure error; PR #51 concurrently moved `db migrate` from a raw
  // `console.error` onto `emitSummary`'s one-line `key=value` summary, whose `sanitizeValue`
  // replaces every control character — newlines included — with a space. Both were green alone.
  // Together, the multi-line recovery collapsed into one ~1200-character run of prose with the `mv`
  // command buried mid-paragraph: unusable by the human it was written for.
  //
  // This asserts the RENDERED CLI line, which is the surface that actually broke — the sibling
  // assertion in test/db-teams-url-unique-upgrade.test.ts covers the message itself. The defect
  // lives in the seam, so it is guarded from both sides.
  it("renders the #46 duplicate-URL recovery command INTACT through the one-line summary", async () => {
    const dbFile = join(mkdtempSync(join(tmpdir(), "tn-")), "legacy.db");
    // A database migrated up to 0008 that already holds the duplicate pair 0009 forbids.
    const legacyDir = buildLegacyMigrationsFolder(8);
    const seed = new Database(dbFile);
    try {
      migrate(drizzle(seed), { migrationsFolder: legacyDir });
      seed.exec(`INSERT INTO teams (name, tennisrecord_url) VALUES ('A', 'https://tr/t?a')`);
      seed.exec(`INSERT INTO teams (name, tennisrecord_url) VALUES ('A 4.0', 'https://tr/t?a')`);
    } finally {
      seed.close();
    }
    process.env.TN_DB_PATH = dbFile;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await dispatch(["db", "migrate"]);
    expect(code).toBe(1);

    const printed = errorSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("db migrate"));
    expect(printed, "no db migrate summary line was emitted").toBeDefined();
    const fields = parseSummaryFields(printed as string);
    expect(fields.status).toBe("error");
    // The whole recovery command survives as one contiguous, copy-pasteable run — this is what a
    // collapsed multi-line message destroys.
    expect(fields.message).toContain(`mv -i -- '${dbFile}' '${dbFile}.pre-0009.bak' && tn db migrate`);
    expect(fields.message).toContain("docs/runbooks/db-migration-recovery.md");

    errorSpy.mockRestore();
  });

  it("--json prints a parseable status=ok payload and applies migrations", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["db", "migrate", "--json"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed) as { status: string; path: string };
    expect(parsed.status).toBe("ok");
    expect(parsed.path).toBe(fixture.path());
    expect(tableNames()).toContain("players");

    logSpy.mockRestore();
  });
});
