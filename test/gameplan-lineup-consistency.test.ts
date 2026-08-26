import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOOK = join(REPO_ROOT, "docs", "index.html");

/**
 * Issue #191. `docs/index.html` states each match's lineup TWICE — once in the
 * self-scout's four-column summary, once in that match's own card — and the two
 * are independently hand-authored. They drifted: the summary carried a
 * results-first proposal from 2026-08-20 while the cards carried the lineups
 * actually signed, and they disagreed on FOURTEEN OF SIXTEEN courts. Nobody
 * noticed until the captain read a usage figure derived from the stale copy and
 * said it was wrong.
 *
 * The fix corrected the summary. It did NOT remove the duplication — a contractor
 * review made exactly that point, that a corrected duplicate is still a duplicate
 * and can drift again. Both copies earn their place (one is an at-a-glance grid,
 * the other is a per-court page carrying each pair's record), so the answer is to
 * hold them equal by a check rather than by care.
 *
 * WHAT THIS ASSERTS is agreement between the two copies, not correctness against
 * the captain's card. Nothing in this repository holds the book to that; the
 * captain does. What this catches is the failure that actually happened — one copy
 * edited, the other left behind.
 *
 * WHEN THE BOOK IS RETIRED after the tournament, delete this file with it. It is
 * deliberately written to fail loudly rather than skip if `docs/index.html` is
 * gone, because a test that silently passes when its subject vanishes is the
 * "certified an invariant it could not see" shape this repository keeps recording.
 */

export type Lineup = { court: string; players: string[] };

const SURNAMES = [
  "Burgess", "Zingg", "Jacobs", "Johnson", "Bierman", "Merritt",
  "Martin", "Morris", "Chettiar", "Plungkhen", "Halksworth",
] as const;

/** Surnames present in a fragment, sorted — the comparable form of "who is on this court". */
export function surnamesIn(fragment: string): string[] {
  const plain = fragment.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
  return SURNAMES.filter((s) => new RegExp(`\\b${s}\\b`).test(plain)).sort();
}

/**
 * The self-scout summary: one row per court, one column per match, in playing order.
 * Returns [{court, players}] flattened in (court, match) order.
 */
export function parseSummary(html: string): Lineup[] {
  const at = html.indexOf('<div class="sub">The Four Cards</div>');
  if (at === -1) throw new Error("self-scout summary not found: the 'The Four Cards' heading is gone");
  const table = html.slice(at, html.indexOf("</table>", at));
  const out: Lineup[] = [];
  for (const row of table.matchAll(/<tr><td class="stat">(S1|D1|D2|D3)<\/td>(.*?)<\/tr>/gs)) {
    const cells = [...row[2]!.matchAll(/<td>(.*?)<\/td>/gs)].map((c) => c[1]!);
    if (cells.length !== 4) {
      throw new Error(`summary row ${row[1]} has ${cells.length} match columns, expected 4`);
    }
    cells.forEach((cell, i) => out.push({ court: `${row[1]}#${i}`, players: surnamesIn(cell) }));
  }
  if (out.length !== 16) throw new Error(`summary yielded ${out.length} courts, expected 16`);
  return out;
}

/**
 * The four match cards. Each court block is `<div class="court">`, a `<div class="slot">`
 * naming the court, then an `<h3>` naming our side.
 *
 * The slot div is why this is not a two-line regex: a first version assumed the h3
 * followed the court div directly and returned SIXTEEN EMPTY CELLS — a uniform total
 * failure, which is a broken probe rather than a finding. Hence `expectedCourts`.
 */
export function parseCards(html: string): Lineup[] {
  const ids = ["card-ia", "card-stl", "card-ok", "card-ne"];
  const starts = ids.map((id) => {
    const at = html.indexOf(`id="${id}"`);
    if (at === -1) throw new Error(`match card ${id} not found`);
    return { id, at };
  }).sort((a, b) => a.at - b.at);

  const out: Lineup[] = [];
  starts.forEach(({ id }, n) => {
    const from = starts[n]!.at;
    const to = n + 1 < starts.length ? starts[n + 1]!.at : html.length;
    const section = html.slice(from, to);
    const blocks = [
      ...section.matchAll(/<div class="court">\s*<div class="slot">(.*?)<\/div>\s*<h3>(.*?)<\/h3>/gs),
    ];
    if (blocks.length !== 4) {
      throw new Error(`card ${id} yielded ${blocks.length} courts, expected 4`);
    }
    for (const b of blocks) {
      const court = b[1]!.replace(/<[^>]+>/g, "").replace(/&middot;.*$/, "").trim();
      out.push({ court: `${court}#${n}`, players: surnamesIn(b[2]!) });
    }
  });
  return out;
}

describe("the game plan states each lineup twice, and the two copies must agree", () => {
  it("parses sixteen courts from each copy — a parser that finds nothing must not read as agreement", () => {
    const html = readFileSync(BOOK, "utf8");
    expect(parseSummary(html)).toHaveLength(16);
    expect(parseCards(html)).toHaveLength(16);
    for (const entry of [...parseSummary(html), ...parseCards(html)]) {
      expect(entry.players.length, `${entry.court} named nobody`).toBeGreaterThan(0);
    }
  });

  it("the self-scout summary and the four match cards name the same men on every court", () => {
    const html = readFileSync(BOOK, "utf8");
    const summary = parseSummary(html);
    const cards = parseCards(html);

    const key = (l: Lineup) => l.court;
    const byCourt = new Map(cards.map((l) => [key(l), l.players]));

    const disagreements: string[] = [];
    for (const s of summary) {
      const c = byCourt.get(s.court);
      if (!c) {
        disagreements.push(`${s.court}: present in the summary, absent from the cards`);
      } else if (c.join(",") !== s.players.join(",")) {
        disagreements.push(`${s.court}: summary has [${s.players}], the card has [${c}]`);
      }
    }
    expect(
      disagreements,
      `The self-scout summary and the match cards disagree. They are two hand-authored copies of one fact; ` +
        `whichever you just edited, edit the other. See issue #191 — this drifted to 14 of 16 courts once.\n` +
        disagreements.join("\n"),
    ).toEqual([]);
  });

  it("catches a drifted copy — the guard can fail, proven on synthetic input", () => {
    const a: Lineup[] = [{ court: "D1#0", players: ["Burgess", "Johnson"] }];
    const b: Lineup[] = [{ court: "D1#0", players: ["Burgess", "Merritt"] }];
    const byCourt = new Map(b.map((l) => [l.court, l.players]));
    const drift = a.filter((x) => byCourt.get(x.court)!.join(",") !== x.players.join(","));
    expect(drift).toHaveLength(1);
  });

  it("surnamesIn is order-insensitive, so 'A & B' and 'B & A' compare equal", () => {
    expect(surnamesIn("<h3>Randy Burgess &amp; Mark Johnson</h3>")).toEqual(["Burgess", "Johnson"]);
    expect(surnamesIn("<h3>Mark Johnson &amp; Randy Burgess</h3>")).toEqual(["Burgess", "Johnson"]);
  });
});
