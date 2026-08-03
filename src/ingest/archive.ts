import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertOutputPathSafe, writeNewOutputFileSet } from "../fs/output-root.js";

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
  /** `string | Uint8Array` (#18): every caller before #18 archived HTML text; a scorecard photo
   * archives its raw bytes through the identical writer. */
  body: string | Uint8Array;
  httpStatus: number;
  /** File extension for the archived leaf, including the leading dot. Defaults to `".html"` —
   * every caller before #18 archived HTML; a binary capture (a scorecard photo) passes its real
   * extension so the archived leaf round-trips byte-identical off disk. */
  extension?: string;
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
 * The capture and its provenance record are a PAIR — a raw page with no record of where it came
 * from, when, or at what status is not a usable archive entry — so what a refusal leaves on disk is
 * stated below as separate numbered parts, because the single sentence that used to stand here ("a
 * refusal writes NOTHING — not even the leaf file, half the pair") was true of only the first of
 * them and was read as covering all of them (#65). **No count appears in this sentence on purpose:**
 * it said "three" while the list said 1–4 from the moment a part was added, which is this PR's
 * enumeration-vs-structure lesson arriving a fifth time, in a numeral (Codex adversarial review,
 * PR #83, merge-gate round). A prose count above an enumerated list is stale-by-construction — the
 * list is its own count:
 *
 * 1. **A pre-check refusal writes nothing.** Every path this function would touch is checked with
 *    `assertArchivePathSafe` BEFORE anything is written, so a rejected `sourceSet`/`slug`/root never
 *    reaches a write call at all. Unchanged.
 * 2. **A write-time refusal rolls the pair back.** The per-leaf writer's own refusals — the
 *    post-open verification, an `O_CREAT|O_EXCL` open that fails, ENOSPC/EIO in the write loop —
 *    happen AFTER the pre-checks, so a failure on the SECOND leaf used to leave the first one
 *    orphaned. Both leaves now go through `writeNewOutputFileSet`, which removes the already-written
 *    ones (via the inode-verified unlink, never a bare `unlinkSync`) and rethrows the original error.
 * 3. **The pair is still NOT atomic, and this comment does not claim it is.** Rollback is
 *    best-effort. What the *write set* can leave behind is stated **once**, in
 *    `writeNewOutputFileSet`'s doc comment — deliberately not restated here, because four review
 *    rounds on PR #83 each falsified a *re-enumeration* of it. Read it there.
 * 4. **This function's own residue, which that list does not cover and by design cannot.**
 *    `mkdirSync(dir)` below runs BEFORE the write set and is never undone, so a refusal — including
 *    one on the very first leaf — leaves an empty `{rawRoot}/{sourceSet}/` directory that was not
 *    there before. It is deliberately not cleaned up: it is empty, it sits inside the already
 *    validated root, the next successful archive to the same source set reuses it, and removing a
 *    directory another process may be concurrently writing into is a worse failure than leaving an
 *    empty one. Documented here rather than in the writer because the writer never learns this
 *    directory exists — the residual contract there is bounded by ownership, and this is ours
 *    (Codex adversarial review, PR #83, final merge-gate pass).
 */
export function archivePage(input: ArchivePageInput): string {
  const fetchedAt = nextTimestamp();
  const stamp = fetchedAt.replace(/[:.]/g, "-");
  const dir = join(rawRoot(), input.sourceSet);
  // Defaults to ".html" — every caller before #18 archived HTML; a scorecard photo (#18) passes
  // its own extension so the archived leaf keeps a real, openable file suffix.
  const extension = input.extension ?? ".html";
  const leafPath = join(dir, `${input.slug}-${stamp}${extension}`);
  const provenancePath = `${leafPath}.provenance.json`;

  assertArchivePathSafe(leafPath);
  assertArchivePathSafe(provenancePath);

  mkdirSync(dir, { recursive: true });

  const provenance: ArchiveProvenance = {
    sourceUrl: input.url,
    fetchedAt,
    httpStatus: input.httpStatus,
    redacted: false,
    // `input.body` may already be raw bytes (#18) — byte-length is `Buffer.byteLength` for a
    // string (UTF-8 encoded length, not JS `.length`) and the buffer's own `.byteLength` otherwise.
    bytes: typeof input.body === "string" ? Buffer.byteLength(input.body, "utf8") : input.body.byteLength,
  };

  // ONE call carrying both leaves, rather than two independent writes (#65). Every field of
  // `provenance` above derives from `input` and the timestamp — never from the capture write's result
  // — so the whole set is constructible before anything touches the disk, which is what lets the pair
  // be handed over as a set at all. The leaf goes FIRST so the order matches the pair's natural
  // reading order; rollback undoes it in reverse.
  //
  // `writeNewOutputFileSet` writes each leaf through `writeNewOutputFile`'s own primitive, so
  // everything below describes what still happens PER LEAF — unchanged by #65, which added only the
  // cross-leaf rollback. That primitive (src/fs/output-root.ts — shared with `src/report/write.ts` so
  // this hardening lives in exactly one place) resolves the REAL destination the same way
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
  // CLOSED (#33), stated as narrowly as the code actually enforces it: un-redacted capture content
  // can no longer be REDIRECTED to a different inode outside the validated real root by a
  // directory-component swap between resolution and the write — the bytes go through an fd, which is
  // a handle bound to one inode, not a path string that gets re-resolved. This is a claim about
  // redirection, NOT a claim that the bytes are reachable only from inside the root (see REMAINING). The proof also SAMPLES the link count, so a fd that has
  // already acquired a second name outside the root by verification time (a hard link) is refused too,
  // not just a redirected path (Codex adversarial review, PR #48).
  // REMAINING, same review round 2: that link-count check is a point-in-time sample, so a hard link
  // created AFTER it passes is not caught. Like the pre-open window below, it is not closable in pure
  // Node — both would need control this runtime does not expose.
  // REMAINING: an actor who wins the PRE-OPEN window — before the per-leaf writer ever calls
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
  writeNewOutputFileSet(rawRoot(), DEFAULT_RAW_DIR, [
    { candidatePath: leafPath, content: input.body },
    { candidatePath: provenancePath, content: JSON.stringify(provenance, null, 2) },
  ]);

  // The REAL path is what we wrote through (that is the containment property); the LOGICAL path is
  // what we hand back. They differ whenever the root legitimately resolves elsewhere — on macOS a
  // temp dir under /var realpaths to /private/var — and a caller that configured TN_RAW_PATH should
  // be told where it asked for the file, not shown a path it never named. Both name the same bytes.
  return leafPath;
}
