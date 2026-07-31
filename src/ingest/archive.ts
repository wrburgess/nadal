import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  assertNoSymlinkComponents,
  assertOutputPathSafe,
  assertRootSafe,
  isWithin,
  OutputPathError,
  realpathOfNearestExisting,
} from "../fs/output-root.js";

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
  // Re-checked AFTER mkdir: `mkdirSync(..., { recursive: true })` treats an existing symlink-to-a-
  // directory as "already there" and succeeds silently, so the pre-check alone leaves a
  // check-then-use gap. `flag: "wx"` (O_CREAT|O_EXCL) closes the leaf half — it refuses to follow an
  // existing symlink at the target rather than writing through it, and the timestamped filenames
  // mean a genuine collision cannot happen in normal operation.
  assertNoSymlinkComponents(resolve(rawRoot()), resolve(htmlPath));

  // Then write through the directory's REAL location, resolved here rather than trusting the
  // path string built above. Rejecting symlinked components asks "is this a link?"; this asks the
  // question that actually matters — "where does it point?" — so a component swapped for a link
  // into the repo is refused by its target, not merely by its type.
  //
  // RESIDUAL, deliberately not claimed as closed: this is still check-then-use. An actor able to
  // swap a component between this resolution and the write can still win the race, and pure Node
  // has no `openat`/`O_NOFOLLOW` directory-handle write to close it (a native helper would be a new
  // dependency the plan forbids). See the tracked follow-up and `docs/findings.md`.
  // The allowlist applies to the ROOT; containment applies to the directory beneath it. Running
  // `assertRootSafe` on the descendant instead broke the DOCUMENTED DEFAULT outright: with
  // TN_RAW_PATH unset the root is `<repo>/raw`, the directory is `<repo>/raw/tennisrecord`, and the
  // root-only allowlist ("inside the repo, and not exactly <repo>/raw") rejected it — so every pull
  // threw before writing a byte. Every test set TN_RAW_PATH to a temp dir, so nothing exercised the
  // one configuration the README documents. (Codex adversarial review, PR #31 round 3.)
  const realRoot = realpathOfNearestExisting(resolve(rawRoot()));
  assertRootSafe(realRoot, DEFAULT_RAW_DIR);
  const realDir = realpathOfNearestExisting(resolve(dir));
  if (!isWithin(realRoot, realDir)) {
    throw new OutputPathError(`refusing to write outside the resolved raw root "${realRoot}": ${realDir}`);
  }
  const realHtmlPath = join(realDir, basename(htmlPath));
  const realProvenancePath = `${realHtmlPath}.provenance.json`;
  writeFileSync(realHtmlPath, input.body, { encoding: "utf8", flag: "wx" });

  const provenance: ArchiveProvenance = {
    sourceUrl: input.url,
    fetchedAt,
    httpStatus: input.httpStatus,
    redacted: false,
    bytes: Buffer.byteLength(input.body, "utf8"),
  };
  writeFileSync(realProvenancePath, JSON.stringify(provenance, null, 2), { encoding: "utf8", flag: "wx" });

  // The REAL path is what we wrote through (that is the containment property); the LOGICAL path is
  // what we hand back. They differ whenever the root legitimately resolves elsewhere — on macOS a
  // temp dir under /var realpaths to /private/var — and a caller that configured TN_RAW_PATH should
  // be told where it asked for the file, not shown a path it never named. Both name the same bytes.
  return htmlPath;
}
