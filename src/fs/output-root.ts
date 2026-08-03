import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
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

/** Closes `fd`, swallowing any error: a cleanup failure must never mask the real one. */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best-effort. The ORIGINAL error is what the caller needs to see, not a close failure.
  }
}

/**
 * Removes `path` only when a check immediately beforehand saw it naming the exact inode `ours`
 * describes — the file the caller just created and is now abandoning. "Immediately beforehand" is the
 * whole of the guarantee; see SCOPE below.
 *
 * A bare `unlinkSync(path)` here was a data-loss hole (Codex adversarial review, PR #48, [critical]).
 * `unlink` resolves directory components like every other path call, so when verification failed
 * *because* a parent was swapped for a symlink, the cleanup followed that symlink and deleted
 * whatever sat at the corresponding name in the attacker-chosen directory — an unrelated file, in a
 * location this module had just refused to write to. A guard that destroys a file outside the root
 * while refusing to write one there is not a smaller version of the same control; it is a different,
 * worse bug.
 *
 * Comparing `{dev, ino}` first makes the deletion self-limiting: where the check sees anything other
 * than our own inode — an attacker's file, a replacement, a directory — the path is left alone and the
 * original error propagates. The common case that used to destroy data (a symlink swap already in
 * place when cleanup runs) is now skipped rather than followed, and the cost of skipping is a stray
 * empty file inside a directory the attacker already controls.
 *
 * SCOPE (Codex adversarial review, PR #48 round 2): the `lstat`-then-`unlink` pair is itself two path
 * operations, so an actor who swaps the leaf in the interval BETWEEN them can still have the
 * replacement deleted. This narrows the window rather than closing it — `unlinkat` on a trusted
 * directory handle is not reachable from pure Node — and the failure direction is the safe one:
 * anything that is not a confirmed inode match is skipped, so the guard errs toward leaving files
 * alone. So this is a large reduction in blast radius, NOT a guarantee that cleanup never deletes a
 * file it does not own — do not read the first line as promising that.
 */
function unlinkIfStillOurs(path: string, ours: { dev: number; ino: number }): void {
  try {
    const current = lstatSync(path);
    if (current.dev !== ours.dev || current.ino !== ours.ino) return;
    unlinkSync(path);
  } catch {
    // Best-effort: the entry may already be gone, or be unreadable. Either way the ORIGINAL error is
    // what propagates, never a cleanup failure.
  }
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
 * point cannot REDIRECT the fd — it is a handle, not a lookup — so the bytes this function's caller
 * writes through it cannot be REDIRECTED to a different inode outside the validated real root.
 *
 * That is deliberately narrower than "the bytes land only inside the root", and the difference is not
 * pedantry: a hard link created after the `nlink` sample below gives the SAME inode a second name,
 * which may be outside the root. Redirection is closed; exclusivity is sampled, not held.
 *
 * On ANY verification failure the newly-opened fd is closed and the (very likely empty, since the
 * caller has not written anything through it yet) file it created is best-effort unlinked, so a
 * refused open leaves no half-open resource and no stray empty file where a symlink pointed.
 */
export function openNewOutputFileSafely(
  root: string,
  candidatePath: string,
  permittedDir: string,
): { fd: number; realPath: string; openedStat: { dev: number; ino: number } } {
  const realPath = resolveRealOutputPath(root, candidatePath, permittedDir);

  // `openSync(..., "wx")` is `O_CREAT | O_EXCL`: it refuses outright to follow an existing symlink
  // (or any existing file at all) at the LEAF, closing the leaf half of the race before verification
  // even starts. It does nothing about a symlink in a PARENT component — POSIX `open` follows
  // directory-component symlinks transparently, same as every other path-based call — which is
  // exactly the gap the two checks below exist to close.
  const fd = openSync(realPath, "wx");

  // Captured IMMEDIATELY, before any check can fail: the cleanup path below needs the fd's identity
  // to prove that whatever `realPath` names at cleanup time is still the file this call created,
  // rather than an unrelated file an attacker has since arranged to sit there. `dev`/`ino` are fixed
  // for the life of an fd, so this snapshot stays valid however verification goes.
  const openedStat = fstatSync(fd);

  try {
    // Containment is checked BEFORE the component walk (Codex adversarial review, PR #48, [low]).
    // `assertNoSymlinkComponents` derives its walk from `relative(root, target)`, so if the root has
    // been repointed out from under `realPath` that relative path starts with `..` and the walk
    // wanders up through ancestors OUTSIDE the root, where it can throw something unrelated before
    // the containment refusal that actually describes the problem ever runs. Establishing
    // containment first means the walk only ever runs on a target genuinely underneath the root.
    //
    // Both sides must also come from the SAME tree — both lexical, or both real — or `relative()`
    // reports a false positive the moment either crosses a symlinked ancestor of its own (macOS
    // resolves `/var` to `/private/var`, so a lexical root under `/var` paired with the already-real
    // `realPath` produces exactly that). `realPath` is already real (it came from
    // `resolveRealOutputPath`), so the root re-resolved here is real too, before either is used.
    const realRootNow = realpathOfNearestExisting(resolve(root));
    assertRootSafe(realRootNow, permittedDir);
    const realDirNow = realpathSync.native(dirname(realPath));
    if (!isWithin(realRootNow, realDirNow)) {
      throw new OutputPathError(
        `refusing to write output path outside the resolved root "${realRootNow}": ${realDirNow}`,
      );
    }
    assertNoSymlinkComponents(realRootNow, realPath);

    const fdStat = fstatSync(fd);
    const pathStat = lstatSync(realPath);
    if (!pathStat.isFile() || fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
      throw new OutputPathError(
        `refusing to write through a file descriptor whose target no longer matches the path it was opened from: ${realPath}`,
      );
    }

    // The HARD-LINK bypass, and the reason inode identity alone is not containment (Codex
    // adversarial review, PR #48, [critical]). Everything above proves "the fd is what this path
    // names AT THIS INSTANT" — it does NOT prove "this path is the ONLY name the fd has", and cannot
    // prove it for the whole write (see the scope note below). An attacker who wins the
    // pre-open window (so the file is created through a symlinked component, OUTSIDE the root) can
    // then restore the real parent directory and hard-link that outside file back to `realPath`.
    // Every check above now passes honestly: no component is a symlink any more, and `{dev, ino}`
    // genuinely match — because it is the same inode, reachable under two names, one of them outside
    // the root. Writing through the fd would publish un-redacted content at the outside name.
    //
    // `nlink` discriminates exactly, and refuses no legitimate usage: `openSync(..., "wx")` is
    // `O_CREAT | O_EXCL`, so it only ever succeeds by CREATING the file, and a newly created regular
    // file has exactly one link. Any additional name therefore appeared after our open.
    //
    // SCOPE, narrower than it first reads (Codex adversarial review, PR #48 round 2): this is a
    // point-in-time observation. It catches a second name that exists WHEN THE CHECK RUNS — the
    // restored-parent relink described above, which otherwise passes every check honestly. It does
    // NOT make "this inode has one name" true for the DURATION of the write, and a link created after
    // this check returns is not caught. Keeping that property across the write would require writing
    // somewhere the actor cannot reach at all (a private staging directory) or `linkat`-level control
    // pure Node does not expose. Recorded as a residual in `docs/findings.md` rather than papered
    // over: a check whose comment claims a durable property it merely samples is the exact failure
    // this module has now shipped twice.
    if (fdStat.nlink !== 1) {
      throw new OutputPathError(
        `refusing to write through a file descriptor with ${fdStat.nlink} links — the file this call created ` +
          `has been given another name, which may lie outside the validated root: ${realPath}`,
      );
    }
  } catch (err) {
    closeQuietly(fd);
    unlinkIfStillOurs(realPath, openedStat);
    throw err;
  }

  return { fd, realPath, openedStat };
}

/**
 * Opens, verifies, and writes `content` through the fd `openNewOutputFileSafely` proves safe, then
 * closes it — the primitive `src/ingest/archive.ts` uses for its two never-rewritten leaves (see that
 * function's own doc comment for why archive writes stay `wx`-only rather than using
 * `overwriteOutputFile`'s replace-in-place semantics). Returns the REAL path written.
 *
 * `content` is `string | Uint8Array` (#18: a scorecard photo archives through this same writer) —
 * every path check, the `O_CREAT|O_EXCL` open, and the post-open verification above are unchanged
 * either way; only the bytes handed to the write loop differ.
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
  content: string | Uint8Array,
): string {
  return writeThroughVerifiedFd(root, candidatePath, permittedDir, content).realPath;
}

/**
 * The shared body of `writeNewOutputFile` above and `writeNewOutputFileSet` below — identical
 * behavior to what `writeNewOutputFile` did inline before the split, returning the created file's
 * `{dev, ino}` alongside the real path rather than discarding it.
 *
 * That identity is the whole reason for the extraction (#65). `unlinkIfStillOurs` — the ONLY safe way
 * to remove a leaf in this module, since a bare `unlinkSync` follows directory components and deletes
 * whatever an attacker-planted symlink resolves to (PR #48, [critical]) — needs the inode of the file
 * the caller created. A multi-leaf writer that has to undo an earlier leaf therefore needs that stat,
 * and `writeNewOutputFile`'s `string` return cannot carry it. Splitting rather than widening that
 * return keeps the exported signature (and every existing caller and test) untouched.
 */
function writeThroughVerifiedFd(
  root: string,
  candidatePath: string,
  permittedDir: string,
  content: string | Uint8Array,
): { realPath: string; openedStat: { dev: number; ino: number } } {
  const { fd, realPath, openedStat } = openNewOutputFileSafely(root, candidatePath, permittedDir);
  try {
    // Looped, not a single `writeSync`. `fs.writeSync` issues ONE `write(2)` and returns the number
    // of bytes it actually wrote; it does not retry the remainder the way `writeFileSync` does
    // internally. A short write is rare for a regular file but permitted (a signal arriving
    // mid-write, some filesystems), and swallowing one here would silently truncate an archived
    // capture while every check above still reported success — a corrupted privacy artifact that
    // looks exactly like a good one. Writing an EMPTY file (`content === ""`, a legitimate zero-byte
    // capture) correctly performs no write at all, since `written` starts at the length.
    //
    // `content` widened to `string | Uint8Array` (#18, a scorecard photo archived through this same
    // writer): encoded to a `Buffer` only when it is a string; a `Uint8Array` is copied through
    // as-is. Every check above and the loop below are unchanged either way — this widens WHAT is
    // written, never WHERE or HOW the destination is verified safe.
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    let written = 0;
    while (written < buffer.length) {
      const justWritten = writeSync(fd, buffer, written, buffer.length - written);
      // A zero (or nonsensical) return would make this loop spin forever, re-issuing the same
      // request that just made no progress and never yielding — a hung CLI rather than a failed one
      // (Codex adversarial review, PR #48, [medium]). `write(2)` returning 0 for a non-empty request
      // is not a state this code can make progress from, so it fails loudly instead. The loop cannot
      // reach here with an empty buffer: `written` already equals `buffer.length` at zero.
      if (!Number.isInteger(justWritten) || justWritten <= 0) {
        throw new OutputPathError(
          `refusing to continue writing after a write that made no progress ` +
            `(${String(justWritten)} bytes written at offset ${written} of ${buffer.length}): ${realPath}`,
        );
      }
      written += justWritten;
    }
  } catch (err) {
    closeQuietly(fd);
    unlinkIfStillOurs(realPath, openedStat);
    throw err;
  }
  closeSync(fd);
  return { realPath, openedStat };
}

/**
 * Writes a SET of leaves that only make sense together, undoing the ones already written if a later
 * one is refused (#65). Returns the real paths written, in the order given.
 *
 * `writeNewOutputFile` above handles ONE leaf: any failure past its open closes the fd and
 * best-effort unlinks the file it created (best-effort in the precise sense `unlinkIfStillOurs`
 * documents — an inode that is no longer ours is left alone, deliberately). What it cannot do is
 * speak for a SIBLING written by a separate call — and a caller writing a pair in sequence
 * (`src/ingest/archive.ts`: a raw capture plus its `.provenance.json` record) had exactly that gap.
 * Both PATHS were pre-validated together, so a pre-check refusal correctly wrote nothing; but the
 * refusals `writeNewOutputFile` raises at WRITE time — the post-open verification, an `O_CREAT|O_EXCL`
 * open that fails, ENOSPC/EIO in the write loop — happen after the first leaf is already on disk and
 * closed. The result was an un-redacted capture with no record of where it came from, when, or at what
 * status: not an escape (it stays inside the validated root) but a broken pairing invariant, and one
 * `archivePage`'s own doc comment claimed could not happen.
 *
 * Rollback walks the written leaves in REVERSE and removes each through `unlinkIfStillOurs`, never a
 * bare `unlinkSync` — see that function's doc comment for why the distinction is the difference
 * between a cleanup and a data-loss bug. The ORIGINAL error is what propagates; `unlinkIfStillOurs`
 * swallows its own failures, so a cleanup problem can never mask the real one.
 *
 * **What this does NOT provide, stated because the sentence it replaces overclaimed exactly here.**
 * The set is not atomic and this function does not make it so:
 *
 * - Rollback is BEST-EFFORT by construction. `unlinkIfStillOurs` deliberately skips any leaf whose
 *   inode no longer matches the one this call created — that skip is PR #48's fix, not a gap in
 *   this one — so an actor who has already replaced a written leaf keeps it.
 * - A crash, a `SIGKILL`, or a power loss between two leaves rolls back nothing at all. No
 *   userspace-only writer can promise otherwise.
 *
 * It also does NOT re-run `assertOutputPathSafe` on the leaves, exactly as `writeNewOutputFile` does
 * not: pre-validating the candidate paths stays CALLER policy (the layering is unchanged, not
 * forgotten). A caller writing a set should validate every path in it before calling, which is what
 * makes a pre-check refusal write nothing at all.
 */
export function writeNewOutputFileSet(
  root: string,
  permittedDir: string,
  leaves: ReadonlyArray<{ candidatePath: string; content: string | Uint8Array }>,
): string[] {
  const written: Array<{ realPath: string; openedStat: { dev: number; ino: number } }> = [];
  try {
    for (const leaf of leaves) {
      written.push(writeThroughVerifiedFd(root, leaf.candidatePath, permittedDir, leaf.content));
    }
  } catch (err) {
    // Reverse order, so a set whose leaves have any ordering relationship is undone the way it was
    // built. `unlinkIfStillOurs` never throws, so every leaf is attempted even if an earlier one
    // could not be removed.
    for (const leaf of [...written].reverse()) {
      unlinkIfStillOurs(leaf.realPath, leaf.openedStat);
    }
    throw err;
  }
  return written.map((leaf) => leaf.realPath);
}

/**
 * The READ-side pre-filter for `openInputFileSafely` below: validates that `candidatePath` names an
 * existing, non-symlinked regular file inside `root` — a cheap, clearly-messaged rejection for the
 * common cases (outside the root, a symlinked leaf, a missing root) before anything is opened.
 *
 * NOT sufficient alone (Codex adversarial review, round 6, rated Critical — the finding that
 * corrected this file's ORIGINAL doc comment here, which called the gap below "a residual" when it
 * is in fact the whole vulnerability): every check in this function is a PATHNAME check, and a
 * pathname can be re-pointed after this function returns and before the caller's own
 * `readFileSync`/`statSync` reopens it. Two concrete ways that bites: (1) a HARDLINK inside `root`
 * to an outside file — `lstat` reports an ordinary regular file, because a hardlink genuinely IS
 * that file's inode under a second name; no pathname check, however careful, can see the other name.
 * (2) A swap (to a symlink, to a different file, to a bigger one) in the window between this
 * function returning and the caller's next syscall. Both are closed only by opening the file and
 * verifying the DESCRIPTOR (`openInputFileSafely`), never by checking the path again — see that
 * function's own doc comment for the reasoning this one used to (wrongly) claim as sufficient.
 */
function assertInputPathSafe(candidatePath: string, root: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidatePath);

  let realRoot: string;
  try {
    realRoot = realpathSync.native(resolvedRoot);
  } catch {
    throw new OutputPathError(`refusing: the configured source root does not exist: ${resolvedRoot}`);
  }

  const leafStat = lstatSync(resolvedCandidate, { throwIfNoEntry: false });
  if (leafStat === undefined) {
    throw new OutputPathError(`refusing an unreadable source path: ${resolvedCandidate}`);
  }
  if (leafStat.isSymbolicLink()) {
    throw new OutputPathError(`refusing a symlinked source path: ${resolvedCandidate}`);
  }
  if (!leafStat.isFile()) {
    throw new OutputPathError(`refusing a non-regular-file source path: ${resolvedCandidate}`);
  }

  // Same rule as the write side's `assertNoSymlinkComponents`: no DIRECTORY component between the
  // root and the leaf may be a symlink either — checked on the lexical pair first, exactly like
  // `resolveRealOutputPath` does, before the real-root containment check below.
  assertNoSymlinkComponents(resolvedRoot, resolvedCandidate);

  const realDir = realpathSync.native(dirname(resolvedCandidate));
  if (!isWithin(realRoot, realDir)) {
    throw new OutputPathError(`refusing source path outside root "${realRoot}": ${resolvedCandidate}`);
  }

  return resolvedCandidate;
}

/**
 * The fd-anchored read primitive (#18, Codex adversarial review round 6, rated Critical) — the read
 * side's counterpart to `openNewOutputFileSafely` above, and the fix for the gap the PREVIOUS
 * version of this file shipped as an accepted "residual": `assertInputPathSafe` validates a PATHNAME
 * and then hands the caller back a string, which the caller then reopens by name — check-then-use,
 * and a hardlink defeats the "check" half entirely rather than merely racing it (`lstat` on a
 * hardlinked path reports an ordinary regular file; there is no pathname-level test that can tell
 * "the only name" from "one of several names, one of which may be outside the root").
 *
 * This closes it the way `openNewOutputFileSafely` already closes the equivalent write-side gap:
 * open the file ONCE, then verify everything through the resulting file descriptor, never through
 * the path string again. A descriptor is bound to an inode for its whole lifetime; nothing that
 * happens to the pathname after the open can change what this function (or its caller) is actually
 * reading.
 *
 * 1. **The pre-open check still runs** (`assertInputPathSafe`) — cheap, clearly-messaged, and closes
 *    the common cases before an open is even attempted.
 * 2. **The open itself refuses to follow a leaf symlink** (`O_NOFOLLOW`), closing the leaf half of
 *    the check-then-open race at the SYSCALL level rather than by re-checking a path afterward.
 * 3. **The containment check is repeated against a FRESH real-root/real-directory resolution**,
 *    mirroring `openNewOutputFileSafely`'s own post-open re-verification: a root or parent directory
 *    repointed in the window between the pre-check and the open is caught here, not assumed away.
 * 4. **The descriptor's inode is compared against a pre-open `lstat` of the same path.** A mismatch
 *    means the path was swapped for a DIFFERENT file in the window between the check and the open —
 *    detected rather than silently followed, the same property `openNewOutputFileSafely` gets from
 *    comparing its own pre/post-open stats.
 * 5. **`nlink !== 1` is refused unconditionally.** This is the hardlink close, and it is exactly
 *    `openNewOutputFileSafely`'s own link-count check, carried over rather than reinvented: a file
 *    with more than one name cannot be shown to have no OTHER name outside the root, no matter how
 *    carefully the one name we were given is checked.
 *
 * Returns the open, verified descriptor — callers MUST read through it (never re-open the path) and
 * close it when done.
 */
export function openInputFileSafely(root: string, candidatePath: string): { fd: number; realPath: string } {
  const resolvedCandidate = assertInputPathSafe(candidatePath, root);

  // Taken as close to the open as a separate syscall allows — narrows, but (as documented on
  // `openNewOutputFileSafely` above) cannot fully close, the window between this stat and the open.
  const preOpenStat = lstatSync(resolvedCandidate);

  const fd = openSync(resolvedCandidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);

  let realPath: string;
  try {
    const realRootNow = realpathSync.native(resolve(root));
    const realDirNow = realpathSync.native(dirname(resolvedCandidate));
    if (!isWithin(realRootNow, realDirNow)) {
      throw new OutputPathError(
        `refusing to read source path outside the resolved root "${realRootNow}": ${realDirNow}`,
      );
    }
    // Both sides of this walk must come from the SAME tree (both real here), or `relative()` inside
    // it reports a false positive the moment either crosses a symlinked ancestor of its own — macOS
    // resolves `/var` to `/private/var`, so a REAL root paired with a merely-resolved (not
    // realpath'd) candidate produces exactly that false escape (see `openNewOutputFileSafely`'s own
    // doc comment for the identical reasoning on the write side).
    realPath = join(realDirNow, basename(resolvedCandidate));
    assertNoSymlinkComponents(realRootNow, realPath);

    const fdStat = fstatSync(fd);
    if (!fdStat.isFile() || fdStat.dev !== preOpenStat.dev || fdStat.ino !== preOpenStat.ino) {
      throw new OutputPathError(
        `refusing to read through a file descriptor whose target no longer matches the path it was opened from: ${resolvedCandidate}`,
      );
    }

    // The hardlink close (see this function's own doc comment): `openSync` above only ever succeeds
    // by opening whatever inode the path named at that instant — it does not, and cannot, prove that
    // inode has no OTHER name. `nlink` is the only thing that can, and it is checked on the
    // DESCRIPTOR (never re-derived from a path) so nothing after the open can spoof it.
    if (fdStat.nlink !== 1) {
      throw new OutputPathError(
        `refusing to read through a file descriptor with ${fdStat.nlink} links — this file has another ` +
          `name, which cannot be shown to lie inside the validated root: ${resolvedCandidate}`,
      );
    }
  } catch (err) {
    closeQuietly(fd);
    throw err;
  }

  return { fd, realPath };
}

/**
 * Reads `fd` to EOF in bounded chunks, throwing the moment the running total exceeds `maxBytes` —
 * never trusting a prior `statSync`, which describes whatever the path named at THAT instant, not
 * necessarily what the descriptor is actually delivering now (Codex adversarial review round 6: a
 * file swapped for a larger one, or one that grows, between a `statSync` size check and a later
 * `readFileSync` defeats a cap enforced that way entirely). Reading in chunks rather than one
 * `readFileSync(fd)` call also means a file far over the cap is never loaded into memory in full —
 * the read is abandoned as soon as the cap is crossed, however large the remainder is.
 */
export function readBoundedFromFd(fd: number, maxBytes: number): Buffer {
  const CHUNK_BYTES = 64 * 1024;
  const chunk = Buffer.alloc(CHUNK_BYTES);
  const collected: Buffer[] = [];
  let total = 0;
  for (;;) {
    const bytesRead = readSync(fd, chunk, 0, CHUNK_BYTES, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw new OutputPathError(`refusing to read past the ${maxBytes}-byte limit`);
    }
    collected.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(collected);
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
 * **This path is deliberately NOT held to `writeNewOutputFile`'s standard, and must not be described
 * as if it were** (Codex adversarial review, PR #48, [critical], severity disputed down to a
 * disclosure fix — the residual was already documented, but "both callers inherit the fix" read as
 * full closure). A swap landing between this re-check and `renameSync` — including the hard-link
 * variant, where the temp file is given a second name outside the root before the rename resolves
 * either — can still place dossier content outside the validated root. Closing it needs `renameat`
 * on a trusted directory handle, which pure Node does not expose, so the rename cannot be anchored
 * the way the archive writer's `open` is. The archive writer (un-redacted raw captures, the more
 * sensitive artifact) IS fully fd-anchored; the reports writer rewrites in place and therefore needs
 * a rename, and keeps this narrower window.
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
