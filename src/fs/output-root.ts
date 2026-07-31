import { lstatSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Anchored to this module's own location (repo root, two levels up from src/fs/) rather than
// `process.cwd()`, for the same reason `src/db/client.ts` anchors its migrations folder: the
// answer must not depend on where the caller happened to be standing. This used to live in
// `src/ingest/archive.ts` directly; it moved here unchanged when the guard it anchors was
// generalized to cover more than one output directory (`raw/` today, `reports/` next).
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The entire privacy control for personal data written outside version control funnels through
 * this error: an escape via a `..` segment, a root that resolves inside the repository working
 * tree anywhere other than its one permitted directory, or a symlinked component anywhere beneath
 * an otherwise-valid root. Every caller of `assertOutputPathSafe` shares this one class so a
 * caller-specific alias (e.g. `src/ingest/archive.ts`'s `ArchivePathError`) can re-export it
 * directly (`export { OutputPathError as ArchivePathError }`) rather than subclassing it — an
 * existing `toThrow(ArchivePathError)` assertion must keep matching the exact instance this module
 * throws, which only holds if the two names refer to the same class.
 */
export class OutputPathError extends Error {}

/** True when `child` is `parent` itself or lives underneath it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The output root itself must not sit inside the repo working tree — except at the one place
 * `.gitignore` covers for this caller, `<repo>/<permittedDir>` (e.g. `<repo>/raw` for archive
 * captures, `<repo>/reports` for rendered dossiers). Checking only "is the file under the root" is
 * not enough: that check is satisfied trivially by a misconfigured root such as `TN_RAW_PATH=src`,
 * which would then write un-redacted personal data into a TRACKED directory of a PUBLIC repo. The
 * guard has to constrain the root, not just the leaf. `permittedDir` is the single repo-relative
 * directory name this caller is allowed to use as an in-repo root — passing the wrong caller's
 * directory (e.g. `"raw"` when the caller is the reports writer) is refused exactly like any other
 * in-repo path, which is the point of parameterizing this rather than hardcoding one exception.
 */
export function assertRootSafe(resolvedRoot: string, permittedDir: string): void {
  if (!isWithin(PACKAGE_ROOT, resolvedRoot)) return;
  if (resolvedRoot === resolve(PACKAGE_ROOT, permittedDir)) return;
  throw new OutputPathError(
    `refusing an output root inside the repository working tree: ${resolvedRoot} ` +
      `(personal data may only be written to ${resolve(PACKAGE_ROOT, permittedDir)} or a path outside the repo)`,
  );
}

/**
 * A LEXICAL path check answers "what does this string say", not "where do the bytes land" — and the
 * filesystem is free to disagree. `resolve()` never consults the disk, so making `<repo>/raw` a
 * symlink to `<repo>/src`, or pointing the root env var at an external symlink that targets the
 * repo, satisfies every string comparison above while `writeFileSync` happily follows the link and
 * drops un-redacted data into tracked source. (Codex adversarial review, PR #31, rated critical.)
 *
 * So the root is re-validated at its REAL location whenever it already exists. A symlinked root is
 * not itself forbidden — pointing the output root at an external disk is legitimate — what matters
 * is where it actually resolves to.
 */
export function assertRealRootSafe(resolvedRoot: string, permittedDir: string): void {
  const real = realpathOfNearestExisting(resolvedRoot);
  if (real !== resolvedRoot) assertRootSafe(real, permittedDir);
}

/**
 * `realpathSync` throws ENOENT on a path that does not exist yet, and an output root legitimately
 * does not exist before the first write — resolving it unconditionally would make every first run
 * fail. Resolve the deepest EXISTING ancestor instead and re-append the rest: the symlink can only
 * live in a component that exists, so this sees every link there is to see.
 */
export function realpathOfNearestExisting(target: string): string {
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
export function assertNoSymlinkComponents(resolvedRoot: string, resolvedTarget: string): void {
  const rel = relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      throw new OutputPathError(`refusing to write through a symlinked output component: ${current}`);
    }
  }
}

/**
 * `assertOutputPathSafe` is the entire privacy control for personal data written outside version
 * control: a caller writing real people's names, ratings, or match histories to disk (an archived
 * page, a rendered dossier) is safe only as long as every path it touches stays inside its root, and
 * that root itself is either outside the repo or is the one directory `.gitignore` covers for it.
 * Throws `OutputPathError` on any escape — a `..` segment, a resolved path outside `root` for any
 * other reason (including one that happens to land inside the repo working tree), or a symlinked
 * root or component that resolves somewhere it should not.
 */
export function assertOutputPathSafe(candidatePath: string, root: string, permittedDir: string): void {
  const resolvedRoot = resolve(root);
  assertRootSafe(resolvedRoot, permittedDir);
  assertRealRootSafe(resolvedRoot, permittedDir);
  const resolvedCandidate = resolve(candidatePath);
  const rel = relative(resolvedRoot, resolvedCandidate);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new OutputPathError(
      `refusing to write output path outside root "${resolvedRoot}": ${resolvedCandidate}`,
    );
  }
  assertNoSymlinkComponents(resolvedRoot, resolvedCandidate);
}

/**
 * Re-validates root+candidate AFTER `mkdirSync` has already run for `candidatePath`'s parent
 * directory, and returns the REAL resolved path a caller should write through instead of the string
 * it started with. `assertOutputPathSafe` runs necessarily BEFORE `mkdirSync` (the directory may not
 * exist yet for it to check), and `mkdirSync(..., { recursive: true })` treats an existing
 * symlink-to-a-directory as "already there" and succeeds silently — so the pre-check alone leaves a
 * check-then-use gap: a symlink swapped into a path component between the pre-check and this call is
 * never re-examined by a caller that keeps trusting the original string. This closes that gap by (1)
 * re-running the symlink-component check now that the directory genuinely exists, then (2) resolving
 * ROOT and the candidate's directory to their REAL filesystem locations and re-confirming containment
 * there — a LEXICAL path check answers "what does this string say", the filesystem is free to
 * disagree (Codex adversarial review, PR #31).
 *
 * Shared by every writer under this guard (`src/ingest/archive.ts`, `src/report/write.ts`) so the
 * hardening lives in exactly one place rather than being copied per caller. This function does not
 * itself write anything or decide the LEAF's write flag — that is caller policy: `archive.ts` never
 * rewrites a file in place and writes with `flag: "wx"` directly; `write.ts`'s reports ARE rewritten
 * on every run and use `overwriteOutputFile` below instead, which still refuses to follow a symlinked
 * leaf but tolerates (and replaces) a plain file left by a prior run.
 */
export function resolveRealOutputPath(root: string, candidatePath: string, permittedDir: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidatePath);
  assertNoSymlinkComponents(resolvedRoot, resolvedCandidate);

  const realRoot = realpathOfNearestExisting(resolvedRoot);
  assertRootSafe(realRoot, permittedDir);
  const realDir = realpathOfNearestExisting(dirname(resolvedCandidate));
  if (!isWithin(realRoot, realDir)) {
    throw new OutputPathError(
      `refusing to write output path outside the resolved root "${realRoot}": ${realDir}`,
    );
  }
  return join(realDir, basename(resolvedCandidate));
}

/**
 * Writes `content` to `path` such that an existing SYMLINK at the leaf is never followed — refused
 * outright — while a plain existing file (the normal case for a writer whose output is rewritten in
 * place on every run, e.g. a dossier report) is safely replaced. A bare `{ flag: "wx" }` write (the
 * no-follow idiom `archivePage` uses for its never-rewritten, timestamped filenames) cannot serve a
 * rewrite-in-place caller: `wx` refuses whenever ANYTHING already exists at the leaf, symlink or not,
 * which would break every second run. So: `lstat` the leaf first (never follows a link itself); a
 * symlink found there is refused unconditionally, before any write is attempted; anything else that
 * exists (an ordinary file left by a prior run) is removed, and ONLY THEN is the fresh file created
 * with `wx` — so the create step itself never silently follows a link either, it always either makes
 * a brand-new leaf or throws.
 */
export function overwriteOutputFile(path: string, content: string): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    throw new OutputPathError(`refusing to write through a symlinked output path: ${path}`);
  }
  if (existing !== undefined) unlinkSync(path);
  writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
}
