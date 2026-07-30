import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArchivePathError,
  archivePage,
  assertArchivePathSafe,
  rawRoot,
} from "../src/ingest/archive.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

describe("rawRoot", () => {
  it("defaults to 'raw' when TN_RAW_PATH is unset", () => {
    const original = process.env.TN_RAW_PATH;
    delete process.env.TN_RAW_PATH;
    expect(rawRoot()).toBe("raw");
    if (original === undefined) delete process.env.TN_RAW_PATH;
    else process.env.TN_RAW_PATH = original;
  });

  it("reads TN_RAW_PATH when set", () => {
    const original = process.env.TN_RAW_PATH;
    process.env.TN_RAW_PATH = "/tmp/somewhere";
    expect(rawRoot()).toBe("/tmp/somewhere");
    if (original === undefined) delete process.env.TN_RAW_PATH;
    else process.env.TN_RAW_PATH = original;
  });
});

describe("archivePage", () => {
  useTnRawPath();

  it("writes the page and a sibling provenance file under TN_RAW_PATH", () => {
    const htmlPath = archivePage({
      sourceSet: "tennisrecord",
      slug: "team-norbury",
      url: "https://www.tennisrecord.com/adult/teamprofile.aspx?teamname=Norbury&year=2026",
      body: "<html>hello</html>",
      httpStatus: 200,
    });

    expect(htmlPath.startsWith(resolve(rawRoot()))).toBe(true);
    expect(existsSync(htmlPath)).toBe(true);
    expect(readFileSync(htmlPath, "utf8")).toBe("<html>hello</html>");

    const provenancePath = `${htmlPath}.provenance.json`;
    expect(existsSync(provenancePath)).toBe(true);
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as Record<string, unknown>;

    expect(provenance).toEqual({
      sourceUrl: "https://www.tennisrecord.com/adult/teamprofile.aspx?teamname=Norbury&year=2026",
      fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
      httpStatus: 200,
      redacted: false,
      bytes: Buffer.byteLength("<html>hello</html>", "utf8"),
    });
  });

  it("writes under <rawRoot>/<sourceSet>/", () => {
    const htmlPath = archivePage({
      sourceSet: "usta",
      slug: "profile-123",
      url: "https://example.test/profile.html#uaid=123",
      body: "<html></html>",
      httpStatus: 200,
    });

    expect(htmlPath.startsWith(join(resolve(rawRoot()), "usta") + "/")).toBe(true);
  });

  it("produces two distinct timestamped files for two archives of the same url in one run (no clobber)", () => {
    const first = archivePage({
      sourceSet: "tennisrecord",
      slug: "same-slug",
      url: "https://www.tennisrecord.com/adult/matchhistory.aspx?playername=A",
      body: "one",
      httpStatus: 200,
    });
    const second = archivePage({
      sourceSet: "tennisrecord",
      slug: "same-slug",
      url: "https://www.tennisrecord.com/adult/matchhistory.aspx?playername=A",
      body: "two",
      httpStatus: 200,
    });

    expect(first).not.toBe(second);
    expect(readFileSync(first, "utf8")).toBe("one");
    expect(readFileSync(second, "utf8")).toBe("two");

    const files = readdirSync(join(resolve(rawRoot()), "tennisrecord"));
    expect(files.filter((f) => f.startsWith("same-slug-") && f.endsWith(".html"))).toHaveLength(2);
  });
});

describe("assertArchivePathSafe", () => {
  useTnRawPath();

  it("allows a path resolving inside rawRoot", () => {
    const inside = join(rawRoot(), "tennisrecord", "x.html");
    expect(() => assertArchivePathSafe(inside)).not.toThrow();
  });

  it("refuses a path resolving inside the repo working tree outside rawRoot", () => {
    const insideRepo = resolve("src", "somewhere.html");
    expect(() => assertArchivePathSafe(insideRepo)).toThrow(ArchivePathError);
  });

  it("refuses a `..` traversal out of rawRoot", () => {
    const escaped = join(rawRoot(), "..", "escaped.html");
    expect(() => assertArchivePathSafe(escaped)).toThrow(ArchivePathError);
  });

  it("archivePage refuses a traversal in sourceSet and writes nothing", () => {
    expect(() =>
      archivePage({
        sourceSet: "../../escape",
        slug: "x",
        url: "https://example.test",
        body: "bad",
        httpStatus: 200,
      }),
    ).toThrow(ArchivePathError);

    expect(existsSync(resolve("escape"))).toBe(false);
  });

  it("archivePage refuses a traversal in slug and writes nothing", () => {
    const before = existsSync(join(resolve(rawRoot()), "tennisrecord"))
      ? readdirSync(join(resolve(rawRoot()), "tennisrecord"))
      : [];

    expect(() =>
      archivePage({
        sourceSet: "tennisrecord",
        slug: "../../../escape",
        url: "https://example.test",
        body: "bad",
        httpStatus: 200,
      }),
    ).toThrow(ArchivePathError);

    const after = existsSync(join(resolve(rawRoot()), "tennisrecord"))
      ? readdirSync(join(resolve(rawRoot()), "tennisrecord"))
      : [];
    expect(after).toEqual(before);
    expect(existsSync(resolve("escape.html"))).toBe(false);
  });
});
