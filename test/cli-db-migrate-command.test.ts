import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";

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
});
