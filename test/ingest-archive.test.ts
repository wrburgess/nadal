import * as fsModule from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArchivePathError,
  archivePage,
  assertArchivePathSafe,
  rawRoot,
} from "../src/ingest/archive.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

// `writeFileSync`/`openSync` are named ESM exports of a Node built-in, and Node's built-in module
// namespaces are not configurable — `vi.spyOn` cannot redefine a property on either directly. The
// supported way to inject a deterministic race is a partial `vi.mock` that CALLS THROUGH to the real
// implementation by default (`vi.fn(actual.fn)`), so every other test in this file — and every other
// call either function makes — is completely unaffected; only a test that explicitly arms a custom
// implementation observes different behavior, for exactly the duration it holds that override. Same
// technique `test/fs-output-root.test.ts` already established for its own "SECOND no-follow check…
// not dead code" regression (that file's line ~523).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    openSync: vi.fn(actual.openSync),
  };
});

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

// Task 4, #18: `archivePage`'s `body` widens to `string | Uint8Array` so a scorecard photo can
// archive through the identical writer as every HTML capture — every path check, the O_CREAT|O_EXCL
// open, and the post-open verification stay byte-identical; only WHAT is written changes.
describe("archivePage: binary body support", () => {
  useTnRawPath();

  it("a Uint8Array body with an explicit extension round-trips byte-identical off disk", () => {
    // A small synthetic buffer, not a photograph (test/fixtures/README.md: no scorecard photo is
    // ever committed) — the PNG magic bytes are enough to prove bytes survive unmodified.
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

    const path = archivePage({
      sourceSet: "scorecard",
      slug: "court-1",
      url: "/tmp/court-1.png",
      body,
      httpStatus: 200,
      extension: ".png",
    });

    expect(path.endsWith(".png")).toBe(true);
    expect(new Uint8Array(readFileSync(path))).toEqual(body);
  });

  it("its .provenance.json sibling is still written, with a byte count matching the binary body", () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);

    const path = archivePage({
      sourceSet: "scorecard",
      slug: "court-2",
      url: "/tmp/court-2.png",
      body,
      httpStatus: 200,
      extension: ".png",
    });

    const provenance = JSON.parse(readFileSync(`${path}.provenance.json`, "utf8")) as Record<string, unknown>;
    expect(provenance.bytes).toBe(5);
    expect(provenance.redacted).toBe(false);
  });

  it("extension defaults to .html when omitted, unaffected by the widened content type", () => {
    const path = archivePage({
      sourceSet: "tennisrecord",
      slug: "still-html",
      url: "https://example.test",
      body: "<html></html>",
      httpStatus: 200,
    });

    expect(path.endsWith(".html")).toBe(true);
  });

  it("a path refusal still writes NOTHING for the binary path either — not half the pair", () => {
    process.env.TN_RAW_PATH = resolve("src");
    const body = new Uint8Array([1, 2, 3]);

    expect(() =>
      archivePage({ sourceSet: "scorecard", slug: "x", url: "/tmp/x.png", body, httpStatus: 200, extension: ".png" }),
    ).toThrow(ArchivePathError);
    expect(existsSync(join(resolve("src"), "scorecard"))).toBe(false);
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

// Issue #33. `archivePage` resolves the real, validated destination and then hands that path STRING
// to a write call — check-then-use. A directory component swapped for a symlink AFTER resolution and
// BEFORE the write redirects the sensitive, un-redacted capture bytes outside `rawRoot`. Driven
// deterministically via the `node:fs` spy above (never a wall-clock sleep — `rules/testing.md`): the
// swap fires inside whichever low-level write call the implementation actually uses (`writeFileSync`
// today; `openSync` once the fd-anchored fix routes the write through `openNewOutputFileSafely`), so
// this single test stays meaningful — and keeps exercising the real mechanism — on both sides of the
// fix, rather than only reproducing the defect once and going quiet afterward.
describe("archivePage race window: a directory swapped for a symlink between resolution and the write", () => {
  useTnRawPath();

  it("REGRESSION: the capture body must never land outside rawRoot, even when the parent directory is replaced by a symlink after resolution", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "tn-race-outside-"));
    const { writeFileSync: realWriteFileSync, openSync: realOpenSync } =
      await vi.importActual<typeof import("node:fs")>("node:fs");

    let swapped = false;
    const maybeSwapDirectoryForSymlink = (targetPath: string) => {
      if (swapped) return;
      const dir = dirname(targetPath);
      if (!existsSync(dir)) return;
      swapped = true;
      // The race: this is the window between `resolveRealOutputPath` proving `dir` real and safe,
      // and the write that trusts the path string it returned. Nothing about the write call itself
      // re-checks the filesystem, so replacing `dir` with a symlink to somewhere outside `rawRoot`
      // right here — immediately before the write actually happens — reproduces the race with no
      // timing dependency at all.
      rmSync(dir, { recursive: true, force: true });
      symlinkSync(outsideDir, dir, "dir");
    };

    vi.mocked(fsModule.writeFileSync).mockImplementation(((target: string, ...rest: unknown[]) => {
      if (typeof target === "string") maybeSwapDirectoryForSymlink(target);
      return (realWriteFileSync as (...a: unknown[]) => void)(target, ...rest);
    }) as unknown as typeof fsModule.writeFileSync);
    vi.mocked(fsModule.openSync).mockImplementation(((target: string, ...rest: unknown[]) => {
      if (typeof target === "string") maybeSwapDirectoryForSymlink(target);
      return (realOpenSync as (...a: unknown[]) => number)(target, ...rest);
    }) as unknown as typeof fsModule.openSync);

    let thrown: unknown;
    try {
      archivePage({
        sourceSet: "tennisrecord",
        slug: "race",
        url: "https://example.test",
        body: "SENSITIVE CAPTURE BODY THAT MUST NEVER LEAK",
        httpStatus: 200,
      });
    } catch (err) {
      thrown = err;
    } finally {
      vi.mocked(fsModule.writeFileSync).mockImplementation(realWriteFileSync);
      vi.mocked(fsModule.openSync).mockImplementation(realOpenSync);
    }

    try {
      // The property under test: no matter what archivePage returns or throws, the sensitive body
      // must never have landed in outsideDir — that is exactly where the swapped symlink would have
      // redirected it.
      expect(readdirSync(outsideDir)).toEqual([]);
      expect(thrown).toBeInstanceOf(ArchivePathError);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

// Issue #65. `archivePage` writes TWO leaves that are meant to be a pair — the raw capture and its
// `.provenance.json` sibling — and both PATHS are pre-validated together. The two WRITES were not:
// a refusal on the second left the first sitting on disk, an un-redacted capture with no record of
// where it came from, when, or at what status. `archivePage`'s own doc comment asserted the
// opposite ("a refusal writes NOTHING — not even the leaf file, half the pair"), which held for a
// PRE-CHECK refusal and not for a WRITE-TIME one.
//
// The failure is injected at `openSync` — the OPEN path — while the fix changes the ROLLBACK path.
// The two are deliberately independent: the mechanism that turns this test red is not the mechanism
// the fix touches, so a green result here cannot come from the seed being neutralized by the change
// under test. That is the shape `docs/findings.md` records for #63 — "a corruption test that seeds
// THROUGH the ORM cannot reproduce ORM-level corruption, and passes either way" — applied to a
// filesystem seed instead of a database one. Verified by mutation, not by reading: removing the
// rollback loop turns this test red.
describe("archivePage pair integrity: a refusal on the SECOND leaf must not orphan the first", () => {
  useTnRawPath();

  it("REGRESSION: when the provenance write is refused, the already-written html leaf does not survive", async () => {
    const { openSync: realOpenSync } = await vi.importActual<typeof import("node:fs")>("node:fs");

    // Call through for every open EXCEPT the provenance leaf's, which fails the way an ordinary
    // ENOSPC/EACCES would — after the html leaf is already fully written and closed.
    vi.mocked(fsModule.openSync).mockImplementation(((target: string, ...rest: unknown[]) => {
      if (typeof target === "string" && target.endsWith(".provenance.json")) {
        throw new Error("simulated provenance open failure (disk full)");
      }
      return (realOpenSync as (...a: unknown[]) => number)(target, ...rest);
    }) as unknown as typeof fsModule.openSync);

    let thrown: unknown;
    try {
      archivePage({
        sourceSet: "tennisrecord",
        slug: "orphan",
        url: "https://example.test/team",
        body: "UN-REDACTED CAPTURE THAT MUST NOT BE LEFT UNATTRIBUTED",
        httpStatus: 200,
      });
    } catch (err) {
      thrown = err;
    } finally {
      // Restore CALL-THROUGH, not a bare `vi.fn()`: this is a persistent `mockImplementation`, so a
      // stub returning `undefined` would leak into every later test in this file that opens a file.
      vi.mocked(fsModule.openSync).mockImplementation(realOpenSync);
    }

    // The ORIGINAL error propagates — never a cleanup failure, and never swallowed into a success.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("simulated provenance open failure");

    // The property under test: neither half of the pair is left behind. Asserted on the directory
    // rather than on the leaf path (which `archivePage` never returned, having thrown), so a stray
    // file under ANY name — including a partial or a temp artifact — fails this.
    expect(readdirSync(join(resolve(rawRoot()), "tennisrecord"))).toEqual([]);
  });

  // Codex adversarial review, PR #83 final merge-gate pass, [medium]. `archivePage` runs
  // `mkdirSync(dir)` BEFORE the write set, and nothing undoes it — so a refusal leaves an empty
  // source-set directory that did not exist before. That is documented as this function's own
  // residue (the write set's residual contract is bounded by ownership and cannot cover it), and a
  // documented behavior nothing checks is exactly the prose claim this PR has spent four rounds
  // correcting. So it is pinned here: the assertion is that the directory REMAINS and is EMPTY —
  // if a future change starts cleaning it up, this test must be updated deliberately rather than
  // the comment silently going stale.
  it("leaves the source-set directory it created — empty — when the FIRST leaf is refused", async () => {
    const { openSync: realOpenSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const sourceSetDir = join(resolve(rawRoot()), "usta");

    // It genuinely does not exist yet: `archivePage` is what creates it, which is what makes it
    // residue rather than something that was already there.
    expect(existsSync(sourceSetDir)).toBe(false);

    vi.mocked(fsModule.openSync).mockImplementationOnce(() => {
      throw new Error("simulated first-leaf open failure");
    });

    try {
      expect(() =>
        archivePage({
          sourceSet: "usta",
          slug: "first-leaf-refused",
          url: "https://example.test/profile",
          body: "UN-REDACTED CAPTURE",
          httpStatus: 200,
        }),
      ).toThrow("simulated first-leaf open failure");
    } finally {
      vi.mocked(fsModule.openSync).mockImplementation(realOpenSync);
    }

    expect(existsSync(sourceSetDir)).toBe(true);
    expect(readdirSync(sourceSetDir)).toEqual([]);
  });
});
