/**
 * Bootstrap a per-source vocabulary file (`tools/fixture-vocabulary/<source>.txt`) for the
 * allow-list policy in `tools/fixture-policy.ts` (issue #28).
 *
 * Runs the policy's own skeleton reduction over a set of fixtures and reports every DISTINCT
 * skeleton that survives elision. A skeleton that is NOT name-shaped (does not read as two or
 * more consecutive capitalised words) is safe to auto-write: it is boilerplate left over after
 * eliding every stand-in and structural run — a URL path segment, a table header word, stray
 * punctuation-stripped text — and carries no personal identity by construction. A name-shaped
 * skeleton is NEVER auto-written here: `tools/fixture-policy.ts`'s `loadVocabulary()` refuses to
 * load one without an immediately preceding `# reviewed: <reason>` line, and that reason has to be
 * written by a human who actually read the skeleton — templating it would be exactly the
 * rubber-stamping this policy exists to prevent.
 *
 * Usage:
 *   tsx tools/bootstrap-vocabulary.ts --fixtures <path> [<path> ...] --stand-ins <path> --out <path>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeSkeleton, extractAtoms, loadStandIns, requiresReview } from "./fixture-policy.js";

export type BootstrapReport = {
  total: number;
  nameShaped: string[];
  autoWritten: string[];
};

/** Compute every distinct skeleton across `fixturePaths`, partitioned by name-shape. */
export function bootstrapVocabulary(fixturePaths: string[], standInsPath: string): BootstrapReport {
  const standIns = loadStandIns(standInsPath);
  const skeletons = new Set<string>();

  for (const path of fixturePaths) {
    const html = readFileSync(path, "utf8");
    for (const atom of extractAtoms(html)) {
      const skeleton = computeSkeleton(atom.value, standIns);
      if (skeleton !== "") skeletons.add(skeleton);
    }
  }

  const nameShaped: string[] = [];
  const autoWritten: string[] = [];
  for (const skeleton of skeletons) {
    (requiresReview(skeleton) ? nameShaped : autoWritten).push(skeleton);
  }
  nameShaped.sort();
  autoWritten.sort();

  return { total: skeletons.size, nameShaped, autoWritten };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/** Every value following `--fixtures` up to the next `--flag`. */
function collectFixtures(argv: string[]): string[] {
  const i = argv.indexOf("--fixtures");
  if (i === -1) throw new Error("missing required flag --fixtures");
  const values: string[] = [];
  for (let j = i + 1; j < argv.length && !argv[j]?.startsWith("--"); j++) {
    values.push(argv[j] as string);
  }
  if (values.length === 0) throw new Error("--fixtures requires at least one path");
  return values;
}

export async function main(argv: string[]): Promise<BootstrapReport> {
  const fixtures = collectFixtures(argv);
  const standInsPath = arg(argv, "stand-ins");
  const out = arg(argv, "out");
  if (standInsPath === undefined) throw new Error("missing required flag --stand-ins");
  if (out === undefined) throw new Error("missing required flag --out");

  const report = bootstrapVocabulary(fixtures, standInsPath);

  writeFileSync(
    out,
    `# Auto-written by tools/bootstrap-vocabulary.ts — non-name-shaped skeletons only.\n` +
      `# Name-shaped skeletons (${report.nameShaped.length}) must be added BY HAND below, each\n` +
      `# immediately preceded by its own "# reviewed: <reason>" line.\n` +
      report.autoWritten.map((s) => `${s}\n`).join(""),
  );

  if (report.nameShaped.length > 0) {
    console.log(
      `${report.nameShaped.length} name-shaped skeleton(s) require manual "# reviewed:" disposition in ${out}:`,
    );
    for (const skeleton of report.nameShaped) console.log(`  ${skeleton}`);
  }
  console.log(
    `${report.autoWritten.length} skeleton(s) auto-written, ${report.nameShaped.length} pending manual review (${report.total} total).`,
  );

  return report;
}

// Only auto-run when this file is executed directly, not when imported by
// test/tools-bootstrap-vocabulary.test.ts — see the identical guard in capture-fixture.ts.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main(process.argv.slice(2));
}
