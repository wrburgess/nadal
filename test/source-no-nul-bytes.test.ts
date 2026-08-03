import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The SIX CHARACTERS backslash-u-0-0-0-0, not the byte — this is display text for the failure
// message below, telling an author what to write instead. Spelled `"\\u0000"` in the source for
// exactly that reason.
const NUL_ESCAPE = "\\u0000";

// Every NUL in this file's test data is built from a BYTE ARRAY (`Buffer.from([0x00])`), never from
// a string escape. Two reasons, one of which cost this PR three defects in its own first draft:
// a literal 0x00 typed into a source file makes that file binary — this file would become the
// rule's own first violation, and an invisible one. And an escape sequence has to survive every
// tool boundary between the author and the disk intact — and that escape, spelled out inside a JSON
// payload, IS a NUL. So text *describing* the escape can arrive as the byte it was warning about. A
// byte array has no escape to mangle, which is why the data below is written as one.

/**
 * Issue #66. A single 0x00 byte anywhere in a file makes content-search tools classify the whole
 * file as binary and report ZERO matches in it — silently. A missing file in a grep result is
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
 * beyond-the-sniff-window case below is pinned explicitly.
 *
 * The invariant asserted here is the one grep's binary test actually keys on: THE FILE CONTAINS NO
 * 0x00 BYTE. Deliberately not "`file` reports text" or "`rg` finds a known string" — those bind this
 * guard to a platform's heuristics and go false-clear when the platform changes, which is the
 * recorded mutation-sweep failure mode (`docs/findings.md`).
 *
 * DELIBERATELY NO ALLOWLIST. Zero tracked files are binary today, so an empty `ALLOWED_BINARY` array
 * would be a branch no test can kill (`rules/testing.md` -> Anti-Patterns, last row). The day a
 * legitimately-binary fixture is tracked, this fails loudly and its message tells that author what
 * to do — visible and deliberate, rather than a dead extension point that reads as coverage.
 */
export type NulOffender = { path: string; offset: number };

/**
 * Pure over its input, so the synthetic cases below can prove this guard is capable of failing —
 * the shape `test/cli-grammar-parity.test.ts` uses, and for the same reason. A scan that only ever
 * ran against the real tree could not distinguish "nothing is wrong" from "nothing was read".
 */
export function findNulBytes(files: { path: string; bytes: Buffer }[]): NulOffender[] {
  const offenders: NulOffender[] = [];
  for (const file of files) {
    const offset = file.bytes.indexOf(0x00);
    // `!== -1`, never a truthiness test: a NUL at offset 0 reports offset `0`, which is falsy, so
    // `if (offset)` would call a file whose FIRST byte is NUL clean. Pinned by a case below.
    if (offset !== -1) offenders.push({ path: file.path, offset });
  }
  return offenders;
}

function describeOffenders(offenders: NulOffender[]): string {
  return offenders
    .map(
      (o) =>
        `${o.path} contains a raw 0x00 byte at offset ${o.offset}. ` +
        `Every content-search tool then reports ZERO matches in this file, silently. ` +
        `Write the byte as the escape ${NUL_ESCAPE} instead, and re-read the file's bytes ` +
        `afterwards rather than trusting what you typed (see issue #66).`,
    )
    .join("\n");
}

/**
 * A tracked path that cannot be read must FAIL, never be filtered away: a skipped file shrinks the
 * scanned set while the suite stays green — the same "an incomplete audit reads as a complete one"
 * shape this whole file exists to prevent, one level up, inside the guard itself. Wrapped rather
 * than left to a bare `readFileSync` so the reason travels with the failure, and so the behavior is
 * this file's own and can be asserted below rather than assumed of Node.
 */
function readTracked(path: string): Buffer {
  try {
    return readFileSync(join(REPO_ROOT, path));
  } catch (cause) {
    throw new Error(
      `git tracks ${path} but it could not be read, so the NUL scan would have covered one file ` +
        `fewer and still reported green. Fix the tree; do not skip the file.`,
      { cause },
    );
  }
}

function trackedPaths(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out.split("\u0000").filter((p) => p !== "");
}

describe("no tracked file contains a raw NUL byte", () => {
  it("reports nothing for clean input", () => {
    expect(findNulBytes([{ path: "a.ts", bytes: Buffer.from("const NULL_KEY = 'null';") }])).toEqual(
      [],
    );
  });

  it("reports the exact offset of a planted NUL", () => {
    const bytes = Buffer.concat([Buffer.from("abc"), Buffer.from([0x00]), Buffer.from("def")]);
    expect(findNulBytes([{ path: "planted.ts", bytes }])).toEqual([
      { path: "planted.ts", offset: 3 },
    ]);
  });

  it("finds a NUL beyond git's 8000-byte sniff window", () => {
    // The exact shape of issue #66: git's binary heuristic reads only the first 8000 bytes, so
    // `git grep` still searched `src/ingest/upsert.ts` while `rg` and `grep` did not. A guard that
    // inherited git's window would have called that file clean — this pins that it does not.
    const bytes = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);
    expect(findNulBytes([{ path: "late.ts", bytes }])).toEqual([{ path: "late.ts", offset: 9000 }]);
  });

  it("reports a NUL at offset 0 rather than reading the falsy index as clean", () => {
    expect(findNulBytes([{ path: "first.ts", bytes: Buffer.from([0x00, 0x41]) }])).toEqual([
      { path: "first.ts", offset: 0 },
    ]);
  });

  it("reports a NUL as the final byte", () => {
    expect(findNulBytes([{ path: "last.ts", bytes: Buffer.from([0x41, 0x00]) }])).toEqual([
      { path: "last.ts", offset: 1 },
    ]);
  });

  it("handles an empty file without crashing", () => {
    expect(findNulBytes([{ path: "empty.ts", bytes: Buffer.alloc(0) }])).toEqual([]);
  });

  it("reports every offender, not just the first", () => {
    const offenders = findNulBytes([
      { path: "one.ts", bytes: Buffer.from([0x00]) },
      { path: "clean.ts", bytes: Buffer.from("fine") },
      { path: "two.ts", bytes: Buffer.from([0x41, 0x42, 0x00]) },
    ]);
    expect(offenders).toEqual([
      { path: "one.ts", offset: 0 },
      { path: "two.ts", offset: 2 },
    ]);
  });

  it("names the file, the offset and the fix when it fails", () => {
    // The failure message is the deliverable here as much as the assertion is: a guard that says
    // only "expected [] to equal [...]" costs the next reader the whole investigation issue #66
    // records. Asserted rather than assumed, because a message is exactly the thing no passing run
    // ever exercises.
    const message = describeOffenders([{ path: "src/ingest/upsert.ts", offset: 15316 }]);
    expect(message).toContain("src/ingest/upsert.ts");
    expect(message).toContain("15316");
    expect(message).toContain(NUL_ESCAPE);
    expect(describeOffenders([])).toBe("");
  });

  it("refuses to skip a tracked file it cannot read", () => {
    // The scan's non-vacuity rests on read-count === listed-count, and the cheapest way to break
    // that silently is a `catch` that drops the unreadable file. Asserted, because the comment on
    // `readTracked` claims this and an unasserted claim is the failure mode next door to this one.
    expect(() => readTracked("does/not/exist.ts")).toThrow(/could not be read/);
    expect(() => readTracked("does/not/exist.ts")).toThrow(/does\/not\/exist\.ts/);
  });

  it("scans every git-tracked file and finds no raw NUL byte", () => {
    const paths = trackedPaths();

    // Non-vacuity, both halves. A scan that globbed nothing is green and silent, and so is one that
    // quietly skipped the one offending file: `read === listed` makes a shrinking scanned set
    // impossible, and a tracked-but-missing path throws here by design rather than being filtered
    // away into a smaller, still-green scan.
    expect(paths.length).toBeGreaterThan(0);
    const files = paths.map((path) => ({ path, bytes: readTracked(path) }));
    expect(files.length).toBe(paths.length);

    const offenders = findNulBytes(files);
    expect(offenders, describeOffenders(offenders)).toEqual([]);
  });
});
