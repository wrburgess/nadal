import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const TN_BIN = join(REPO_ROOT, "bin", "tn");

describe("tn db migrate (invoked from a different working directory)", () => {
  it("still finds the repo's migrations folder regardless of the caller's cwd", () => {
    const otherCwd = mkdtempSync(join(tmpdir(), "tn-othercwd-"));
    const dbPath = join(mkdtempSync(join(tmpdir(), "tn-")), "cwd.db");

    const output = execFileSync(TN_BIN, ["db", "migrate"], {
      cwd: otherCwd,
      env: { ...process.env, TN_DB_PATH: dbPath },
      encoding: "utf8",
    });

    expect(output.trim()).toBe(`db migrate status=ok path="${dbPath}"`);
  });
});
