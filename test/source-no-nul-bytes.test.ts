import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Built, never typed. `git ls-files -z` and `git ls-files -s -z` are NUL-delimited, so this file
// needs the character itself — and `String.fromCharCode` produces it without any escape having to
// survive the trip to disk. A literal 0x00 here would make THIS file binary, i.e. the rule's own
// first violation; a `\u0000` escape would be correct but is exactly the text that keeps
// arriving as the byte (see the block below).
const NUL_CHAR = String.fromCharCode(0);

// The SIX CHARACTERS backslash-u-0-0-0-0, not the byte — display text for the failure message,
// telling an author what to write instead. Spelled `"\\u0000"` in the source for that reason.
const NUL_ESCAPE = "\\u0000";

// Generous, and deliberately not tuned: exceeding it throws rather than truncating, so the failure
// direction is loud. The whole tracked tree is a few MB today.
const MAX_BUFFER = 256 * 1024 * 1024;

// Every NUL in this file's test data is built from a BYTE ARRAY (`Buffer.from([0x00])`) or
// `String.fromCharCode`, never from a string escape. An escape sequence has to survive every tool
// boundary between the author and the disk intact — and that escape, spelled out inside a JSON
// payload, IS a NUL. So text *describing* the escape arrives as the byte it was warning about. It
// did so on all seven tool calls that carried it during this PR. A byte array has no escape to
// mangle, which is why the data below is written as one.

/**
 * Issue #66. A single 0x00 byte anywhere in a file makes common content-search tools classify it as
 * binary and omit its matches — with no diagnostic. A missing file in a grep result is
 * indistinguishable from a file that legitimately does not match, so the failure mode is an
 * INCOMPLETE AUDIT THAT READS AS A COMPLETE ONE. Measured on `src/ingest/upsert.ts` before the fix:
 *
 *   file src/ingest/upsert.ts        -> data
 *   grep -c NULL_KEY <file>          -> no output, exit 1
 *   grep -rn NULL_KEY src/           -> silent miss
 *   rg -n NULL_KEY src/              -> silent miss   (ripgrep backs the agent `Grep` tool)
 *   git grep -n NULL_KEY -- src/     -> 3 hits        (see below — this disagreement is the hazard)
 *   grep -ac NULL_KEY <file>         -> 3
 *
 * `git grep` FINDING it is not reassurance. git sniffs only the first 8000 bytes for its binary
 * heuristic and that file's NUL sat at offset 15316, so the two tools disagree — and cross-checking
 * one search against another can return a clean-looking agreement that is not one. That is why the
 * beyond-the-sniff-window case below is pinned explicitly, and why no message here claims that
 * *every* tool misses the file.
 *
 * The invariant asserted is the one grep's binary test actually keys on: THE FILE CONTAINS NO 0x00
 * BYTE. Deliberately not "`file` reports text" or "`rg` finds a known string" — those bind this
 * guard to a platform's heuristics and go false-clear when the platform changes.
 *
 * TWO SNAPSHOTS, AND THAT IS THE POINT (Codex adversarial review of PR #89, rated A/Medium). The
 * first version of this guard listed paths from the INDEX (`git ls-files`) and read bytes from the
 * WORKING TREE. Those are different snapshots, so staging a NUL and then reverting the working-tree
 * copy left the guard green while the staged blob — the thing `git commit` writes — still carried
 * the byte. Reproduced before fixing: the suite passed 10/10 with a NUL at offset 10 of the staged
 * `docs/findings.md`. Deriving the file list from git while reading bytes from somewhere else is a
 * snapshot-consistency defect, and it is exactly the "certified an invariant it could not see" shape
 * this file exists to prevent, one level up.
 *
 * So both are scanned, and each offender says which snapshot it came from:
 *   - INDEX (authoritative): every tracked entry's staged blob, read via `git cat-file --batch`, so
 *     the list and the bytes come from one snapshot. Covers every tracked path, no skips.
 *   - WORKING TREE (companion): what a `grep` you run right now would actually read. A tracked path
 *     absent from disk is skipped here — a legitimate transient state — which is safe ONLY because
 *     the index pass covers that path unconditionally.
 *
 * DELIBERATELY NO ALLOWLIST. Zero tracked files are binary today, so an empty `ALLOWED_BINARY` array
 * would be a branch no test can kill (`rules/testing.md` -> Anti-Patterns, last row). The day a
 * legitimately-binary fixture is tracked, this fails loudly and its message tells that author what
 * to do — visible and deliberate, rather than a dead extension point that reads as coverage.
 */
type Snapshot = "index" | "working tree";
type NulOffender = { path: string; offset: number; snapshot: Snapshot };

/**
 * Pure over its input, so the synthetic cases below can prove this guard is capable of failing —
 * the shape `test/cli-grammar-parity.test.ts` uses, and for the same reason. A scan that only ever
 * ran against the real tree could not distinguish "nothing is wrong" from "nothing was read".
 */
function findNulBytes(
  files: { path: string; bytes: Buffer }[],
  snapshot: Snapshot,
): NulOffender[] {
  const offenders: NulOffender[] = [];
  for (const file of files) {
    const offset = file.bytes.indexOf(0x00);
    // `!== -1`, never a truthiness test: a NUL at offset 0 reports offset `0`, which is falsy, so
    // `if (offset)` would call a file whose FIRST byte is NUL clean. Pinned by a case below.
    if (offset !== -1) offenders.push({ path: file.path, offset, snapshot });
  }
  return offenders;
}

function describeOffenders(offenders: NulOffender[]): string {
  return offenders
    .map(
      (o) =>
        `${o.path} contains a raw 0x00 byte at offset ${o.offset} (${o.snapshot}). ` +
        `grep and ripgrep classify the file as binary and omit its matches by default, so a ` +
        `content search over it comes back empty and reads exactly like a clean result. ` +
        `(git grep may still find it — its binary sniff reads only the first 8000 bytes — and that ` +
        `disagreement between tools is its own hazard, not a reassurance.) ` +
        `Write the byte as the escape ${NUL_ESCAPE} instead, and re-read the file's bytes ` +
        `afterwards rather than trusting what you typed (see issue #66).`,
    )
    .join("\n");
}

type IndexEntry = { oid: string; path: string };

/**
 * PURE. `git ls-files -s -z` emits `<mode> <oid> <stage>\t<path>` per NUL-terminated record.
 * A record this cannot parse throws rather than being skipped: a silently dropped entry is one
 * tracked file that goes unscanned while the run stays green.
 */
function parseIndexEntries(out: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const record of out.split(NUL_CHAR)) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) {
      throw new Error(`git ls-files -s: record has no tab separator: ${JSON.stringify(record)}`);
    }
    const meta = record.slice(0, tab).split(" ");
    if (meta.length !== 3) {
      throw new Error(`git ls-files -s: unexpected metadata: ${JSON.stringify(record.slice(0, tab))}`);
    }
    // A gitlink (mode 160000) names a commit in another repository, which `cat-file` cannot resolve
    // here and which has no blob content to scan. None exist in this repo today; filtering rather
    // than throwing keeps the guard usable if one is ever added.
    if (meta[0] === "160000") continue;
    entries.push({ oid: meta[1]!, path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * PURE. `git cat-file --batch` emits `<oid> <type> <size>\n<contents>\n` per requested object, in
 * request order. LENGTH-PREFIXED, which is the whole reason this parses exactly: blob contents here
 * are expected to contain newlines — and, when the guard is doing its job, NUL bytes — so any
 * delimiter-splitting parser would mis-frame the very files it exists to catch.
 */
function parseCatFileBatch(buf: Buffer): { oid: string; type: string; bytes: Buffer }[] {
  const objects: { oid: string; type: string; bytes: Buffer }[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) throw new Error("git cat-file --batch: truncated header");
    const header = buf.subarray(pos, nl).toString("utf8");
    const parts = header.split(" ");
    // A `<oid> missing` reply has two fields and lands here — an unresolvable object must fail the
    // run, never be read as an empty (and therefore NUL-free) file.
    if (parts.length !== 3) {
      throw new Error(`git cat-file --batch: unexpected header ${JSON.stringify(header)}`);
    }
    const size = Number(parts[2]);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`git cat-file --batch: unusable size in ${JSON.stringify(header)}`);
    }
    const start = nl + 1;
    // The body must be present AND its trailing LF with it. Codex fix-verification pass on PR #89
    // [A/Low]: the bound used to be `start + size > buf.length`, which accepts a response whose
    // final byte is the last content byte — `"abc blob 1\nX"` framed cleanly and returned one
    // object, though git had not finished writing it. An off-by-one at the END of a stream is the
    // easy one to miss, because every complete response also satisfies the loose check. Verifying
    // the delimiter is what makes this framing rather than arithmetic: the length says where the
    // body ends, the LF confirms git agrees.
    if (start + size >= buf.length || buf[start + size] !== 0x0a) {
      throw new Error(`git cat-file --batch: truncated body for ${parts[0]}`);
    }
    objects.push({ oid: parts[0]!, type: parts[1]!, bytes: buf.subarray(start, start + size) });
    pos = start + size + 1; // +1 for the LF git appends after the contents
  }
  return objects;
}

/** Every tracked entry's STAGED blob — list and bytes from the same snapshot, no path skipped. */
function indexBlobs(): { path: string; bytes: Buffer }[] {
  const entries = parseIndexEntries(
    execFileSync("git", ["ls-files", "-s", "-z"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    }),
  );
  if (entries.length === 0) return [];

  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: REPO_ROOT,
    input: `${entries.map((e) => e.oid).join("\n")}\n`,
    maxBuffer: MAX_BUFFER,
  });
  const objects = parseCatFileBatch(batch);

  // NOT tautological, unlike a length comparison across a `.map`: these two counts come from
  // different processes parsed by different code, so a dropped or mis-framed object fails here
  // instead of silently shrinking the scanned set.
  if (objects.length !== entries.length) {
    throw new Error(
      `git cat-file --batch returned ${objects.length} objects for ${entries.length} index entries`,
    );
  }

  return entries.map((entry, i) => {
    const object = objects[i]!;
    if (object.type !== "blob") {
      throw new Error(`index entry ${entry.path} resolved to a ${object.type}, not a blob`);
    }
    return { path: entry.path, bytes: object.bytes };
  });
}

/**
 * PURE. Splits raw `-z` output on the NUL byte, staying in BYTES throughout.
 *
 * Codex fix-verification pass on PR #89 [A/Medium]: this used to decode with `encoding: "utf8"` and
 * split the string. A git pathname is a byte string, not necessarily valid UTF-8 — a name
 * containing `0x80` decodes to U+FFFD, which re-encodes to `EF BF BD` and no longer names the file
 * on disk. `existsSync` then reported a present file as absent, the working-tree pass skipped it,
 * and a NUL written into that file (but not staged) was seen by neither pass. Verified: the raw
 * bytes and the decode-then-re-encode round trip are not equal.
 *
 * The byte-level split is safe because NUL cannot appear inside a UTF-8 sequence or a pathname —
 * it is the one byte a filename may not contain, which is exactly why `-z` uses it.
 *
 * WHERE THIS DEFECT IS REACHABLE, measured rather than assumed. macOS/APFS **refuses** a non-UTF-8
 * filename at the syscall level — `errno 92 EILSEQ`, reproduced from the shell, from Python and
 * from Node — so the trace cannot be built on a Mac at all. Linux filesystems accept any byte but
 * NUL and `/`, and this repo's CI is `ubuntu-latest`, so it is live exactly where the guard runs
 * unattended. That asymmetry is why the assertion below is on the BYTE-PRESERVATION INVARIANT
 * rather than on creating such a file: a test that tried to demonstrate the end-to-end trace would
 * pass on macOS by being skipped, which is the "assert the environment's outcome" failure this file
 * already avoids elsewhere.
 */
function splitNulBuffer(buf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const end = buf.indexOf(0x00, pos);
    if (end === -1) {
      // `-z` terminates every record, so trailing bytes with no NUL mean a truncated read.
      throw new Error("git ls-files -z: trailing bytes with no NUL terminator");
    }
    if (end > pos) parts.push(buf.subarray(pos, end));
    pos = end + 1;
  }
  return parts;
}

function trackedPathBytes(): Buffer[] {
  // No `encoding`, so this returns a Buffer and the pathname bytes survive intact.
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: MAX_BUFFER });
  return splitNulBuffer(out);
}

/**
 * What a `grep` run right now would actually read. Missing paths are the index pass's job.
 *
 * Paths are kept as Buffers all the way to the filesystem — Node's `fs` accepts Buffer paths, and
 * that is what preserves a non-UTF-8 filename. `path.join` cannot be used here (it is string-only),
 * so the separator is concatenated at the byte level; `git ls-files` always emits POSIX-separated
 * relative paths, and Node accepts `/` on every platform. The decoded string is carried ONLY as a
 * display label for the failure message, never used to open anything.
 */
function worktreeFiles(paths: Buffer[]): { path: string; bytes: Buffer }[] {
  const root = Buffer.from(`${REPO_ROOT}/`);
  const files: { path: string; bytes: Buffer }[] = [];
  for (const path of paths) {
    const absolute = Buffer.concat([root, path]);
    if (!existsSync(absolute)) continue;
    files.push({ path: path.toString("utf8"), bytes: readFileSync(absolute) });
  }
  return files;
}

describe("no tracked file contains a raw NUL byte", () => {
  it("reports nothing for clean input", () => {
    expect(
      findNulBytes([{ path: "a.ts", bytes: Buffer.from("const NULL_KEY = 'null';") }], "index"),
    ).toEqual([]);
  });

  it("reports the exact offset of a planted NUL, and which snapshot it came from", () => {
    const bytes = Buffer.concat([Buffer.from("abc"), Buffer.from([0x00]), Buffer.from("def")]);
    expect(findNulBytes([{ path: "planted.ts", bytes }], "working tree")).toEqual([
      { path: "planted.ts", offset: 3, snapshot: "working tree" },
    ]);
  });

  it("finds a NUL beyond git's 8000-byte sniff window", () => {
    // The exact shape of issue #66: git's binary heuristic reads only the first 8000 bytes, so
    // `git grep` still searched `src/ingest/upsert.ts` while `rg` and `grep` did not. A guard that
    // inherited git's window would have called that file clean — this pins that it does not.
    const bytes = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);
    expect(findNulBytes([{ path: "late.ts", bytes }], "index")).toEqual([
      { path: "late.ts", offset: 9000, snapshot: "index" },
    ]);
  });

  it("reports a NUL at offset 0 rather than reading the falsy index as clean", () => {
    expect(findNulBytes([{ path: "first.ts", bytes: Buffer.from([0x00, 0x41]) }], "index")).toEqual([
      { path: "first.ts", offset: 0, snapshot: "index" },
    ]);
  });

  it("reports a NUL as the final byte", () => {
    expect(findNulBytes([{ path: "last.ts", bytes: Buffer.from([0x41, 0x00]) }], "index")).toEqual([
      { path: "last.ts", offset: 1, snapshot: "index" },
    ]);
  });

  it("handles an empty file without crashing", () => {
    expect(findNulBytes([{ path: "empty.ts", bytes: Buffer.alloc(0) }], "index")).toEqual([]);
  });

  it("reports every offender, not just the first", () => {
    const offenders = findNulBytes(
      [
        { path: "one.ts", bytes: Buffer.from([0x00]) },
        { path: "clean.ts", bytes: Buffer.from("fine") },
        { path: "two.ts", bytes: Buffer.from([0x41, 0x42, 0x00]) },
      ],
      "index",
    );
    expect(offenders).toEqual([
      { path: "one.ts", offset: 0, snapshot: "index" },
      { path: "two.ts", offset: 2, snapshot: "index" },
    ]);
  });

  it("names the file, the offset, the snapshot and the fix when it fails", () => {
    // The failure message is the deliverable here as much as the assertion is: a guard that says
    // only "expected [] to equal [...]" costs the next reader the whole investigation issue #66
    // records. Asserted rather than assumed, because a message is exactly the thing no passing run
    // ever exercises.
    const message = describeOffenders([
      { path: "src/ingest/upsert.ts", offset: 15316, snapshot: "index" },
    ]);
    expect(message).toContain("src/ingest/upsert.ts");
    expect(message).toContain("15316");
    expect(message).toContain("index");
    expect(message).toContain(NUL_ESCAPE);
    // Codex adversarial review of PR #89 [A/Low]: the message used to assert that EVERY
    // content-search tool returns zero matches, which the doc comment above this file disproves in
    // its own table — `git grep` and `grep -a` both find it. A diagnostic that overstates its case
    // is the same claim-vs-code defect as any other, and it is read at the worst moment, by someone
    // who has just been told their file is broken. Pinned so it cannot drift back.
    expect(message).not.toMatch(/every content-search tool/i);
    expect(message).toContain("git grep may still find it");
    expect(describeOffenders([])).toBe("");
  });

  describe("git plumbing parsers", () => {
    it("parses index entries and keeps the path exactly", () => {
      const out = `100644 abc123 0\tsrc/a.ts${NUL_CHAR}100644 def456 0\tdocs/b c.md${NUL_CHAR}`;
      expect(parseIndexEntries(out)).toEqual([
        { oid: "abc123", path: "src/a.ts" },
        { oid: "def456", path: "docs/b c.md" },
      ]);
    });

    it("skips a gitlink, which has no blob to scan", () => {
      const out = `160000 aaa 0\tvendor/sub${NUL_CHAR}100644 bbb 0\tsrc/a.ts${NUL_CHAR}`;
      expect(parseIndexEntries(out)).toEqual([{ oid: "bbb", path: "src/a.ts" }]);
    });

    it("throws on a record it cannot parse rather than dropping it", () => {
      expect(() => parseIndexEntries(`garbage-without-a-tab${NUL_CHAR}`)).toThrow(/no tab separator/);
      expect(() => parseIndexEntries(`100644 abc\tsrc/a.ts${NUL_CHAR}`)).toThrow(/unexpected metadata/);
    });

    it("keeps a non-UTF-8 pathname byte instead of replacing it", () => {
      // Codex fix-verification pass on PR #89 [A/Medium]. A git pathname is a BYTE string. The
      // earlier version decoded `-z` output as UTF-8, and `0x80` became U+FFFD — a path that names
      // nothing on disk, so `existsSync` reported a real file absent and the working-tree pass
      // skipped it silently. Asserted at the byte level, because a string comparison here would
      // itself go through the decode that caused the defect.
      const name = Buffer.concat([Buffer.from("src/we"), Buffer.from([0x80]), Buffer.from("ird.ts")]);
      const parts = splitNulBuffer(Buffer.concat([name, Buffer.from([0x00])]));
      expect(parts).toHaveLength(1);
      expect(parts[0]!.equals(name)).toBe(true);
      expect([...parts[0]!]).toContain(0x80);

      // ...and the round trip that USED to happen does not preserve it — this is the defect, pinned
      // so the fix cannot be quietly reverted to a string pipeline.
      expect(Buffer.from(name.toString("utf8"), "utf8").equals(name)).toBe(false);
    });

    it("throws on -z output whose last record has no NUL terminator", () => {
      expect(() => splitNulBuffer(Buffer.from("src/a.ts"))).toThrow(/no NUL terminator/);
      expect(splitNulBuffer(Buffer.alloc(0))).toEqual([]);
    });

    it("parses a cat-file batch response", () => {
      const buf = Buffer.from("abc123 blob 5\nhello\n");
      const objects = parseCatFileBatch(buf);
      expect(objects).toHaveLength(1);
      expect(objects[0]!.oid).toBe("abc123");
      expect(objects[0]!.type).toBe("blob");
      expect(objects[0]!.bytes.toString()).toBe("hello");
    });

    it("frames contents containing BOTH a newline and a NUL, which is the case that matters", () => {
      // A delimiter-splitting parser mis-frames exactly the files this guard exists to catch, so
      // this is the load-bearing parser case rather than an edge case. Length-prefixed framing is
      // why it works; the body below is `a\n<NUL>b` — 5 bytes — followed by two more objects, so a
      // mis-frame corrupts everything after it and cannot pass silently.
      const body = Buffer.concat([Buffer.from("a\n"), Buffer.from([0x00]), Buffer.from("b")]);
      const buf = Buffer.concat([
        Buffer.from(`o1 blob ${body.length}\n`),
        body,
        Buffer.from("\n"),
        Buffer.from("o2 blob 2\nhi\n"),
        Buffer.from("o3 blob 0\n\n"),
      ]);
      const objects = parseCatFileBatch(buf);
      expect(objects.map((o) => o.oid)).toEqual(["o1", "o2", "o3"]);
      expect([...objects[0]!.bytes]).toEqual([0x61, 0x0a, 0x00, 0x62]);
      expect(objects[1]!.bytes.toString()).toBe("hi");
      expect(objects[2]!.bytes).toHaveLength(0);
      // And the guard still sees the NUL through the parse, which is the end-to-end point.
      expect(findNulBytes([{ path: "o1", bytes: objects[0]!.bytes }], "index")).toEqual([
        { path: "o1", offset: 2, snapshot: "index" },
      ]);
    });

    it("throws on a missing object instead of reading it as an empty file", () => {
      // `<oid> missing` is two fields. Treated as a clean empty blob it would be a silent
      // fail-open: an unresolvable tracked object would count as scanned and NUL-free.
      expect(() => parseCatFileBatch(Buffer.from("deadbeef missing\n"))).toThrow(/unexpected header/);
    });

    it("throws on a truncated response rather than returning what it got", () => {
      expect(() => parseCatFileBatch(Buffer.from("abc blob 99\nshort\n"))).toThrow(/truncated body/);
      expect(() => parseCatFileBatch(Buffer.from("abc blob 5"))).toThrow(/truncated header/);
      expect(() => parseCatFileBatch(Buffer.from("abc blob notanumber\nx\n"))).toThrow(/unusable size/);
    });

    it("throws when only the trailing LF is missing, not just when the body is short", () => {
      // Codex fix-verification pass on PR #89 [A/Low], as the exact one-byte trace it reported.
      // The old bound was `start + size > buf.length`, which this input satisfies exactly — the
      // body is present, only git's delimiter is not — so a response cut off mid-write framed
      // cleanly and returned one object. Every COMPLETE response also passes the loose check, which
      // is what made the off-by-one invisible: only a truncated one distinguishes them.
      expect(() => parseCatFileBatch(Buffer.from("abc blob 1\nX"))).toThrow(/truncated body/);
      // The complete form of the same response still parses, so the stricter bound did not simply
      // break the happy path — the pair is the assertion.
      expect(parseCatFileBatch(Buffer.from("abc blob 1\nX\n"))[0]!.bytes.toString()).toBe("X");
      // Zero-length body, missing delimiter — the boundary at the other end.
      expect(() => parseCatFileBatch(Buffer.from("abc blob 0\n"))).toThrow(/truncated body/);
    });
  });

  it("scans every tracked blob in the INDEX and finds no raw NUL byte", () => {
    // The authoritative pass. Codex's finding was that listing from git and reading from disk are
    // two snapshots; here the list and the bytes both come from the index, so a staged NUL cannot
    // hide behind a clean working tree.
    const blobs = indexBlobs();

    // Non-vacuity. An empty scan is green and silent, and so is one aimed at the WRONG tree — a
    // `cwd` resolving elsewhere returns a plausible, entirely clean file list and no error.
    expect(blobs.length).toBeGreaterThan(0);
    const paths = blobs.map((b) => b.path);
    expect(paths).toContain("src/ingest/upsert.ts");
    expect(paths).toContain("test/source-no-nul-bytes.test.ts");

    const offenders = findNulBytes(blobs, "index");
    expect(offenders, describeOffenders(offenders)).toEqual([]);
  });

  it("scans the on-disk copy of every tracked file that exists and finds no raw NUL byte", () => {
    // The companion pass: what a grep you run right now actually reads. A NUL that is written but
    // not staged is invisible to the index pass, and this is the pass that catches it.
    //
    // The title says "every tracked file THAT EXISTS", not "every tracked file" — Codex flagged the
    // stronger wording as false, and it was. Paths absent from disk are skipped by design, and the
    // index pass is what makes that safe by covering every tracked path unconditionally. Naming the
    // narrower claim is the point: a test title is a claim like any other.
    const paths = trackedPathBytes();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.map((p) => p.toString("utf8"))).toContain("src/ingest/upsert.ts");

    const files = worktreeFiles(paths);
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(paths.length);
    // This repo has no absent tracked path in a clean checkout, so the companion pass should in
    // fact cover all of them here. Asserted as an equality on the CLEAN case specifically, because
    // it is the assertion that would catch a skip silently swallowing files — the failure mode the
    // non-UTF-8 defect actually produced.
    if (files.length !== paths.length) {
      throw new Error(
        `${paths.length - files.length} tracked path(s) were skipped by the working-tree pass; in a ` +
          `clean checkout every tracked path exists on disk, so a skip here means the path bytes ` +
          `did not survive to the filesystem (see issue #66 / PR #89 finding on non-UTF-8 names)`,
      );
    }

    const offenders = findNulBytes(files, "working tree");
    expect(offenders, describeOffenders(offenders)).toEqual([]);
  });
});
