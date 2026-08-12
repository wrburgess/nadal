import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPTED_LABEL,
  classifyLabelProbe,
  parseRegisterListing,
  readAcceptedRegister,
  type RegisterSource,
  type ResidualIssue,
} from "./accepted.ts";

/** A source that answers from memory, so every scenario below is exact rather
 *  than whatever the tracker happens to hold on the day the suite runs. */
function fake(
  labelExists: boolean,
  issues: ResidualIssue[],
  onList?: () => never,
): RegisterSource {
  return {
    labelExists: () => labelExists,
    listClosed: () => {
      if (onList) onList();
      return issues;
    },
  };
}

test("carries one bullet per residual, numbered, in the order given", () => {
  const entries = readAcceptedRegister(
    fake(true, [
      { number: 118, title: "RESIDUAL: the missing-database message calls a dangling symlink" },
      { number: 104, title: "RESIDUAL: ARCHITECTURE.md's path guard is best-effort" },
    ]),
  );
  assert.deepEqual(entries, [
    "- #118 — RESIDUAL: the missing-database message calls a dangling symlink",
    "- #104 — RESIDUAL: ARCHITECTURE.md's path guard is best-effort",
  ]);
});

// The distinction this whole module exists for. Both of these produce an empty
// list from `gh`, at exit code 0, and they mean opposite things: one is "nothing
// has been accepted yet", the other is "the question of what was accepted was
// never asked". Only the second is a defect, and nothing but the label probe
// separates them.
test("a present label with no residuals is a legitimate empty register", () => {
  assert.deepEqual(readAcceptedRegister(fake(true, [])), []);
});

test("an ABSENT label throws, and never reads as an empty register", () => {
  assert.throws(
    () => readAcceptedRegister(fake(false, [])),
    (err: Error) => {
      assert.match(err.message, new RegExp(ACCEPTED_LABEL));
      // Pinned because the whole defect is a *quiet* empty: if this ever
      // returns instead of throwing, the summons tells the reviewer that
      // nothing has been settled and re-opens every residual on the record.
      assert.match(err.message, /never as an empty register|refusing/i);
      return true;
    },
  );
});

test("the label probe runs BEFORE the listing, so a missing label costs no query", () => {
  let listed = false;
  const source: RegisterSource = {
    labelExists: () => false,
    listClosed: () => {
      listed = true;
      return [];
    },
  };
  assert.throws(() => readAcceptedRegister(source));
  assert.equal(listed, false, "listed against a label that does not exist");
});

test("a failing listing propagates untouched, never caught into an empty list", () => {
  assert.throws(
    () =>
      readAcceptedRegister(
        fake(true, [], () => {
          throw new Error("gh: authentication token expired");
        }),
      ),
    /authentication token expired/,
  );
});

test("a title carrying table, code or newline characters is carried verbatim", () => {
  const nasty = "RESIDUAL: `a|b` splits\non a newline";
  const entries = readAcceptedRegister(fake(true, [{ number: 7, title: nasty }]));
  assert.deepEqual(entries, [`- #7 — ${nasty}`]);
});

test("the default label is the one PROJECT.md's findings discipline names", () => {
  assert.equal(ACCEPTED_LABEL, "residual");
});

// --- parseRegisterListing: what the tracker hands back, and what is refused ---

test("a well-formed listing becomes rows", () => {
  const rows = parseRegisterListing('[{"number":118,"title":"a"},{"number":104,"title":"b"}]');
  assert.deepEqual(rows, [
    { number: 118, title: "a" },
    { number: 104, title: "b" },
  ]);
});

test("an empty listing is rows, not an error — the label was present to get here", () => {
  assert.deepEqual(parseRegisterListing("[]"), []);
});

test("a listing at its row limit is refused as truncated, never returned short", () => {
  const atLimit = JSON.stringify(
    Array.from({ length: 5 }, (_, i) => ({ number: i, title: `t${i}` })),
  );
  assert.throws(() => parseRegisterListing(atLimit, ACCEPTED_LABEL, 5), /truncated/i);
  // One below the limit is the boundary's other side, and must pass.
  assert.equal(parseRegisterListing(atLimit, ACCEPTED_LABEL, 6).length, 5);
});

test("a payload that is not an array is refused", () => {
  assert.throws(() => parseRegisterListing('{"number":1}'), /not an array/i);
});

test("a row missing its number or title is refused, never rendered as undefined", () => {
  assert.throws(() => parseRegisterListing('[{"title":"no number"}]'), /number\/title/);
  assert.throws(() => parseRegisterListing('[{"number":1}]'), /number\/title/);
  assert.throws(() => parseRegisterListing('[{"number":"1","title":"t"}]'), /number\/title/);
});

test("malformed JSON propagates rather than reading as an empty register", () => {
  assert.throws(() => parseRegisterListing("not json"));
});

// --- classifyLabelProbe: three outcomes, and the third is the one that matters ---

test("exit 0 means the label is present", () => {
  assert.equal(classifyLabelProbe(0, ""), true);
});

test("a 404 is the ONLY nonzero that means absent", () => {
  assert.equal(classifyLabelProbe(1, "gh: Not Found (HTTP 404)"), false);
});

test("any other failure throws rather than passing itself off as absence", () => {
  // The distinction the whole probe exists for: an expired token must not be
  // reported as "no residuals have been accepted".
  assert.throws(
    () => classifyLabelProbe(1, "gh: authentication token expired"),
    /other than its absence/,
  );
  assert.throws(() => classifyLabelProbe(1, "API rate limit exceeded"), /other than its absence/);
  assert.throws(() => classifyLabelProbe(null, "killed by signal"), /other than its absence/);
});
