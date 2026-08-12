import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROSE_LENSES,
  checkLensSelection,
  parseLensMenu,
  parseLensSetSize,
} from "./lenses.ts";

const live = readFileSync(new URL("../../config/review.md", import.meta.url), "utf8");

// Two guards were dropped here, and both read files nadal does not hold (#146).
//
// 1. This one pinned PROSE_LENSES against `sds/02-review-and-findings.md` -> *Verifying prose*.
//    Canon is read at its source and never vendored (CLAUDE.md), so there is no local copy to pin
//    against. PROSE_LENSES is now an unguarded copy of four canon phrases: if canon rewords them,
//    nothing here notices.
// 2. The menu/class-index one-to-one guard, which sat just below the live-menu test. It required
//    every menu entry
//    to link to a heading in `findings/classes.md`. nadal has no class index at all — its lens menu
//    derives from recorded defect classes described in prose (PROJECT.md -> Review Lenses), and its
//    findings live in `docs/findings.md` as a flat log. So the invariant it enforced does not exist
//    here yet, and enforcing a link to an absent file would be a check that certifies nothing.
//
// What survives is every assertion that needs no file: the interrogative rule over the live menu,
// the declared size, and the whole of checkLensSelection's behaviour.
test("a prose lens is summonable for a prose subject with an empty menu", () => {
  const errors = checkLensSelection([PROSE_LENSES[0]!], [], 3, true);
  assert.deepEqual(errors, []);
});

test("a prose lens on a code subject is refused — no menu bypass", () => {
  const errors = checkLensSelection([PROSE_LENSES[0]!], [], 3, false);
  assert.ok(errors.some((e) => e.includes("prose")));
});

test("prose lenses still respect the declared lens-set size", () => {
  const errors = checkLensSelection([...PROSE_LENSES], [], 3, true);
  assert.ok(errors.some((e) => e.includes("3")));
});

test("every lens on the live menu is stated as an interrogative", () => {
  const menu = parseLensMenu(live);
  assert.ok(menu.length > 0, "the live menu carries no lenses");
  for (const lens of menu) {
    assert.ok(lens.endsWith("?"), `lens is not stated as an interrogative: ${lens}`);
  }
});

test("the live declaration's lens-set size is 3", () => {
  assert.equal(parseLensSetSize(live), 3);
});

test("real entries beside a stale empty marker are a contradiction, and loud", () => {
  const md = [
    "## Lens menu",
    "",
    "- **Empty — zero lenses.**",
    "- `does any guard fail open?`",
    "",
  ].join("\n");
  assert.throws(() => parseLensMenu(md), /contradict/i);
});

test("entries parse once the menu has them", () => {
  const md = ["## Lens menu", "", "- `does any guard fail open?`", ""].join("\n");
  assert.deepEqual(parseLensMenu(md), ["does any guard fail open?"]);
});

test("a menu section in an unrecognized shape fails loudly", () => {
  const md = "## Lens menu\n\n- some prose that is neither the empty marker nor an entry\n";
  assert.throws(() => parseLensMenu(md), /menu/i);
});

test("a declaration without a lens-set size fails loudly", () => {
  assert.throws(() => parseLensSetSize("# nothing\n"), /size/i);
});

test("choosing no lenses is always within bounds — the permanent lens rides along", () => {
  assert.deepEqual(checkLensSelection([], [], 3, false), []);
});

test("a lens not on the menu is refused, by name", () => {
  const errors = checkLensSelection(["does any guard fail open?"], [], 3, false);
  assert.ok(errors.some((e) => e.includes("does any guard fail open?")));
});

// `--lens ""` reaches here as an empty string, and the refusal used to render
// with a hole where the lens should be — a caller passing several flags could
// not tell which one was rejected. Found by driving the CLI on #157.
test("an empty lens is refused and still says which flag it was", () => {
  const errors = checkLensSelection([""], ["a"], 3, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /\(empty\)/);
});

test("a selection over the declared size is refused, naming the bound", () => {
  const menu = ["a", "b", "c", "d"];
  const errors = checkLensSelection(["a", "b", "c", "d"], menu, 3, false);
  assert.ok(errors.some((e) => e.includes("3")));
});

test("a within-bounds selection from the menu passes", () => {
  const menu = ["a", "b", "c", "d"];
  assert.deepEqual(checkLensSelection(["a", "c"], menu, 3, false), []);
});
