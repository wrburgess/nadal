import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapVocabulary, main } from "../tools/bootstrap-vocabulary.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bootstrap-vocab-"));
}

describe("bootstrapVocabulary", () => {
  it("separates skeletons that require review from safely auto-writable ones", () => {
    const dir = tempDir();
    const standInsPath = join(dir, "stand-ins.txt");
    writeFileSync(standInsPath, "Dana Sample\n");

    const fixturePath = join(dir, "fixture.html");
    writeFileSync(
      fixturePath,
      '<a href="/p.aspx?playername=Dana%20Sample&year=2026">x</a>' +
        '<p>Unreviewed Person</p><div class="wrapper"></div>',
    );

    const report = bootstrapVocabulary([fixturePath], standInsPath);

    // "p aspx playername year" is a LOWERCASE multi-token skeleton — round-2 finding R2-3 means
    // `requiresReview` no longer cares about case, so this now requires review same as a
    // capitalised name would, rather than being safely auto-written.
    expect(report.nameShaped).toContain("p aspx playername year");
    expect(report.nameShaped).toContain("Unreviewed Person");
    // A single-token skeleton (the link text "x", the class value "wrapper") carries no
    // multi-word identity shape and is still safe to auto-write.
    expect(report.autoWritten).toContain("x");
    expect(report.autoWritten).toContain("wrapper");
    expect(report.autoWritten).not.toContain("p aspx playername year");
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
  it("writes only the skeletons that don't require review to --out, sorted, one per line", async () => {
    const dir = tempDir();
    const standInsPath = join(dir, "stand-ins.txt");
    writeFileSync(standInsPath, "Dana Sample\n");

    const fixturePath = join(dir, "fixture.html");
    writeFileSync(
      fixturePath,
      '<a href="/p.aspx?playername=Dana%20Sample&year=2026">x</a>' +
        '<p>Unreviewed Person</p><div class="wrapper"></div>',
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
    expect(written).toContain("wrapper");
    expect(written).not.toContain("p aspx playername year");
    expect(written).not.toContain("Unreviewed Person");
    expect(report.nameShaped).toContain("Unreviewed Person");
    expect(report.nameShaped).toContain("p aspx playername year");
  });
});
