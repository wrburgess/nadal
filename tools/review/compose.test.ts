import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  composeSummons,
  extractSeverityFramework,
  MAX_DIFF_BYTES,
  PERMANENT_LENS,
  type SummonsInput,
} from "./compose.ts";
import { SEVERITIES } from "./validate.ts";

const base: SummonsInput = {
  prNumber: 99,
  subject: "test subject",
  commit: "a".repeat(40),
  lenses: ["does the parser fail loudly on a reshaped table?"],
  severityFramework: "| must-fix | blocks shipping |",
  acceptedEntries: [],
  diff: "diff --git a/x b/x\n",
  reviewerName: "Codex CLI",
};

test("the summons carries all five standards, the commit, and the role pointer", () => {
  const s = composeSummons(base);
  for (const needle of [
    base.commit,
    "Severity framework",
    base.lenses[0]!,
    PERMANENT_LENS,
    "Required output shape",
    "AGENTS.md",
    "diff --git",
  ]) {
    assert.ok(s.includes(needle), `summons is missing: ${needle}`);
  }
});

test("the permanent lens is present even with an empty lens list", () => {
  const s = composeSummons({ ...base, lenses: [] });
  assert.ok(s.includes(PERMANENT_LENS));
});

test("an empty accepted register reads as none accepted to date", () => {
  const s = composeSummons({ ...base, acceptedEntries: [] });
  assert.match(s, /none accepted to date/i);
});

test("accepted entries are carried verbatim", () => {
  const s = composeSummons({
    ...base,
    acceptedEntries: ["- risk X, accepted on PR #9"],
  });
  assert.ok(s.includes("risk X, accepted on PR #9"));
});

test("an oversized diff is a loud error, never a silent truncation", () => {
  const big = "x".repeat(MAX_DIFF_BYTES + 1);
  assert.throws(() => composeSummons({ ...base, diff: big }), /diff/i);
});

// Upstream, this pair read deuce's own files — `sds/02-review-and-findings.md` for the severity
// framework and `findings/accepted.md` for the accepted register — and so guarded the live copies
// against drift. #146 recorded both guards as permanently unavailable here. **Half of that is no
// longer true, and #155 is why.**
//
// The severity framework now lives in `config/review.md`, a file this repository owns, so the
// drift guard is BACK — the live-file test below is it, and it is the same shape `roster.test.ts`
// and `lenses.test.ts` already use over that file.
//
// The accepted register's guard stays gone, and differently: nadal's register is closed `residual`
// issues on the tracker (PROJECT.md -> Findings-Log Discipline), so there is no file to drift
// against. What replaces it is a probe rather than a parse — see `accepted.ts`, where a label that
// does not exist throws instead of reading as an empty register.
test("extractSeverityFramework stops at the next heading, whatever follows it", () => {
  const config = [
    "## Lens-set size",
    "",
    "3 lenses",
    "",
    "## Severity framework",
    "",
    "| must-fix | blocks shipping |",
    "| should-fix | fix before merge |",
    "| note | author's discretion |",
    "",
    "## Fix-verification",
    "",
    "two passes, then escalate",
    "",
  ].join("\n");
  const s = extractSeverityFramework(config);
  assert.ok(s.includes("must-fix"));
  assert.ok(s.includes("should-fix"));
  assert.ok(s.includes("note"));
  assert.ok(!s.includes("Fix-verification"), "ran past the section boundary");
  assert.ok(!s.includes("Lens-set size"), "started before the section boundary");
});

test("extractSeverityFramework fails loudly when the section is absent", () => {
  assert.throws(() => extractSeverityFramework("## Review\n\nno framework here\n"), /severity/i);
});

// The restored drift guard. `config/review.md` is now the severity source that `summon.ts` reads at
// runtime, so a section renamed or removed there breaks the summons — this fails first, and says so.
test("the live config/review.md carries a parseable severity framework", () => {
  const live = readFileSync(new URL("../../config/review.md", import.meta.url), "utf8");
  const s = extractSeverityFramework(live);
  // The rating ladder — the scale a severity is chosen on, bridged to the returned
  // vocabulary by config/gates.md since #146.
  for (const severity of ["Critical", "High", "Medium", "Low"]) {
    assert.ok(s.includes(severity), `the live severity framework is missing: ${severity}`);
  }
  // Past its OWN heading — the section necessarily opens with one, so the
  // boundary check has to start after it or it can never pass.
  const afterOwnHeading = s.slice(s.indexOf("\n"));
  assert.ok(
    !afterOwnHeading.includes("\n## "),
    "the extracted section ran past its own boundary and carries a neighbouring section",
  );
});

// The self-contradiction guard (#155). `composeSummons` heads the injected framework with
// "use only this vocabulary" and then, two sections later, demands `must-fix | should-fix | note`
// in the required output shape — which `validateReview` enforces on return. If the declared
// framework does not carry the vocabulary the validator enforces, the summons contradicts itself
// and EVERY review comes back nonconforming: one re-summons, then exit 4, on every run.
//
// No parser test can see this. Both files parse perfectly while disagreeing.
test("the live severity framework carries every severity the validator enforces", () => {
  const live = readFileSync(new URL("../../config/review.md", import.meta.url), "utf8");
  const framework = extractSeverityFramework(live);
  for (const severity of SEVERITIES) {
    assert.ok(
      framework.includes(severity),
      `the summons would demand "${severity}" in its output shape while the framework it sends ` +
        `never names it — the reviewer cannot conform to both`,
    );
  }
});
