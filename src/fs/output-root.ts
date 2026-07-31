import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
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
function isGitTracked(resolvedPath: string, cwd: string): GitTrackedResult {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", resolvedPath], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    // git's error messages are TRANSLATED when it is built with NLS and the environment asks for
    // another language — under `LC_ALL=fr_FR.UTF-8` the stderr below reads "erreur : le
    // spécificateur de chemin '…' ne correspond à aucun fichier connu de git", and the English
    // match then fails. Since an unmatched message resolves to "indeterminate" and the caller
    // FAILS CLOSED, that would refuse every capture and every dossier write on any machine not
    // running in English, while passing every test on one that is. That is the PR #31 round-3
    // defect exactly ("a privacy control that refuses everything looks identical to a privacy
    // control that works, right up until someone runs it"), so the locale is pinned rather than
    // assumed: `LC_ALL=C` selects git's untranslated strings, and `LANGUAGE` is cleared because it
    // overrides LC_ALL for message translation specifically and would otherwise win.
    env: { ...process.env, LC_ALL: "C", LANGUAGE: "" },
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
 * place on every run, e.g. a dossier report) is safely replaced. A bare `{ flag: "wx" }` write (the
 * no-follow idiom `archivePage` uses for its never-rewritten, timestamped filenames) cannot serve a
 * rewrite-in-place caller: `wx` refuses whenever ANYTHING already exists at the leaf, symlink or not,
 * which would break every second run. So: `assertLeafWritable` first (never follows a link itself);
 * a symlink found there is refused unconditionally, before any write is attempted; anything else
 * that exists (an ordinary file left by a prior run) is removed, and ONLY THEN is the fresh file
 * created with `wx` — so the create step itself never silently follows a link either, it always
 * either makes a brand-new leaf or throws.
 */
export function overwriteOutputFile(path: string, content: string): void {
  assertLeafWritable(path);
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined) unlinkSync(path);
  writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
}
