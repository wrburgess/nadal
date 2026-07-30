import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapVocabulary, main } from "../tools/bootstrap-vocabulary.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bootstrap-vocab-"));
}

describe("bootstrapVocabulary", () => {
  it("separates name-shaped skeletons from safely auto-writable ones", () => {
    const dir = tempDir();
    const standInsPath = join(dir, "stand-ins.txt");
    writeFileSync(standInsPath, "Dana Sample\n");

    const fixturePath = join(dir, "fixture.html");
    writeFileSync(
      fixturePath,
      '<a href="/p.aspx?playername=Dana%20Sample&year=2026">x</a><p>Unreviewed Person</p>',
    );

    const report = bootstrapVocabulary([fixturePath], standInsPath);

    expect(report.autoWritten).toContain("p aspx playername year");
    expect(report.nameShaped).toContain("Unreviewed Person");
    expect(report.nameShaped).not.toContain("p aspx playername year");
  });

  it("reports zero skeletons for a fixture containing only stand-ins and structural values", () => {
    const dir = tempDir();
    const standInsPath = join(dir, "stand-ins.txt");
    writeFileSync(standInsPath, "Dana Sample\n");

    const fixturePath = join(dir, "fixture.html");
    writeFileSync(fixturePath, "<p>Dana Sample</p><p>42</p>");

    const report = bootstrapVocabulary([fixturePath], standInsPath);

    expect(report.total).toBe(0);
  });
});

describe("bootstrap-vocabulary main()", () => {
  it("writes only the non-name-shaped skeletons to --out, sorted, one per line", async () => {
    const dir = tempDir();
    const standInsPath = join(dir, "stand-ins.txt");
    writeFileSync(standInsPath, "Dana Sample\n");

    const fixturePath = join(dir, "fixture.html");
    writeFileSync(
      fixturePath,
      '<a href="/p.aspx?playername=Dana%20Sample&year=2026">x</a><p>Unreviewed Person</p>',
    );
    const outPath = join(dir, "out.txt");

    const report = await main([
      "--fixtures",
      fixturePath,
      "--stand-ins",
      standInsPath,
      "--out",
      outPath,
    ]);

    expect(existsSync(outPath)).toBe(true);
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("p aspx playername year");
    expect(written).not.toContain("Unreviewed Person");
    expect(report.nameShaped).toContain("Unreviewed Person");
  });
});
