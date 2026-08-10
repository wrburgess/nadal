import { describe, expect, it } from "vitest";
import { escapeMarkdownCell, renderDossierMarkdown } from "../src/report/markdown.js";
import {
  buildDossier,
  buildEmptyDossier,
  buildOwnTeamBook,
  buildPlayerProfile,
  buildTeamProfile,
} from "./helpers/dossier.js";

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

  // Issue #122, Task 4/7: the heading now names the exemption explicitly — this section is NOT
  // filtered by the page's 12-month window, unlike the records and tendencies above it.
  it("renders a dedicated 'Prior meetings vs our players (all meetings on file)' section heading, separate from the per-player blocks", () => {
    const md = renderDossierMarkdown(buildDossier());
    expect(md).toMatch(/^## Prior meetings vs our players \(all meetings on file\)$/m);
  });

  // Issue #122, Task 4: the currently-missing player-block record-line pin — this line used to read
  // `**2026 record:**`; it now names the actual 12-month window rather than a bare year, and reads
  // from the renamed `.windowed` key.
  it("renders each player's record line with the window label, not a bare year", () => {
    const dossier = buildDossier({ window: "12mo to 2026-08-28" });
    const md = renderDossierMarkdown(dossier);
    expect(md).toContain("**Record (12mo to 2026-08-28):** singles 3-1, doubles 1-2");
    expect(md).not.toContain("**2026 record:**");
  });

  // Issue #122, Task 7: the evidence-scope sentence no longer lists prior meetings among the
  // sections it describes (records + tendencies are windowed, prior meetings is not) — and the
  // closing disclaimer names prior meetings' own, different exemption rather than staying silent
  // about it.
  it("the evidence-scope sentence no longer claims prior meetings share the same scope as records and tendencies", () => {
    const md = renderDossierMarkdown(buildDossier());
    expect(md).toContain("**Records and court-slot tendencies below were computed over:**");
    expect(md).not.toContain("Records, court-slot tendencies and prior meetings");
    expect(md).toContain("Prior meetings below draws on the same leagues but every date on file, not the 12-month window above.");
  });

  // #19: twin of the html.ts case — see that suite's comment. The two renderers must not drift on
  // which sentence they print for which reason `headToHead` is null.
  it("on the home team's OWN dossier, the unavailable line does NOT claim no home team is configured", () => {
    const md = renderDossierMarkdown(buildDossier({ team: buildTeamProfile({ isHome: true, headToHead: null }) }));
    expect(md.toLowerCase()).not.toContain("no home team configured");
    expect(md.toLowerCase()).toContain("our own team");
  });

  it("with no home team designated at all, the unavailable line DOES say so", () => {
    const md = renderDossierMarkdown(buildDossier({ team: buildTeamProfile({ isHome: false, headToHead: null }) }));
    expect(md.toLowerCase()).toContain("no home team configured");
  });
});

// #126 — spec § Deliverables #2. The home dossier used to render the identical six sections an
// opponent's did, so the captain's subjective layer had nowhere to land in the printed binder.
describe("own-team book (markdown)", () => {
  const homeTeam = buildTeamProfile({ isHome: true });

  it("renders the section on the home team's dossier", () => {
    const md = renderDossierMarkdown(buildDossier({ team: homeTeam, ownTeam: buildOwnTeamBook() }));
    expect(md).toContain("## Own-team book");
  });

  it("omits the section entirely on an opponent's dossier", () => {
    // `ownTeam: null` is what `buildTeamDossier` produces for every team that is not ours — an
    // opponent's availability is not merely unrecorded, it is none of our business (spec § Domain
    // model: "populated for our team only, by design").
    const md = renderDossierMarkdown(buildDossier({ ownTeam: null }));
    expect(md).not.toContain("Own-team book");
  });

  it("keeps a day nobody answered for as a column, with every cell unrecorded", () => {
    // THE failure this feature is most likely to ship with: derive the day list from the recorded
    // rows and Saturday silently disappears, so "who is available Saturday?" renders as though
    // there were no Saturday. The grid still looks complete, which is what makes it dangerous.
    const md = renderDossierMarkdown(
      buildDossier({
        team: homeTeam,
        ownTeam: buildOwnTeamBook({
          availability: {
            days: ["2026-08-28", "2026-08-29", "2026-08-30"],
            players: [
              {
                playerId: 1,
                canonicalName: "Nova Norbury",
                days: [
                  { day: "2026-08-28", status: "available" },
                  { day: "2026-08-29", status: null },
                  { day: "2026-08-30", status: null },
                ],
              },
            ],
          },
        }),
      }),
    );

    expect(md).toContain("2026-08-30");
  });

  it("prints an unrecorded day differently from a recorded 'unavailable'", () => {
    const md = renderDossierMarkdown(
      buildDossier({
        team: homeTeam,
        ownTeam: buildOwnTeamBook({
          availability: {
            days: ["2026-08-28", "2026-08-29"],
            players: [
              {
                playerId: 1,
                canonicalName: "Nova Norbury",
                days: [
                  { day: "2026-08-28", status: "unavailable" },
                  { day: "2026-08-29", status: null },
                ],
              },
            ],
          },
        }),
      }),
    );

    const row = md.split("\n").find((line) => line.includes("Nova Norbury") && line.includes("unavailable"))!;
    // Exact cell equality, not `contains`: the whole point is that these two render as DIFFERENT
    // strings, and a substring check on "unavailable" passes even if the null cell printed it too.
    expect(row.split("|").map((c) => c.trim())).toEqual(["", "Nova Norbury", "unavailable", "—", ""]);
  });

  it("renders an empty book as an explicit 'none recorded', not as an absent section", () => {
    // The state this ships in until the captain enters data (#129). An absent section is
    // indistinguishable from a section nobody thought to add (src/report/types.ts), and this one
    // must NOT borrow the "Not collected yet" wording — that sentence means no writer exists
    // anywhere in the codebase, which has been false since #17 PR A.
    const md = renderDossierMarkdown(
      buildDossier({
        team: homeTeam,
        ownTeam: buildOwnTeamBook({
          availability: { days: ["2026-08-28"], players: [] },
          notes: { player: [], pairing: [] },
        }),
      }),
    );

    expect(md).toContain("## Own-team book");

    // Scoped to the book's own section on purpose. The whole document legitimately contains the
    // "no writer exists" sentence, because `buildPlayerProfile`'s default `dataGaps` still says
    // `not-collected` for all three sections — a state production can no longer produce
    // (`player-profile.ts` hardcodes `hasWriter: true` since #113), but one two existing renderer
    // tests are pinned to. Asserting over the whole string would fail for that unrelated fixture
    // default rather than for anything this feature does. Logged in docs/findings.md.
    const book = md.slice(md.indexOf("## Own-team book"), md.indexOf("## Player detail"));
    expect(book.toLowerCase()).toContain("none recorded");
    expect(book).not.toContain("no writer exists");
  });

  it("says availability needs a named event rather than printing an empty grid", () => {
    const md = renderDossierMarkdown(
      buildDossier({ team: homeTeam, ownTeam: buildOwnTeamBook({ availability: null }) }),
    );
    // "nobody is available" and "you did not name an event" are different facts.
    expect(md.toLowerCase()).toContain("no event named");
  });

  it("renders a pairing note once, in its own block, not under each partner", () => {
    const md = renderDossierMarkdown(buildDossier({ team: homeTeam, ownTeam: buildOwnTeamBook() }));
    // A pairing note is one observation about two people; printing it under both would read as two.
    expect(md.split("strong together")).toHaveLength(2);
    expect(md).toContain("Nova Norbury + Kai Kestrel");
  });

  it("escapes a pipe in free-text note content so the table survives", () => {
    // Captain notes are arbitrary operator text landing in a markdown table.
    const md = renderDossierMarkdown(
      buildDossier({
        team: homeTeam,
        ownTeam: buildOwnTeamBook({
          notes: {
            player: [
              {
                noteId: 1,
                playerId: 1,
                canonicalName: "Nova Norbury",
                note: "fast | flat",
                createdAt: "2026-08-09T00:00:00.000Z",
              },
            ],
            pairing: [],
          },
        }),
      }),
    );

    expect(md).toContain("fast \\| flat");
    expect(md).not.toContain("fast | flat");
  });
});
