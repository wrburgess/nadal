import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { sanitizeSummaryValue } from "../src/cli/commands/db-migrate.js";

describe("tn db migrate (end-to-end via dispatch)", () => {
  const original = process.env.TN_DB_PATH;

  beforeEach(() => {
    process.env.TN_DB_PATH = join(mkdtempSync(join(tmpdir(), "tn-")), "cmd.db");
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TN_DB_PATH;
    else process.env.TN_DB_PATH = original;
  });

  it("applies migrations, prints one status=ok summary line, and exits 0", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["db", "migrate"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^db migrate status=ok path=.+cmd\.db$/),
    );
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
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^db migrate status=error message=".+"$/),
    );
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("sanitizeSummaryValue()", () => {
  it("strips control characters, including newlines, so a value stays single-line", () => {
    expect(sanitizeSummaryValue("a\nb\tc")).toBe("a b c");
  });

  it("leaves ordinary paths unchanged", () => {
    expect(sanitizeSummaryValue("/tmp/foo/bar.db")).toBe("/tmp/foo/bar.db");
  });
});
