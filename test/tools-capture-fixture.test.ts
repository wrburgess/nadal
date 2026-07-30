import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../tools/capture-fixture.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "capture-fixture-"));
}

function writeMap(dir: string, substitutions: { from: string; to: string }[]): string {
  const path = join(dir, "map.json");
  writeFileSync(path, JSON.stringify({ substitutions }));
  return path;
}

function writeVocabulary(dir: string, skeletons: string[]): string {
  const path = join(dir, "vocabulary.txt");
  writeFileSync(path, skeletons.join("\n"));
  return path;
}

describe("capture-fixture main() — allow-list policy wiring", () => {
  it("writes NEITHER the fixture NOR the provenance sidecar when the page carries an unclassified atom", async () => {
    const dir = tempDir();
    const mapPath = writeMap(dir, [{ from: "Cory Hogan", to: "Dana Sample" }]);
    // Empty vocabulary: "Dana Sample" elides to nothing (a stand-in), but "Unrelated Person" is a
    // real-shaped run nobody listed and nobody vocabulary-approved — the capture must refuse.
    const vocabularyPath = writeVocabulary(dir, []);
    const filePath = join(dir, "source.html");
    writeFileSync(filePath, "<p>Cory Hogan</p><p>Unrelated Person</p>");
    const outPath = join(dir, "out.html");

    await expect(
      main([
        "--file",
        filePath,
        "--source-url",
        "https://example.com/page",
        "--map",
        mapPath,
        "--vocabulary",
        vocabularyPath,
        "--detectors",
        "none",
        "--out",
        outPath,
      ]),
    ).rejects.toThrow();

    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(`${outPath}.provenance.json`)).toBe(false);
  });

  it("refuses the capture when the provenance sourceUrl carries an unclassified identity", async () => {
    const dir = tempDir();
    const mapPath = writeMap(dir, [{ from: "Cory Hogan", to: "Dana Sample" }]);
    const vocabularyPath = writeVocabulary(dir, []);
    const filePath = join(dir, "source.html");
    // The page itself is clean: its only identity is listed, and the stand-in elides to an empty
    // skeleton.
    writeFileSync(filePath, "<p>Cory Hogan</p>");
    const outPath = join(dir, "out.html");
    // The URL carries a SECOND identity nobody remembered to list — a real name in a query
    // parameter, exactly the second-publication-surface exposure the module docstring describes.
    const sourceUrl = "https://example.com/profile.aspx?playername=Cory%20Hogan&other=RealName";

    await expect(
      main([
        "--file",
        filePath,
        "--source-url",
        sourceUrl,
        "--map",
        mapPath,
        "--vocabulary",
        vocabularyPath,
        "--detectors",
        "none",
        "--out",
        outPath,
      ]),
    ).rejects.toThrow();

    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(`${outPath}.provenance.json`)).toBe(false);
  });

  it("writes both the fixture and the provenance sidecar when everything is allow-listed", async () => {
    const dir = tempDir();
    const mapPath = writeMap(dir, [{ from: "Cory Hogan", to: "Dana Sample" }]);
    // The page's only atom is the stand-in itself (elides to an empty skeleton), but the
    // sourceUrl's surrounding path/query text is real, non-synthetic content that has to be
    // vocabulary-listed for the capture to proceed.
    const vocabularyPath = writeVocabulary(dir, ["https example com profile aspx playername"]);
    const filePath = join(dir, "source.html");
    writeFileSync(filePath, "<p>Cory Hogan</p>");
    const outPath = join(dir, "out.html");

    await main([
      "--file",
      filePath,
      "--source-url",
      "https://example.com/profile.aspx?playername=Cory%20Hogan",
      "--map",
      mapPath,
      "--vocabulary",
      vocabularyPath,
      "--detectors",
      "none",
      "--out",
      outPath,
    ]);

    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(`${outPath}.provenance.json`)).toBe(true);
  });
});
