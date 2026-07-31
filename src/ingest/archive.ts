import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertOutputPathSafe, writeNewOutputFile } from "../fs/output-root.js";

const DEFAULT_RAW_DIR = "raw";

/**
 * The archive root every raw page and provenance record is written under. Mirrors `dbPath()` in
 * `src/db/client.ts`: an explicit env var when set, a repo-relative default otherwise.
 */
export function rawRoot(): string {
  return process.env.TN_RAW_PATH ?? DEFAULT_RAW_DIR;
}

export type ArchivePageInput = {
  sourceSet: string;
  slug: string;
  url: string;
  body: string;
  httpStatus: number;
};

export type ArchiveProvenance = {
  sourceUrl: string;
  fetchedAt: string;
  httpStatus: number;
  redacted: false;
  bytes: number;
};

/**
 * `assertArchivePathSafe` is the entire privacy control for un-redacted personal data in a PUBLIC
 * repo: everything this module writes is a raw, un-redacted capture of a real person's page, and
 * the only thing standing between that and a public commit is this path staying inside `rawRoot`.
 * `ArchivePathError` on any escape — a `..` segment, or a resolved path outside `rawRoot` for any
 * other reason (including one that happens to land inside the repo working tree).
 *
 * Both the error class and the check itself now live in `src/fs/output-root.ts`, generalized to
 * take the permitted in-repo directory name as a parameter (`"raw"` here; `"reports"` for the
 * dossier writer) so a second hardened guard is never hand-rolled for the next output root. This
 * module re-exports `OutputPathError` AS `ArchivePathError` — not a subclass — so every existing
 * `toThrow(ArchivePathError)` assertion keeps matching the exact instance the shared guard throws.
 */
export { OutputPathError as ArchivePathError } from "../fs/output-root.js";

export function assertArchivePathSafe(candidatePath: string, root: string = rawRoot()): void {
  assertOutputPathSafe(candidatePath, root, DEFAULT_RAW_DIR);
}

// Guarantees two archives of the same (sourceSet, slug) within one process get distinct
// timestamps even when called back-to-back inside the same millisecond — the filename's ISO8601
// stamp is otherwise the only thing preventing a silent clobber.
let lastStampMs = 0;

function nextTimestamp(): string {
  let ms = Date.now();
  if (ms <= lastStampMs) ms = lastStampMs + 1;
  lastStampMs = ms;
  return new Date(ms).toISOString();
}

/**
 * Write a raw, un-redacted capture of a fetched (or archived-and-handed-in) page plus its
 * provenance record, before anything parses it. Spec § Ingestion requires every fetch to save its
 * raw page — "the TDD substrate and the re-parse archive" — and archiving BEFORE parsing is what
 * makes a parser failure recoverable: the page is already safely on disk.
 *
 * Every path this function would touch is checked with `assertArchivePathSafe` before anything is
 * written, so a refusal writes NOTHING — not even the html file, half the pair.
 */
export function archivePage(input: ArchivePageInput): string {
  const fetchedAt = nextTimestamp();
  const stamp = fetchedAt.replace(/[:.]/g, "-");
  const dir = join(rawRoot(), input.sourceSet);
  const htmlPath = join(dir, `${input.slug}-${stamp}.html`);
  const provenancePath = `${htmlPath}.provenance.json`;

  assertArchivePathSafe(htmlPath);
  assertArchivePathSafe(provenancePath);

  mkdirSync(dir, { recursive: true });
  // `writeNewOutputFile` (src/fs/output-root.ts — shared with `src/report/write.ts` so this
  // hardening lives in exactly one place) resolves the REAL destination the same way
  // `resolveRealOutputPath` always did — re-running the symlink-component check now that the
  // directory genuinely exists (`mkdirSync(..., { recursive: true })` treats an existing
  // symlink-to-a-directory as "already there" and succeeds silently, so the pre-check alone would
  // leave a gap here) and re-resolving ROOT and the directory to their real filesystem locations —
  // and then, unlike a plain path-based write, OPENS that destination (`wx`: `O_CREAT | O_EXCL`,
  // which refuses outright to follow an existing symlink or file at the leaf) and writes the bytes
  // THROUGH the resulting file descriptor rather than through the path string. Immediately after the
  // open it re-verifies, against the fd, that (1) no directory component is a symlink and (2) the
  // fd's inode still matches what the path names right now — see `openNewOutputFileSafely`'s own doc
  // comment in `src/fs/output-root.ts` for why BOTH checks are required and neither is sufficient
  // alone. Once both hold, a component swapped in AFTER the open cannot redirect the write: the fd is
  // a handle bound to one inode, not a lookup that gets repeated.
  //
  // CLOSED (#33): un-redacted capture content can no longer be written outside the validated real
  // root via a directory-component swap between resolution and the write — the bytes go through a
  // proven fd, not a re-resolved path string.
  // REMAINING: an actor who wins the PRE-OPEN window — before `writeNewOutputFile` ever calls
  // `openSync` — can still cause an EMPTY file to be created at a location of their choosing; the
  // call then fails closed on the post-open verification and writes no CONTENT there. Pure Node has
  // no `openat`/`O_NOFOLLOW` directory-handle write, so closing that narrower window would need a
  // native helper — a new dependency the plan forbids. See `docs/findings.md`.
  //
  // NOTE on why the root check happens at the ROOT and not the descendant: with TN_RAW_PATH unset
  // the root is `<repo>/raw`, the directory is `<repo>/raw/tennisrecord`, and an allowlist checked
  // against the descendant instead ("inside the repo, and not exactly <repo>/raw") rejected the
  // DOCUMENTED DEFAULT outright — every pull threw before writing a byte, and every test at the time
  // set TN_RAW_PATH to a temp dir, so nothing exercised the one configuration the README describes.
  // (Codex adversarial review, PR #31 round 3.) `resolveRealOutputPath` checks the root, not the
  // directory, preserving that fix.
  writeNewOutputFile(rawRoot(), htmlPath, DEFAULT_RAW_DIR, input.body);

  const provenance: ArchiveProvenance = {
    sourceUrl: input.url,
    fetchedAt,
    httpStatus: input.httpStatus,
    redacted: false,
    bytes: Buffer.byteLength(input.body, "utf8"),
  };
  writeNewOutputFile(rawRoot(), provenancePath, DEFAULT_RAW_DIR, JSON.stringify(provenance, null, 2));

  // The REAL path is what we wrote through (that is the containment property); the LOGICAL path is
  // what we hand back. They differ whenever the root legitimately resolves elsewhere — on macOS a
  // temp dir under /var realpaths to /private/var — and a caller that configured TN_RAW_PATH should
  // be told where it asked for the file, not shown a path it never named. Both name the same bytes.
  return htmlPath;
}
