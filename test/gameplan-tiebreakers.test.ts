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
 *   1. No passage anywhere outside `#tiebreakers` chains two ladder steps together.
 *   2. Inside The Springfield Five — the section that cites the ladder, and where both defects
 *      occurred — at most ONE ladder step may be named at all, the one its argument turns on.
 *   3. The ordinal facts The Springfield Five does assert — that individual matches are the first
 *      line and games the fourth — match the rows of the ladder it cites. A citing page that may
 *      name a step must not be free to name the wrong one.
 *   4. The ladders themselves are complete and in the tournament's order.
 *
 * **What these checks do NOT amount to**, since overstating a guard is the exact class this file
 * exists for. Rule 1 is a fixed phrase list, so a restatement phrased around it — "head-to-head is
 * second, sets are third" — passes it. That gap is why rule 2 exists and why it is a whitelist
 * rather than another blacklist: inside the section where the defect actually recurs, naming a
 * second step fails whatever words it uses. Outside that section the coverage really is only the
 * phrase list, and the rest of the document is prose about tennis that says "sets" and "games"
 * constantly — a proximity rule tried against it returned four false positives out of five hits.
 *
 * Rule 3 is the one that earns this file. It was claimed in a findings entry before it existed; a
 * contractor review caught the claim outrunning what the repository enforced, which is the reason
 * the check is here and not in a scratch script.
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

function springfieldFive(html: string): string {
  const start = html.indexOf('<section class="page" id="field">');
  expect(start, "the #field section must exist").toBeGreaterThan(-1);
  const end = html.indexOf("\n</section>", start);
  expect(end, "the #field section must be closed").toBeGreaterThan(start);
  return html.slice(start, end);
}

function plainText(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

// The standings ladder's rows, selected structurally rather than by searching the section's text.
// A substring search over the whole section is satisfied by the literal appearing ANYWHERE in it —
// a duplicate row, a stale copy, an HTML comment — while the row a reader actually sees says
// something else. That was the second contractor finding on PR #201, against the first repair of
// the assertion below.
function standingsRows(html: string): string[] {
  const section = tiebreakerSection(html);
  const standings = section.slice(0, section.indexOf("Match Tiebreakers"));
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(standings)?.[1];
  expect(body, "the standings ladder must have a <tbody>").toBeDefined();
  return [...(body ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1])
    .filter((cells): cells is string => cells !== undefined)
    .map((cells) => cells.trim());
}

// A ladder step named in the ladder's OWN vocabulary. Ordinary tennis prose about sets and games
// does not match these — "fewest games" and "game win %" are the list's phrasing, not a report's.
// Checked against the live document when this was written: The Springfield Five contained exactly
// one hit, "individual matches", and every other section zero.
const LADDER_STEP_NAMES: ReadonlyArray<readonly [string, RegExp]> = [
  ["individual matches", /individual match(?:es)?\b/i],
  ["head-to-head", /head-?to-?head/i],
  ["sets", /\bfewest (?:number of )?sets\b|\bsets lost\b/i],
  ["games", /\bfewest (?:number of )?games\b|\bgames lost\b/i],
  ["game win %", /game win ?%|game winning percentage/i],
  ["doubles 1", /doubles 1\b/i],
];

// The single step The Springfield Five's argument turns on, and is licensed to name.
const CITED_STEP = "individual matches";

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

  // The tournament's step 2 reads "winner of head-to-head match if all teams play each other",
  // which is reproduced verbatim — adding a condition it does not contain would be inventing a
  // rule, and that is what this pins.
  //
  // Issue #190 also had the page gloss the wording, because it names no winner in a circular
  // three-way result (A beat B, B beat C, C beat A) while reading as though the step resolves the
  // tie; that gloss was pinned here too. **The HC removed the gloss in #200** — one of four prose
  // blocks cut from the book in that pass — so the two assertions that required it are gone. The
  // page now reproduces the step and says nothing about the branch it does not cover. That is a
  // deliberate editorial choice, recorded in docs/findings.md rather than re-litigated here; what
  // survives is the guard that matters either way, that the wording stays the tournament's.
  // "Exactly" means the row a reader sees, and it took two contractor rounds to make the assertion
  // say that. Round 1: a `toContain` on the sentence alone passes a row with extra wording bolted
  // on either side. Round 2: pinning the full cell as a substring is still a search of the whole
  // section, so a duplicate or commented-out copy of the correct row satisfies it while the live
  // one drifts. Selecting row 2 out of the ladder's `<tbody>` and comparing the whole row is what
  // finally matches the title.
  it("keeps step 2's wording exactly as the tournament issued it", () => {
    const two = standingsRows(gamePlan()).filter((r) => r.startsWith('<td class="stat">2</td>'));
    expect(two, "the standings ladder must have exactly one row 2").toHaveLength(1);
    expect(two[0], "step 2's row must be the tournament's wording and nothing else").toBe(
      '<td class="stat">2</td><td><span class="fld">Head-to-head.</span> ' +
        "Winner of the head-to-head match, if all tied teams play each other.</td>",
    );
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
    // Scoped to the section, not the document: a citation anywhere else would satisfy a
    // whole-document search while this section quietly carried its own copy of the ladder.
    expect(springfieldFive(gamePlan())).toContain(
      '<a href="#tiebreakers">Tiebreakers</a> carries both orders in full',
    );
  });

  it("names at most the one ladder step its argument turns on", () => {
    const text = plainText(springfieldFive(gamePlan()));
    const named = LADDER_STEP_NAMES.filter(([, pattern]) => pattern.test(text)).map(([n]) => n);
    const extra = named.filter((n) => n !== CITED_STEP);
    expect(
      extra,
      `The Springfield Five cites the ladder; it must not re-list it. These ladder steps are ` +
        `named here beyond the one it argues from ("${CITED_STEP}"): ${extra.join(", ")}. ` +
        `Two steps named together is the list, however it is worded — put it on #tiebreakers.`,
    ).toEqual([]);
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
