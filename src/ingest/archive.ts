import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Anchored to this module's own location (repo root, two levels up from src/ingest/) rather than
// `process.cwd()`, for the same reason `src/db/client.ts` anchors its migrations folder: the
// answer must not depend on where the caller happened to be standing.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_RAW_DIR = "raw";

/**
 * The archive root every raw page and provenance record is written under. Mirrors `dbPath()` in
 * `src/db/client.ts`: an explicit env var when set, a repo-relative default otherwise.
 */
export function rawRoot(): string {
  return process.env.TN_RAW_PATH ?? DEFAULT_RAW_DIR;
}

/** True when `child` is `parent` itself or lives underneath it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The archive root itself must not sit inside the repo working tree — except at the one place
 * `.gitignore` covers, `<repo>/raw`. Checking only "is the file under `rawRoot`" is not enough:
 * that check is satisfied trivially by a misconfigured `TN_RAW_PATH=src`, which would then write
 * un-redacted captures of real people's pages into a tracked directory of a PUBLIC repo. The
 * guard has to constrain the root, not just the leaf.
 */
function assertRawRootSafe(resolvedRoot: string): void {
  if (!isWithin(PACKAGE_ROOT, resolvedRoot)) return;
  if (resolvedRoot === resolve(PACKAGE_ROOT, DEFAULT_RAW_DIR)) return;
  throw new ArchivePathError(
    `refusing an archive root inside the repository working tree: ${resolvedRoot} ` +
      `(un-redacted captures may only be written to ${resolve(PACKAGE_ROOT, DEFAULT_RAW_DIR)} or a path outside the repo)`,
  );
}

/**
 * A LEXICAL path check answers "what does this string say", not "where do the bytes land" — and the
 * filesystem is free to disagree. `resolve()` never consults the disk, so making `<repo>/raw` a
 * symlink to `<repo>/src`, or pointing `TN_RAW_PATH` at an external symlink that targets the repo,
 * satisfies every string comparison above while `writeFileSync` happily follows the link and drops
 * un-redacted captures into tracked source. (Codex adversarial review, PR #31, rated critical.)
 *
 * So the root is re-validated at its REAL location whenever it already exists. A symlinked root is
 * not itself forbidden — pointing the archive at an external disk is legitimate — what matters is
 * where it actually resolves to.
 */
function assertRealRootSafe(resolvedRoot: string): void {
  const real = realpathOfNearestExisting(resolvedRoot);
  if (real !== resolvedRoot) assertRawRootSafe(real);
}

/**
 * `realpathSync` throws ENOENT on a path that does not exist yet, and the archive root legitimately
 * does not exist before the first capture — resolving it unconditionally would make every first run
 * fail. Resolve the deepest EXISTING ancestor instead and re-append the rest: the symlink can only
 * live in a component that exists, so this sees every link there is to see.
 */
function realpathOfNearestExisting(target: string): string {
  const trailing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...trailing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      trailing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Inside the root, no path component may be a symlink at all. Unlike the root itself there is no
 * legitimate reason for one, and allowing them would reintroduce the same escape one level down —
 * `raw/tennisrecord` → `../../src` lands outside the root the check just validated.
 */
function assertNoSymlinkComponents(resolvedRoot: string, resolvedTarget: string): void {
  const rel = relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      throw new ArchivePathError(`refusing to write through a symlinked archive component: ${current}`);
    }
  }
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
 */
export class ArchivePathError extends Error {}

export function assertArchivePathSafe(candidatePath: string, root: string = rawRoot()): void {
  const resolvedRoot = resolve(root);
  assertRawRootSafe(resolvedRoot);
  assertRealRootSafe(resolvedRoot);
  const resolvedCandidate = resolve(candidatePath);
  const rel = relative(resolvedRoot, resolvedCandidate);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new ArchivePathError(
      `refusing to write archive path outside raw root "${resolvedRoot}": ${resolvedCandidate}`,
    );
  }
  assertNoSymlinkComponents(resolvedRoot, resolvedCandidate);
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
  // `assertRawRootSafe` on the descendant instead broke the DOCUMENTED DEFAULT outright: with
  // TN_RAW_PATH unset the root is `<repo>/raw`, the directory is `<repo>/raw/tennisrecord`, and the
  // root-only allowlist ("inside the repo, and not exactly <repo>/raw") rejected it — so every pull
  // threw before writing a byte. Every test set TN_RAW_PATH to a temp dir, so nothing exercised the
  // one configuration the README documents. (Codex adversarial review, PR #31 round 3.)
  const realRoot = realpathOfNearestExisting(resolve(rawRoot()));
  assertRawRootSafe(realRoot);
  const realDir = realpathOfNearestExisting(resolve(dir));
  if (!isWithin(realRoot, realDir)) {
    throw new ArchivePathError(`refusing to write outside the resolved raw root "${realRoot}": ${realDir}`);
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
