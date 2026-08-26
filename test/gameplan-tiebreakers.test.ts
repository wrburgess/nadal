import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME_PLAN = join(REPO_ROOT, "docs", "index.html");

/**
 * Issue #190. `docs/index.html` is the shipped Springfield game plan, served at
 * gameplan.kc.tennis. It states the tournament's two tiebreaker ladders — the standings order and
 * the one applied inside a single team match — and it must state each of them EXACTLY ONCE, on the
 * `#tiebreakers` page.
 *
 * That rule is not aesthetic. The page carried a second copy of the standings ladder for months,
 * inside The Springfield Five, and the two disagreed: the duplicate ended "a method determined by
 * the championships committee" where the tournament's own list ends "winner of the Doubles 1
 * court". A reader settling a tie by the wrong copy gets a different answer.
 *
 * De-duplicating it produced the same defect a second time in one pull request. The edit that
 * removed the duplicate table replaced it with a summary reading "ties break on individual courts
 * first, then sets, then games" — which silently drops head-to-head at #2. A contractor review
 * caught it. **A partial restatement is still a restatement**, and paraphrasing an ordered list is
 * how one gets written by accident: the author who has just deleted the long copy is the one most
 * likely to summarise it for the reader in the same breath.
 *
 * So this file guards the invariant rather than either instance:
 *
 *   1. No passage outside `#tiebreakers` chains two ladder steps together.
 *   2. The two ordinal facts The Springfield Five DOES assert — that individual matches are the
 *      first line and games the fourth — match the rows of the ladder it cites. A citing page that
 *      may name a step must not be free to name the wrong one.
 *   3. The ladders themselves are complete and in the tournament's order.
 *
 * Rule 2 is the one that earns this file. It was claimed in a findings entry before it existed;
 * a second contractor review caught the claim outrunning what the repository enforced, which is
 * the reason the check is here and not in a scratch script.
 */

function gamePlan(): string {
  return readFileSync(GAME_PLAN, "utf8");
}

function tiebreakerSection(html: string): string {
  const start = html.indexOf('<section class="page" id="tiebreakers">');
  expect(start, "the #tiebreakers section must exist").toBeGreaterThan(-1);
  const end = html.indexOf("\n</section>", start);
  expect(end, "the #tiebreakers section must be closed").toBeGreaterThan(start);
  return html.slice(start, end);
}

function outsideTiebreakers(html: string): string {
  const section = tiebreakerSection(html);
  const start = html.indexOf(section);
  return html.slice(0, start) + html.slice(start + section.length);
}

// Two steps of a ladder named together. Any one of these phrases on its own is a single fact and
// allowed — "the first line is individual matches" is an argument, not a copy of the list. Chained,
// they are the list, and a summary of an ordered list is a copy that can disagree with it.
const STEP_CHAINS = [
  "then sets",
  "then games",
  "sets, then",
  "games, then",
  "fewest sets",
  "fewest games",
  "fewest number of",
  "courts first",
];

// The standings ladder, in the tournament's order, as issued 2026-08-25. Row 6 is the one a
// previous copy got wrong.
const STANDINGS = [
  "Individual matches.",
  "Head-to-head.",
  "Sets.",
  "Games.",
  "Game win %.",
  "Doubles 1.",
];

// The match ladder. Four courts, so row 1 settles it at 4-0 or 3-1 and the rest is for 2-2.
const MATCH = ["Individual matches.", "Sets.", "Games.", "Game win %.", "Doubles 1."];

describe("the game plan states each tiebreaker ladder exactly once", () => {
  it("names no two ladder steps together outside #tiebreakers", () => {
    const outside = outsideTiebreakers(gamePlan()).toLowerCase();
    const found = STEP_CHAINS.filter((chain) => outside.includes(chain));
    expect(
      found,
      `these phrases chain two ladder steps outside #tiebreakers, which restates the order the ` +
        `page is supposed to cite: ${found.join(", ")}. State the consequence, not the sequence — ` +
        `or move the passage onto #tiebreakers.`,
    ).toEqual([]);
  });

  it("carries both ladders, complete and in the tournament's order", () => {
    const section = tiebreakerSection(gamePlan());
    const standings = section.slice(0, section.indexOf("Match Tiebreakers"));
    const match = section.slice(section.indexOf("Match Tiebreakers"));

    for (const [i, step] of STANDINGS.entries()) {
      expect(standings, `standings tiebreaker ${i + 1} must read "${step}"`).toContain(
        `<td class="stat">${i + 1}</td><td><span class="fld">${step}</span>`,
      );
    }
    for (const [i, step] of MATCH.entries()) {
      expect(match, `match tiebreaker ${i + 1} must read "${step}"`).toContain(
        `<td class="stat">${i + 1}</td><td><span class="fld">${step}</span>`,
      );
    }
  });

  it("ends both ladders on the Doubles 1 court, and nowhere else", () => {
    const html = gamePlan();
    const phrase = "Winner of the Doubles 1 court.";
    const total = html.split(phrase).length - 1;
    const inSection = tiebreakerSection(html).split(phrase).length - 1;
    expect(total, "the Doubles 1 tiebreaker appears once per ladder").toBe(2);
    expect(inSection, "both are inside #tiebreakers").toBe(2);
  });
});

describe("The Springfield Five cites the ladder without drifting from it", () => {
  it("points at #tiebreakers rather than restating the order", () => {
    expect(gamePlan()).toContain(
      '<a href="#tiebreakers">Tiebreakers</a> carries both orders in full',
    );
  });

  // The page is allowed to name a single step as an argument. It is not allowed to name the wrong
  // one — so each ordinal it asserts is pinned to the row it claims to be.
  it.each([
    { claim: "The first line of the standings list is", ordinal: 1, step: "Individual matches." },
    { claim: "are the fourth line", ordinal: 4, step: "Games." },
  ])("its '$claim' claim matches standings row $ordinal", ({ claim, ordinal, step }) => {
    const html = gamePlan();
    expect(html, `The Springfield Five should still make the "${claim}" claim`).toContain(claim);
    expect(
      tiebreakerSection(html),
      `it names standings step ${ordinal}, so row ${ordinal} must be "${step}"`,
    ).toContain(`<td class="stat">${ordinal}</td><td><span class="fld">${step}</span>`);
  });
});
