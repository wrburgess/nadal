import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  // REGRESSION. Constraining only the LEAF ("is the file under rawRoot?") is satisfied trivially
  // by a misconfigured root: `TN_RAW_PATH=src` makes every write "inside rawRoot" and therefore
  // allowed, while putting un-redacted captures of real people's pages into a TRACKED directory of
  // a PUBLIC repo. The guard has to constrain the ROOT too.
  it("REGRESSION: refuses an archive ROOT inside the repo tree, even though the leaf is under it", () => {
    process.env.TN_RAW_PATH = resolve("src");
    const leafInsideThatRoot = join(resolve("src"), "tennisrecord", "x.html");
    expect(() => assertArchivePathSafe(leafInsideThatRoot)).toThrow(ArchivePathError);
    expect(() =>
      archivePage({ sourceSet: "tennisrecord", slug: "x", url: "https://example.test", body: "bad", httpStatus: 200 }),
    ).toThrow(ArchivePathError);
    expect(existsSync(join(resolve("src"), "tennisrecord"))).toBe(false);
  });

  it("still allows the repo's own gitignored raw/ as the root", () => {
    process.env.TN_RAW_PATH = resolve("raw");
    expect(() => assertArchivePathSafe(join(resolve("raw"), "tennisrecord", "x.html"))).not.toThrow();
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

// Codex adversarial review, PR #31 [critical]: a LEXICAL path check answers "what does this string
// say", not "where do the bytes land". Every assertion below passes the string comparisons and must
// still be refused, because the filesystem disagrees with the path.
describe("archive guard vs the filesystem (symlinks)", () => {
  useTnRawPath();

  it("REGRESSION: refuses a raw root that is a symlink INTO the repo tree", () => {
    const link = join(mkdtempSync(join(tmpdir(), "tn-link-")), "raw-link");
    symlinkSync(resolve("src"), link, "dir");
    process.env.TN_RAW_PATH = link;

    // Lexically this root is outside the repo and every leaf is "inside rawRoot" — it must still fail.
    expect(() => assertArchivePathSafe(join(link, "tennisrecord", "x.html"))).toThrow(ArchivePathError);
    expect(() =>
      archivePage({ sourceSet: "tennisrecord", slug: "x", url: "https://example.test", body: "leak", httpStatus: 200 }),
    ).toThrow(ArchivePathError);
    expect(existsSync(join(resolve("src"), "tennisrecord"))).toBe(false);
  });

  it("REGRESSION: refuses a symlinked component INSIDE the raw root", () => {
    const root = rawRoot();
    mkdirSync(root, { recursive: true });
    symlinkSync(resolve("src"), join(root, "tennisrecord"), "dir");

    expect(() =>
      archivePage({ sourceSet: "tennisrecord", slug: "x", url: "https://example.test", body: "leak", httpStatus: 200 }),
    ).toThrow(ArchivePathError);
    expect(existsSync(join(resolve("src"), "x.html"))).toBe(false);
  });

  it("still allows a raw root that is a symlink to a directory OUTSIDE the repo", () => {
    const target = mkdtempSync(join(tmpdir(), "tn-real-"));
    const link = join(mkdtempSync(join(tmpdir(), "tn-link-")), "raw-link");
    symlinkSync(target, link, "dir");
    process.env.TN_RAW_PATH = link;

    const written = archivePage({ sourceSet: "tennisrecord", slug: "x", url: "https://example.test", body: "ok", httpStatus: 200 });
    expect(existsSync(written)).toBe(true);
  });
});

// Codex adversarial review, PR #31 round 3 [high, and Critical by PROJECT.md's framework — it ships
// broken]: EVERY test above sets TN_RAW_PATH to a temp dir, so not one of them exercised the
// configuration the docs actually describe. The realpath hardening applied the root-only allowlist to
// a DESCENDANT directory, and every pull threw before writing a byte.
describe("archivePage under the DOCUMENTED DEFAULT (TN_RAW_PATH unset)", () => {
  const original = process.env.TN_RAW_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.TN_RAW_PATH;
    else process.env.TN_RAW_PATH = original;
    rmSync(resolve("raw"), { recursive: true, force: true });
  });

  it("REGRESSION: writes to <repo>/raw/<sourceSet>/ instead of throwing", () => {
    delete process.env.TN_RAW_PATH;

    const htmlPath = archivePage({
      sourceSet: "tennisrecord",
      slug: "default-root",
      url: "https://www.tennisrecord.com/adult/teamprofile.aspx?teamname=X",
      body: "<html>default</html>",
      httpStatus: 200,
    });

    // Resolved before comparing: with TN_RAW_PATH unset the returned path is repo-relative, which is
    // the pre-existing contract (rawRoot() defaults to the bare string "raw").
    expect(resolve(htmlPath).startsWith(join(resolve("raw"), "tennisrecord"))).toBe(true);
    expect(readFileSync(htmlPath, "utf8")).toBe("<html>default</html>");
    expect(existsSync(`${htmlPath}.provenance.json`)).toBe(true);
  });
});
