import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The archive root every raw page and provenance record is written under. Mirrors `dbPath()` in
 * `src/db/client.ts`: an explicit env var when set, a repo-relative default otherwise.
 */
export function rawRoot(): string {
  return process.env.TN_RAW_PATH ?? "raw";
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
  const resolvedCandidate = resolve(candidatePath);
  const rel = relative(resolvedRoot, resolvedCandidate);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new ArchivePathError(
      `refusing to write archive path outside raw root "${resolvedRoot}": ${resolvedCandidate}`,
    );
  }
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
  writeFileSync(htmlPath, input.body, "utf8");

  const provenance: ArchiveProvenance = {
    sourceUrl: input.url,
    fetchedAt,
    httpStatus: input.httpStatus,
    redacted: false,
    bytes: Buffer.byteLength(input.body, "utf8"),
  };
  writeFileSync(provenancePath, JSON.stringify(provenance, null, 2), "utf8");

  return htmlPath;
}
