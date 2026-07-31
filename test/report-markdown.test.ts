import { describe, expect, it } from "vitest";
import { escapeMarkdownCell, renderDossierMarkdown } from "../src/report/markdown.js";
import { buildDossier, buildEmptyDossier, buildPlayerProfile, buildTeamProfile } from "./helpers/dossier.js";

describe("escapeMarkdownCell", () => {
  it("escapes a pipe so it cannot be mistaken for a table delimiter", () => {
    expect(escapeMarkdownCell("A | B")).toBe("A \\| B");
  });

  it("escapes a backtick", () => {
    expect(escapeMarkdownCell("A `code` B")).toBe("A \\`code\\` B");
  });

  it("collapses an embedded newline to a space (a table cell cannot contain a raw newline)", () => {
    expect(escapeMarkdownCell("A\nB")).toBe("A B");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeMarkdownCell("Nova Norbury")).toBe("Nova Norbury");
  });

  it("escapes angle brackets, square brackets, underscores, and asterisks — markdown permits inline HTML and emphasis syntax, so any of these left raw can inject markup or break formatting", () => {
    expect(escapeMarkdownCell("<b>[link](_url_) *bold*")).toBe("\\<b\\>\\[link\\](\\_url\\_) \\*bold\\*");
  });

  it("a script tag renders as literal text, not raw HTML — the whole point of escaping <, >", () => {
    expect(escapeMarkdownCell("<script>alert(1)</script>")).not.toContain("<script>");
  });
});

describe("renderDossierMarkdown", () => {
  it("labels the layout v0", () => {
    expect(renderDossierMarkdown(buildDossier())).toMatch(/v0/i);
  });

  it("has no external reference of any kind", () => {
    const md = renderDossierMarkdown(buildDossier());
    expect(md).not.toMatch(/https?:\/\//);
    expect(md).not.toMatch(/@import/i);
  });

  it("a name with a pipe and a backtick does not break the roster table's column count", () => {
    const nastyName = "A | B `C`";
    const dossier = buildDossier({
      players: [buildPlayerProfile({ identity: { ...buildPlayerProfile().identity, canonicalName: nastyName } })],
      team: buildTeamProfile({
        roster: [
          {
            playerId: 1,
            canonicalName: nastyName,
            ageRange: null,
            singlesRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
            doublesRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
            slotTendencies: [],
          },
        ],
      }),
    });
    const md = renderDossierMarkdown(dossier);
    const rosterLine = md.split("\n").find((l) => l.includes("\\| B"));
    expect(rosterLine).toBeDefined();
    // Every row in a markdown table has the same number of `|` delimiters as the header. The
    // escaped pipe (`\|`) must NOT be counted as a delimiter — this is exactly what the escaping
    // is for, so counting UNescaped pipes only is the assertion that actually distinguishes
    // "escaping works" from "escaping is missing".
    const unescapedPipeCount = (rosterLine ?? "").split("").reduce((count, ch, i, arr) => {
      if (ch !== "|") return count;
      return arr[i - 1] === "\\" ? count : count + 1;
    }, 0);
    const headerLine = md.split("\n").find((l) => l.startsWith("| Player"));
    const headerPipeCount = (headerLine ?? "").split("|").length - 1;
    expect(unescapedPipeCount).toBe(headerPipeCount);
  });

  it("escapes a player name containing a script tag EVERYWHERE it appears — the roster table AND the player heading, not just the table — so the raw substring <script> never survives into the markdown output", () => {
    const nastyName = "Dan <script>alert(1)</script>";
    const dossier = buildDossier({
      players: [buildPlayerProfile({ identity: { ...buildPlayerProfile().identity, canonicalName: nastyName } })],
      team: buildTeamProfile({
        roster: [
          {
            playerId: 1,
            canonicalName: nastyName,
            ageRange: null,
            singlesRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
            doublesRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
            slotTendencies: [],
          },
        ],
      }),
    });
    const md = renderDossierMarkdown(dossier);
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("<script>alert(1)</script>");
    // The player heading ("### Dan ...") must also be escaped, not just the roster table row.
    expect(md).toContain(`### ${escapeMarkdownCell(nastyName)}`);
  });

  it('includes a "Not collected yet" block when dataGaps reports gaps', () => {
    const md = renderDossierMarkdown(buildDossier());
    expect(md).toMatch(/not collected yet/i);
  });

  it('omits the "Not collected yet" block when there is nothing not-collected', () => {
    const dossier = buildDossier({ players: [buildPlayerProfile({ dataGaps: { events: "has-data" } })] });
    const md = renderDossierMarkdown(dossier);
    expect(md).not.toMatch(/not collected yet/i);
  });

  it("is deterministic: rendering the same profile twice is byte-identical", () => {
    const dossier = buildDossier();
    expect(renderDossierMarkdown(dossier)).toBe(renderDossierMarkdown(dossier));
  });

  it("a dossier with every section empty still renders a valid, non-throwing document", () => {
    const md = renderDossierMarkdown(buildEmptyDossier());
    expect(md).toContain("IA/Versteeg/40&Over3.5M");
    expect(md.length).toBeGreaterThan(0);
  });

  it("renders the roster table with age range, NTRP+type, and TR dynamic rating", () => {
    const md = renderDossierMarkdown(buildDossier());
    expect(md).toContain("40-49");
    expect(md).toContain("4.0C"); // NTRP 4.0, fixed 1-decimal precision, rating type C
    expect(md).toContain("4.10"); // TR dynamic, fixed 2-decimal precision
  });

  it("renders head-to-head rows when headToHead is present, with an undecided count when nonzero, naming the OPPONENT'S NAME rather than a raw id", () => {
    const dossier = buildDossier({
      team: buildTeamProfile({
        headToHead: [
          { playerId: 1, opponentId: 99, opponentName: "Nova Norbury", wins: 1, losses: 0, undecided: 1, matches: 2 },
        ],
      }),
    });
    const md = renderDossierMarkdown(dossier);
    expect(md).toContain("1-0 (1 undecided)");
    expect(md).toContain("vs Nova Norbury");
    expect(md).not.toContain("player #99");
  });

  it("escapes an opponent name that would otherwise inject markup or break the markdown link/table structure", () => {
    const dossier = buildDossier({
      team: buildTeamProfile({
        headToHead: [
          {
            playerId: 1,
            opponentId: 99,
            opponentName: "<script>alert(1)</script>",
            wins: 1,
            losses: 0,
            undecided: 0,
            matches: 1,
          },
        ],
      }),
    });
    const md = renderDossierMarkdown(dossier);
    expect(md).not.toContain("<script>alert(1)</script>");
  });

  it("headToHead present but with no rows for this player renders an explicit none-on-file note", () => {
    const dossier = buildDossier({
      team: buildTeamProfile({
        headToHead: [{ playerId: 999, opponentId: 1, opponentName: "Someone Else", wins: 0, losses: 0, undecided: 0, matches: 0 }],
      }),
    });
    const md = renderDossierMarkdown(dossier);
    expect(md).toContain("Prior meetings vs our players: none on file.");
  });

  it("renders the 'not available' prior-meetings note exactly ONCE for a multi-player dossier, in its own section — not once per player block", () => {
    const players = [1, 2, 3, 4].map((id) =>
      buildPlayerProfile({ identity: { ...buildPlayerProfile().identity, playerId: id, canonicalName: `Player ${id}` } }),
    );
    const dossier = buildDossier({
      players,
      team: buildTeamProfile({
        roster: players.map((p) => ({
          playerId: p.identity.playerId,
          canonicalName: p.identity.canonicalName,
          ageRange: p.identity.ageRange,
          singlesRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
          doublesRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
          slotTendencies: [],
        })),
        headToHead: null,
      }),
    });
    const md = renderDossierMarkdown(dossier);
    const occurrences = md.toLowerCase().split("not available in this build").length - 1;
    expect(occurrences).toBe(1);
  });

  it("renders a dedicated 'Prior meetings vs our players' section heading, separate from the per-player blocks", () => {
    const md = renderDossierMarkdown(buildDossier());
    expect(md).toMatch(/^## Prior meetings vs our players$/m);
  });
});
