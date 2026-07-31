import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertAllowListed, loadStandIns, loadVocabulary } from "../tools/fixture-policy.js";

/**
 * CI enforcement for issue #28: "the vocabulary is complete" is a fact the suite checks on every
 * run, not a claim a human has to remember to re-verify. Every committed fixture must reduce to
 * zero unclassified atoms against its source's committed vocabulary — if a future fixture
 * re-capture (or a hand-edit) introduces content that is neither synthetic, structural, nor
 * already vocabulary-listed, this test fails instead of silently shipping it.
 */

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const VOCAB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "fixture-vocabulary");

const standIns = loadStandIns(join(VOCAB_ROOT, "stand-ins.txt"));

const FIXTURES: { source: "tennisrecord" | "usta"; name: string }[] = [
  { source: "tennisrecord", name: "profile.html" },
  { source: "tennisrecord", name: "player-stats.html" },
  { source: "tennisrecord", name: "match-history.html" },
  { source: "tennisrecord", name: "match-history-empty.html" },
  { source: "tennisrecord", name: "team.html" },
  { source: "usta", name: "profile-wtn-both.html" },
  { source: "usta", name: "profile-wtn-doubles-only.html" },
];

/**
 * Explicit timeout, not vitest's 5s default. `assertAllowListed` tokenizes the whole fixture and
 * checks every atom against the vocabulary, so these cases are legitimately CPU-heavy: the two
 * `usta` fixtures measure ~3.9s and ~4.5s ALONE on an idle machine — 78% and 91% of the default
 * budget before a single sibling test competes for a core. Under a full parallel run the larger one
 * crosses 5s and reddens a suite in which nothing is actually wrong (observed on PR #46, whose only
 * connection to this file was adding six test files' worth of load; the file, `tools/`, and every
 * fixture it reads were byte-identical to `main`).
 *
 * Raised rather than left to flake, and deliberately NOT "fixed" by trimming what the check covers:
 * the completeness guarantee is the point of issue #28 — a slow true check beats a fast one with a
 * hole in it. 30s is ~6.6x the slowest observed case, so it still fails fast on a genuine hang
 * rather than hanging CI.
 */
const VOCABULARY_CHECK_TIMEOUT_MS = 30_000;

describe("fixture allow-list policy — vocabulary completeness", () => {
  it.each(FIXTURES)("$source/$name has zero unclassified atoms", ({ source, name }) => {
    const html = readFileSync(join(FIXTURE_ROOT, source, name), "utf8");
    const vocabulary = loadVocabulary(join(VOCAB_ROOT, `${source}.txt`), standIns);

    expect(() => assertAllowListed(html, { standIns, vocabulary })).not.toThrow();
  }, VOCABULARY_CHECK_TIMEOUT_MS);
});
