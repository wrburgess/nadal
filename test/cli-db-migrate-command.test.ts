import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import * as client from "../src/db/client.js";
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
