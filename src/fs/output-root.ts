import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
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
 * Walks `dir` and its ancestors for a `.git` entry (a directory for a normal clone, a file for a
 * linked worktree — both mark "a git work tree starts here") and returns the FIRST ancestor that
 * has one, or `null` if none does. A pure filesystem walk, no subprocess: this exists so
 * `assertNotGitTracked` below can (1) skip shelling out entirely for the common case (an
 * archive/report root on an external disk, not inside any git work tree at all), and (2) hand
 * `isGitTracked` a `cwd` that is GUARANTEED to exist on disk — `existsSync(join(current, ".git"))`
 * only ever returns true when `current` itself exists, so the returned root is never a path a
 * subprocess would fail to `chdir` into. That guarantee is the fix for Finding 1 below: the
 * destination's OWN directory (the previous `cwd`) is routinely absent — that is the normal state
 * for a build about to recreate it — but the work-tree ROOT it lives under always exists once any
 * `.git` marker has been found underneath it.
 */
function findGitWorkTreeRoot(dir: string): string | null {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The only three outcomes `assertNotGitTracked` distinguishes: `git` confirmed the path is
 * tracked (refuse), `git` confirmed it is not (allow), or the answer could not be determined at all
 * — a spawn failure, an unexpected exit code, stderr that isn't git's own documented "not tracked"
 * message (refuse; never conflate with "untracked", see `isGitTracked` below). */
type GitTrackedResult = "tracked" | "untracked" | "indeterminate";

/**
 * Asks git itself — not `.gitignore`, which cannot answer this — whether `resolvedPath` is
 * currently tracked, running the `git` invocation from `cwd` (a directory `findGitWorkTreeRoot`
 * already confirmed exists on disk, NOT `resolvedPath`'s own directory — see that function's doc
 * comment and Finding 1 below for why that distinction is the entire fix). `resolvedPath` is
 * absolute, so `cwd` only has to be somewhere inside the same work tree for git to resolve it
 * correctly; which existing ancestor is used does not change the answer.
 *
 * `git ls-files --error-unmatch` exits 0 when the path IS tracked. On any non-zero exit this reads
 * stderr rather than trusting the exit code alone: git's OWN text for "not tracked" is
 * "did not match any file(s) known to git" — that specific message is the ONLY thing that resolves
 * to "untracked". That text is English only because the locale is pinned to `C` below; it is a
 * translated string otherwise, so the pin is load-bearing rather than cosmetic.
 * Every other outcome (a spawn error — git missing from PATH — a non-zero exit with different or no
 * stderr, or a crash) resolves to "indeterminate", which the caller refuses rather than allows: an
 * invocation problem is indistinguishable from exactly the state this whole module exists to guard
 * against, so fail-open here is not defensible (Codex adversarial review, PR #38 round 2, Finding 1
 * [critical] — the round-1 version conflated ALL of these into a single `catch { return false }`,
 * which is what let a destination whose parent directory doesn't exist yet — because `cwd` was that
 * same missing directory — bypass the guard entirely: ENOENT on `execFileSync`'s own `chdir` looked
 * indistinguishable from "not tracked").
 */
/**
 * Every environment variable git itself treats as SELECTING which repository/index/working tree to
 * operate against — as opposed to ones that merely tweak output (`GIT_PAGER`) or tracing
 * (`GIT_TRACE*`), which are harmless here and deliberately left alone. This is a DENYLIST BY PREFIX
 * (`GIT_*` in full) rather than an allowlist of the handful named below, because a future git
 * version's repository-selection variable this list has never heard of must fail closed (stripped)
 * by default, not sail through unstripped the way `GIT_INDEX_FILE` did before this fix existed.
 * Named here anyway, for the record, because "strip everything" without an example invites a future
 * editor to narrow it back down to only these: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
 * `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_NAMESPACE`, and the whole
 * `GIT_CONFIG_*`/`GIT_CONFIG` family (config can itself redirect object/index/worktree locations).
 */
const GIT_ENV_PREFIX = "GIT_";

/**
 * The exact child environment `isGitTracked` spawns `git` with: every entry of `process.env` EXCEPT
 * anything starting with `GIT_` (see `GIT_ENV_PREFIX` above), plus the locale pin below.
 *
 * The `GIT_*` strip closes Finding 1 (Codex adversarial review, PR #38 round 3, [critical]): the
 * previous version spread `process.env` verbatim, so an ambient `GIT_INDEX_FILE` (or `GIT_DIR`,
 * `GIT_WORK_TREE`, …) rode straight through to the spawned `git` and silently redirected which
 * repository/index it actually answered `ls-files` against — a DIFFERENT one than the `cwd` this
 * function's caller deliberately chose (`findGitWorkTreeRoot`'s discovered work-tree root). The
 * reviewer's exact reproducer: `GIT_INDEX_FILE` pointed at a nonexistent path makes git treat the
 * index as empty, so `git ls-files --error-unmatch` reports a genuinely tracked absolute path as
 * "did not match any file(s) known to git" — the literal text this module reads as "untracked" —
 * because git consulted the bogus empty index instead of the repository's real one. Stripping the
 * WHOLE `GIT_*` namespace (not just the three variables the reproducer needed) is deliberate: this
 * guard's entire job is deciding whether a path is tracked in the ONE repository `cwd` points at, and
 * there is no legitimate reason for the ambient environment to redirect that answer to a different
 * repository, index, or object store — so nothing in that namespace is trusted through.
 *
 * git's error messages are TRANSLATED when it is built with NLS and the environment asks for another
 * language — under `LC_ALL=fr_FR.UTF-8` the stderr below reads "erreur : le spécificateur de chemin
 * '…' ne correspond à aucun fichier connu de git", and the English match then fails. Since an
 * unmatched message resolves to "indeterminate" and the caller FAILS CLOSED, that would refuse every
 * capture and every dossier write on any machine not running in English, while passing every test on
 * one that is. That is the PR #31 round-3 defect exactly ("a privacy control that refuses everything
 * looks identical to a privacy control that works, right up until someone runs it"), so the locale is
 * pinned rather than assumed: `LC_ALL=C` selects git's untranslated strings, and `LANGUAGE` is
 * cleared because it overrides LC_ALL for message translation specifically and would otherwise win.
 */
function gitChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(GIT_ENV_PREFIX)) continue;
    env[key] = value;
  }
  env.LC_ALL = "C";
  env.LANGUAGE = "";
  return env;
}

function isGitTracked(resolvedPath: string, cwd: string): GitTrackedResult {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", resolvedPath], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: gitChildEnv(),
  });
  if (result.error !== undefined) return "indeterminate";
  if (result.status === 0) return "tracked";
  if (result.status === 1 && (result.stderr ?? "").includes("did not match any file")) return "untracked";
  return "indeterminate";
}

/**
 * The in-repo exception above (`assertRootSafe`'s "safe because `.gitignore` covers it") reasons
 * from `.gitignore`, but `.gitignore` has NO effect on a path git is already tracking: if someone
 * once ran `git add -f reports/team-a/index.html`, that path stays tracked forever no matter what
 * `.gitignore` says, and every other check in this module would wave a rewrite of it straight
 * through — producing a TRACKED change containing real people's names, ages, and ratings in a
 * PUBLIC repo, which is precisely the publication this module exists to prevent (Codex adversarial
 * review, PR #38, Finding 1 [critical]).
 *
 * Deliberately generic rather than hardcoded to this package's own repo: it asks whether
 * `resolvedPath` is tracked in WHATEVER git work tree (if any) it happens to live in, found by a
 * plain filesystem walk (`findGitWorkTreeRoot`) rather than anchoring to `PACKAGE_ROOT`. Two
 * consequences fall out of that: (1) an archive/report root on an external disk — legitimately not
 * inside any repo — is detected as such WITHOUT ever shelling out to git, and (2) this check, and
 * the two callers that share it, can be exercised in tests against an isolated temp git repo rather
 * than mutating this real repository's own index.
 *
 * Fails CLOSED now, not open: a path inside a confirmed git work tree that `isGitTracked` cannot
 * resolve to a definite "tracked"/"untracked" answer is refused, same as a confirmed-tracked path.
 * No retry-from-a-different-cwd is attempted, because `cwd` here is ALREADY the known-good work-tree
 * root `findGitWorkTreeRoot` found (guaranteed to exist) — a second attempt from that identical `cwd`
 * would only re-observe the same failure, so it would add a subprocess spawn for no chance of a
 * different outcome (Codex adversarial review, PR #38 round 2, Finding 1 [critical]).
 */
function assertNotGitTracked(resolvedPath: string): void {
  const workTreeRoot = findGitWorkTreeRoot(dirname(resolvedPath));
  if (workTreeRoot === null) return;
  const result = isGitTracked(resolvedPath, workTreeRoot);
  if (result === "untracked") return;
  const reason =
    result === "tracked"
      ? "a path git already tracks"
      : "a path inside a git work tree whose tracked status could not be determined (git invocation failed or returned an unexpected result)";
  throw new OutputPathError(
    `refusing to write ${reason}: ${resolvedPath} ` +
      `(.gitignore does not un-track a file that was previously \`git add -f\`'d — writing here would ` +
      `risk producing a tracked change containing personal data in a public repo)`,
  );
}

/**
 * `assertOutputPathSafe` is the entire privacy control for personal data written outside version
 * control: a caller writing real people's names, ratings, or match histories to disk (an archived
 * page, a rendered dossier) is safe only as long as every path it touches stays inside its root, and
 * that root itself is either outside the repo or is the one directory `.gitignore` covers for it.
 * Throws `OutputPathError` on any escape — a `..` segment, a resolved path outside `root` for any
 * other reason (including one that happens to land inside the repo working tree), a symlinked
 * root or component that resolves somewhere it should not, or a path git is already tracking (see
 * `assertNotGitTracked` — the in-repo exception above holds only for files `.gitignore` actually
 * keeps untracked).
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
  assertNotGitTracked(resolvedCandidate);
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
 * Shared by every writer under this guard so the hardening lives in exactly one place rather than
 * being copied per caller — though the two callers now consume it differently (#33).
 * `src/ingest/archive.ts` no longer calls this directly: its writes go through `writeNewOutputFile`
 * below, which calls this internally as its OWN resolution step and then opens the result and
 * verifies the fd before writing a single byte, closing the check-then-use window a bare path string
 * leaves open. `src/report/write.ts` still calls this directly, exactly as before, and then hands the
 * returned string to `overwriteOutputFile` — that path still resolves-then-writes, but
 * `overwriteOutputFile` narrows the window as far as a pure path operation (`rename(2)`, no
 * `renameat`) allows; see its own doc comment for the precise remaining shape.
 *
 * This function itself still does not write anything, open anything, or decide the leaf's write
 * flag — that is caller policy, as it always was. What has changed is that a caller resolving a path
 * here and then separately writing through the returned STRING (rather than through
 * `openNewOutputFileSafely`/`writeNewOutputFile`'s fd) is choosing the narrower of the two guarantees
 * this module now offers, not the only one available.
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
 * The fd-anchored write primitive (#33). A file descriptor is bound to an INODE, not to a path.
 * Everything above this point — `resolveRealOutputPath` included — resolves a path STRING and hands
 * it back to the caller, which then writes through that string: check-then-use. A directory
 * component swapped for a symlink in the window between the resolution and the write redirects the
 * bytes to wherever the symlink points, and nothing re-examines the filesystem in between. This
 * function closes that window for the write itself by opening the file FIRST and only trusting it
 * once two independent post-open checks both agree it is safe:
 *
 * 1. **The component walk, repeated.** `assertNoSymlinkComponents` re-run against the (freshly
 *    re-resolved) root and the real path confirms no directory component between them is a symlink
 *    RIGHT NOW — not at resolve time, now, after the open.
 * 2. **The inode comparison.** `fstatSync(fd)` names the inode the OPEN FILE DESCRIPTOR actually
 *    holds; `lstatSync(realPath)` names whatever inode the path string currently resolves to. They
 *    must agree, and the entry must be a plain file.
 *
 * Neither check is sufficient alone — that is the whole design here, not an incidental detail:
 *
 * - The component walk ALONE is exactly what `resolveRealOutputPath` already provides, and it is
 *   still check-then-use: nothing stops a symlink from being planted in the instant after the walk
 *   finishes and before the open happens.
 * - The inode comparison ALONE is UNSOUND: if an attacker leaves the planted symlink in place (rather
 *   than swapping it back after redirecting the write), `lstatSync(realPath)` itself TRAVERSES the
 *   symlinked directory component and reports the very inode the fd holds — a false match. `lstat`
 *   only refuses to follow a symlink at the FINAL path component; every component before it is
 *   followed exactly like `open` follows it, so the two calls agree on the wrong inode for the same
 *   reason `open` was fooled by it in the first place.
 *
 * Run TOGETHER, immediately after the open, they establish something neither can alone: no directory
 * component is a symlink NOW, and the fd IS what the path names NOW. A swap that happens AFTER this
 * point cannot redirect the fd — it is a handle, not a lookup — so the bytes this function's caller
 * writes through it are proven to land inside the validated real root.
 *
 * On ANY verification failure the newly-opened fd is closed and the (very likely empty, since the
 * caller has not written anything through it yet) file it created is best-effort unlinked, so a
 * refused open leaves no half-open resource and no stray empty file where a symlink pointed.
 */
export function openNewOutputFileSafely(
  root: string,
  candidatePath: string,
  permittedDir: string,
): { fd: number; realPath: string } {
  const realPath = resolveRealOutputPath(root, candidatePath, permittedDir);

  // `openSync(..., "wx")` is `O_CREAT | O_EXCL`: it refuses outright to follow an existing symlink
  // (or any existing file at all) at the LEAF, closing the leaf half of the race before verification
  // even starts. It does nothing about a symlink in a PARENT component — POSIX `open` follows
  // directory-component symlinks transparently, same as every other path-based call — which is
  // exactly the gap the two checks below exist to close.
  const fd = openSync(realPath, "wx");

  try {
    // `assertNoSymlinkComponents` must be given a ROOT and a TARGET from the SAME tree — both
    // lexical, or both real — or `relative()` between them walks out through unrelated ancestors and
    // reports a false positive the moment either side crosses a symlinked ancestor of its own (macOS
    // resolves `/var` to `/private/var`, so a lexical root under `/var` paired with the already-real
    // `realPath` below produces exactly that false positive). `realPath` is already real (it came
    // from `resolveRealOutputPath`), so the root re-resolved here is real too, before either is used.
    const realRootNow = realpathOfNearestExisting(resolve(root));
    assertRootSafe(realRootNow, permittedDir);
    assertNoSymlinkComponents(realRootNow, realPath);
    const realDirNow = realpathSync.native(dirname(realPath));
    if (!isWithin(realRootNow, realDirNow)) {
      throw new OutputPathError(
        `refusing to write output path outside the resolved root "${realRootNow}": ${realDirNow}`,
      );
    }

    const fdStat = fstatSync(fd);
    const pathStat = lstatSync(realPath);
    if (!pathStat.isFile() || fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
      throw new OutputPathError(
        `refusing to write through a file descriptor whose target no longer matches the path it was opened from: ${realPath}`,
      );
    }
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // Best-effort: if closing the fd itself fails, the ORIGINAL verification error is still what
      // the caller needs to see, not a close failure.
    }
    try {
      unlinkSync(realPath);
    } catch {
      // Best-effort: `realPath` may not be the file we just opened (a symlinked component can make
      // this unlink land somewhere unexpected, or the entry may already be gone) — either way the
      // ORIGINAL verification error above is what propagates, never a cleanup failure.
    }
    throw err;
  }

  return { fd, realPath };
}

/**
 * Opens, verifies, and writes `content` through the fd `openNewOutputFileSafely` proves safe, then
 * closes it — the primitive `src/ingest/archive.ts` uses for its two never-rewritten leaves (see that
 * function's own doc comment for why archive writes stay `wx`-only rather than using
 * `overwriteOutputFile`'s replace-in-place semantics). Returns the REAL path written.
 *
 * Any throw past the open — verification failure, or a failure of `writeSync` itself — closes the fd
 * and best-effort unlinks `realPath` so no partial file survives, then rethrows the ORIGINAL error
 * (mirrors `overwriteOutputFile`'s existing cleanup shape below: a cleanup failure must never mask
 * the real one). `openNewOutputFileSafely` already cleans up after itself on a verification failure,
 * so this only has its own cleanup to do for a failure in the write step.
 */
export function writeNewOutputFile(
  root: string,
  candidatePath: string,
  permittedDir: string,
  content: string,
): string {
  const { fd, realPath } = openNewOutputFileSafely(root, candidatePath, permittedDir);
  try {
    // Looped, not a single `writeSync`. `fs.writeSync` issues ONE `write(2)` and returns the number
    // of bytes it actually wrote; it does not retry the remainder the way `writeFileSync` does
    // internally. A short write is rare for a regular file but permitted (a signal arriving
    // mid-write, some filesystems), and swallowing one here would silently truncate an archived
    // capture while every check above still reported success — a corrupted privacy artifact that
    // looks exactly like a good one. Writing an EMPTY file (`content === ""`, a legitimate zero-byte
    // capture) correctly performs no write at all, since `written` starts at the length.
    const buffer = Buffer.from(content, "utf8");
    let written = 0;
    while (written < buffer.length) {
      written += writeSync(fd, buffer, written, buffer.length - written);
    }
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // Best-effort — see openNewOutputFileSafely's identical cleanup comment above.
    }
    try {
      unlinkSync(realPath);
    } catch {
      // Best-effort — see openNewOutputFileSafely's identical cleanup comment above.
    }
    throw err;
  }
  closeSync(fd);
  return realPath;
}

/**
 * `lstat`s `path` (never follows a link itself) and throws `OutputPathError` if a SYMLINK sits at
 * this exact leaf — refused unconditionally, before anything is written there.
 *
 * Pulled out of `overwriteOutputFile` so a multi-leaf writer (`writeTeamDossier`'s `index.html` +
 * `index.md` pair, `writeSectionalsDossiers`' top-level pair) can validate EVERY leaf it is about to
 * touch before writing ANY of them (Codex adversarial review, PR #38, Finding 3 [medium]). Before
 * this split, the symlink-leaf refusal only ever ran inside `overwriteOutputFile` itself, at WRITE
 * time — so a caller writing two leaves in sequence (html then md) could already have written the
 * FIRST leaf to disk by the time the SECOND leaf's symlink threw, leaving a fresh, half-written
 * dossier behind despite `writeTeamDossier`'s doc-comment promise that "a refusal leaves nothing on
 * disk". `overwriteOutputFile` below still calls this itself too — cheap (one `lstat`), and it keeps
 * `overwriteOutputFile`'s own doc-comment contract true for any caller that writes a single leaf
 * directly rather than going through a multi-leaf pre-validation pass first.
 */
export function assertLeafWritable(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new OutputPathError(`refusing to write through a symlinked output path: ${path}`);
  }
}

/**
 * Writes `content` to `path` such that an existing SYMLINK at the leaf is never followed — refused
 * outright — while a plain existing file (the normal case for a writer whose output is rewritten in
 * place on every run, e.g. a dossier report) is safely replaced, and — the property this function
 * exists to guarantee — `path` is NEVER, even transiently, in a state where it names neither the old
 * content nor the new: readers see one or the other at every instant, never absence.
 *
 * The PREVIOUS implementation unlinked whatever existed at `path` and only then created the
 * replacement (`writeFileSync(path, content, { flag: "wx" })`) — so a failure in that exact window
 * (disk full, a permission change mid-batch, anything that makes the create fail after the unlink
 * already succeeded) deleted a previously GOOD file and put nothing back (Codex adversarial review,
 * PR #38 round 3, Finding 2 [high]). The fix removes that window rather than narrowing it: `content`
 * is written in full to a uniquely-named temporary file IN THE SAME DIRECTORY (so the later rename
 * stays on one filesystem, which is what makes it atomic — the two would otherwise need a `COPY`),
 * created with `wx` so the create step itself cannot silently follow a link, and ONLY THEN is
 * `renameSync` used to swing `path` from its old content straight to the new in one atomic
 * filesystem operation (POSIX `rename(2)`'s defining guarantee) — the destination is either fully
 * replaced or not touched at all, with nothing in between and no window where it is briefly absent.
 *
 * `assertLeafWritable` still runs TWICE, not once: immediately (as before, so a symlinked leaf is
 * refused before any write is attempted at all — the temp file is not even created), and again right
 * before the rename. That second check closes the one TOCTOU window this rewrite introduces:
 * `writeFileSync`ing the temp file's full content is not instantaneous, so a symlink could in
 * principle be planted at `path` during that window; re-checking immediately before the rename means
 * the no-follow guarantee holds at the actual moment `path` is touched, not just at the start.
 *
 * Beside that second `assertLeafWritable` sits a second, independent check (#33): the temp file's
 * create (`writeFileSync(..., { flag: "wx" })`) is already effectively fd-anchored — `wx` refuses to
 * follow anything already at that leaf, so there is no pre-existing inode for a symlink swap to
 * impersonate the way `openNewOutputFileSafely` above has to guard against. What is NOT anchored is
 * the rename that follows: `renameSync` is a path operation with no `renameat`, so it re-resolves
 * `dir` from scratch exactly like `writeFileSync` did. If `dir` itself is swapped for a symlink
 * during the (non-instantaneous) write, the rename would silently move the temp file's real content
 * into whatever the symlink points to instead of where this call started. `dir`'s realpath is
 * captured before the write and re-checked here, immediately before the rename, so a swap in that
 * window is refused rather than carried out. This narrows, but does not erase, the window: it is
 * still a check-then-use path operation, just with the check moved as close to the use as pure Node
 * allows.
 *
 * Any failure past the first `writeFileSync` — the second `assertLeafWritable`, the directory
 * re-verification, or `renameSync` itself — cleans up the now-orphaned temp file (best-effort; if
 * even the cleanup fails, the ORIGINAL error is still what propagates, not the cleanup failure) and
 * rethrows, leaving `path` exactly as it was found: this function still throws in every case the
 * previous version did, it just no longer deletes anything on the way to throwing.
 *
 * What this function does NOT claim: it guarantees atomicity for THIS ONE leaf. A caller writing
 * several leaves (`writeTeamDossier`'s html+md pair, `writeSectionalsDossiers`' whole batch) gets
 * "each individual file is atomically replaced", not "the whole batch commits or rolls back
 * together" — a commit-time failure partway through a multi-leaf batch can still leave some leaves
 * updated and others not (each one, individually, in either its old or new state, never both/neither
 * — but the BATCH as a set can be partially updated). See `writeSectionalsDossiers`'s own doc comment
 * in `src/report/write.ts` for the precise, non-overclaiming statement of what a batch call
 * guarantees.
 */
export function overwriteOutputFile(path: string, content: string): void {
  assertLeafWritable(path);
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.tmp-${randomBytes(8).toString("hex")}`);
  const realDirAtStart = realpathOfNearestExisting(dir);
  try {
    // The write is INSIDE the cleanup block, not before it. `writeFileSync` is not all-or-nothing:
    // it can create the file and then fail partway through (ENOSPC, EIO, a full quota), leaving a
    // truncated `.<leaf>.tmp-*` behind forever. With the write outside, that debris was unreachable
    // by the cleanup below — and the test for this path threw BEFORE the temp existed, so it passed
    // whether or not cleanup covered the case (Codex adversarial review, PR #38 round 4).
    writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
    assertLeafWritable(path);
    if (realpathOfNearestExisting(dir) !== realDirAtStart) {
      throw new OutputPathError(
        `refusing to rename into an output directory that changed during the write: ${dir}`,
      );
    }
    renameSync(tempPath, path);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort: the temp file may already be gone, or removable for some unrelated reason.
      // Either way the ORIGINAL error above is what the caller needs to see, not a cleanup failure.
    }
    throw err;
  }
}
