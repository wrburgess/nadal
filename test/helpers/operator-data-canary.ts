import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A run-scoped canary over the repository's operator-owned directories (#173).
 *
 * WHY THIS AND NOT A STATIC SCAN. The first attempt at guarding this class was a scanner over the
 * test sources looking for `rmSync(resolve("raw"), …)`. Two contractor-review waves on PR #174 found
 * four ways past it, and every one of them was the same underlying fact: a regex cannot lex
 * JavaScript. `resolve(".", "raw")` and `join(process.cwd(), "raw")` were not the spellings it
 * matched; `rmSync(join("raw", "archive)"))` truncated at a `)` inside a string literal; a `//`
 * inside a string made the comment stripper swallow live code. Each fix moved the hole rather than
 * closing it, which is the documented signal that the predicate is wrong rather than incomplete.
 *
 * So this checks the INVARIANT instead of a textual proxy for it: whatever the suite does, by
 * whatever mechanism — `rmSync`, `fs.promises.rm`, a spawned `rm -rf`, a stray `writeFileSync` — no
 * file that existed in `raw/` or `reports/` before the run may be missing or altered after it.
 * There is nothing here to out-spell.
 *
 * WHAT THE FINGERPRINT ACTUALLY PROVES, stated at its real strength rather than at the strength the
 * word "altered" suggests: a file's size and mtime, and a directory's existence. That catches
 * deletion, truncation and rewrite. It does NOT catch a same-length edit that restores the original
 * mtime — content hashing would, at the cost of re-reading every watched byte on every run, and the
 * class this exists to stop is destruction rather than forgery.
 *
 * ADDITIONS ARE DELIBERATELY IGNORED. The suite currently leaves two archived files behind under a
 * concurrent-environment race (#175); that is pollution, tracked separately, and failing on it here
 * would conflate two different defects and make this canary red for a reason it is not about.
 */

const WATCHED = ["raw", "reports"];

type Fingerprint = Map<string, string>;

function fingerprint(): Fingerprint {
  const seen: Fingerprint = new Map();
  for (const dir of WATCHED) {
    const root = resolve(dir);
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true, encoding: "utf8" });
    } catch (err) {
      // ONLY "it is not there" means there is nothing to protect. Contractor review, PR #174
      // wave 3: swallowing every error made EACCES/EIO/ENOTDIR silently drop a whole directory
      // from protection — the error path doing something weaker than the happy path.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    // The ROOT ITSELF is a watched entry. Contractor review, PR #174 wave 3 [must-fix]: recording
    // only regular files made the disappearance of an empty protected directory invisible, which
    // was precisely the class the teardowns could still cause.
    seen.set(dir, "dir");
    for (const entry of entries) {
      const path = join(root, entry);
      try {
        const stat = statSync(path);
        seen.set(join(dir, entry), stat.isDirectory() ? "dir" : `${stat.size}:${stat.mtimeMs}`);
      } catch {
        continue; // vanished between listing and stat — a concurrent writer, not our business
      }
    }
  }
  return seen;
}

let before: Fingerprint = new Map();

export function setup(): void {
  before = fingerprint();
}

export function teardown(): void {
  const after = fingerprint();
  const damage: string[] = [];

  for (const [path, mark] of before) {
    const now = after.get(path);
    if (now === undefined) damage.push(`DELETED  ${path}`);
    else if (now !== mark) damage.push(`MODIFIED ${path} (${mark} -> ${now})`);
  }

  if (damage.length > 0) {
    throw new Error(
      `The test suite destroyed operator data (#173). ${damage.length} of ${before.size} watched ` +
        `files did not survive the run:\n  ${damage.slice(0, 20).join("\n  ")}` +
        (damage.length > 20 ? `\n  …and ${damage.length - 20} more` : ""),
    );
  }
}
