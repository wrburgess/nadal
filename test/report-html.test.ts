import { describe, expect, it } from "vitest";
import { formatWtnProvenanceLine } from "../src/cli/format-profile.js";
import { escapeHtml, renderDossier } from "../src/report/html.js";
import { renderDossierMarkdown } from "../src/report/markdown.js";
import {
  buildDossier,
  buildEmptyDossier,
  buildOwnTeamBook,
  buildPlayerProfile,
  buildTeamProfile,
} from "./helpers/dossier.js";

describe("escapeHtml", () => {
  it("escapes the five XML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("Nova Norbury")).toBe("Nova Norbury");
  });
});

describe("renderDossier", () => {
  it("is a self-contained document: no external reference of any kind", () => {
    const html = renderDossier(buildDossier());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/(?<!<)\/\//); // protocol-relative //example.com (allowing e.g. closing comments is n/a here)
    expect(html).not.toMatch(/<script[^>]*\bsrc/i);
    expect(html).not.toMatch(/<link[^>]*rel=["']?stylesheet/i);
    expect(html).not.toMatch(/@import/i);
  });

  it("inlines a <style> block rather than linking one", () => {
    const html = renderDossier(buildDossier());
    expect(html).toMatch(/<style>/);
  });

  it("includes print CSS sized for a courtside binder", () => {
    const html = renderDossier(buildDossier());
    expect(html).toMatch(/@media print/);
    expect(html).toMatch(/@page\s*\{[^}]*size:\s*letter/);
    expect(html).toMatch(/@page\s*\{[^}]*margin:\s*0\.5in/);
    expect(html).toMatch(/page-break-inside:\s*avoid/);
  });

  it("labels the layout v0", () => {
    const html = renderDossier(buildDossier());
    expect(html).toMatch(/v0/i);
  });

  it("escapes a player name containing a script tag — no raw <script>alert(1)</script> in the output", () => {
    const dossier = buildDossier({
      players: [buildPlayerProfile({ identity: { ...buildPlayerProfile().identity, canonicalName: "<script>alert(1)</script>" } })],
      team: buildTeamProfile({
        roster: [
          {
            playerId: 1,
            canonicalName: "<script>alert(1)</script>",
            ageRange: "40-49",
            singlesRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
            doublesRecord: { wins: 0, losses: 0, undecided: 0, excludedUndated: 0 },
            slotTendencies: [],
          },
        ],
      }),
    });
    const html = renderDossier(dossier);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a name containing every XML-significant character without breaking table structure", () => {
    const nastyName = `A & B "C" 'D' <E>`;
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
    const html = renderDossier(dossier);
    expect(html).not.toContain(nastyName);
    expect(html).toContain(escapeHtml(nastyName));
  });

  it('includes a "Not collected yet" block naming events/availability/captain notes when dataGaps reports them', () => {
    const html = renderDossier(buildDossier());
    expect(html).toMatch(/not collected yet/i);
    expect(html).toContain("events");
    expect(html).toContain("availability");
  });

  it('omits the "Not collected yet" block entirely when there is nothing not-collected', () => {
    const dossier = buildDossier({
      players: [buildPlayerProfile({ dataGaps: { events: "has-data", availability: "empty" } })],
    });
    const html = renderDossier(dossier);
    expect(html).not.toMatch(/not collected yet/i);
  });

  it("renders the roster table with age range, NTRP+type, and TR dynamic rating", () => {
    const html = renderDossier(buildDossier());
    expect(html).toContain("40-49");
    expect(html).toContain("4.0C"); // NTRP 4.0, fixed 1-decimal precision, rating type C
    expect(html).toContain("4.10"); // TR dynamic, fixed 2-decimal precision
  });

  // Issue #128's other side, missing before this PR: `buildDossier()`'s default player already
  // carries an age range, so the table above never proved the null path also renders correctly —
  // the permanent 1668-of-1745 case, a player with no WTN profile on file.
  it("renders 'unknown' in the age range column for a player with none on file", () => {
    const dossier = buildDossier({
      players: [buildPlayerProfile({ identity: { ...buildPlayerProfile().identity, ageRange: null } })],
    });
    const html = renderDossier(dossier);
    expect(html).toContain("<td>unknown</td>");
  });

  it("renders court-slot tendencies and partner frequency for each player", () => {
    const html = renderDossier(buildDossier());
    expect(html).toContain("S1");
    expect(html).toContain("Kai Kestrel");
  });

  it("is deterministic: rendering the same profile twice is byte-identical", () => {
    const dossier = buildDossier();
    expect(renderDossier(dossier)).toBe(renderDossier(dossier));
  });

  it("a dossier with every section empty still renders a valid, well-formed document", () => {
    const html = renderDossier(buildEmptyDossier());
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("</html>");
    expect(html).toContain(escapeHtml("IA/Versteeg/40&Over3.5M"));
  });

  it('renders "prior meetings vs our players" as unavailable when headToHead is null', () => {
    const html = renderDossier(buildDossier());
    expect(html.toLowerCase()).toContain("prior meetings");
  });

  // #19: `headToHead` is null for TWO different reasons (src/report/write.ts's `versusTeamId`
  // is undefined when no home team exists at all, AND when the team being built IS the home
  // team), and both used to print the same sentence — "no home team configured". On the home
  // team's OWN dossier that sentence is simply false: `tn team home` has run and succeeded, and
  // the binder still said nobody had configured one. `TeamProfile.isHome` already carried the
  // distinction (src/query/team-profile.ts:169); the renderers just never read it.
  it("on the home team's OWN dossier, the unavailable line does NOT claim no home team is configured", () => {
    const html = renderDossier(buildDossier({ team: buildTeamProfile({ isHome: true, headToHead: null }) }));
    expect(html.toLowerCase()).not.toContain("no home team configured");
    expect(html.toLowerCase()).toContain("our own team");
  });

  it("with no home team designated at all, the unavailable line DOES say so", () => {
    const html = renderDossier(buildDossier({ team: buildTeamProfile({ isHome: false, headToHead: null }) }));
    expect(html.toLowerCase()).toContain("no home team configured");
  });

  it("renders head-to-head rows when headToHead is present, naming the OPPONENT'S NAME rather than a raw id", () => {
    const dossier = buildDossier({
      team: buildTeamProfile({
        headToHead: [
          { playerId: 1, opponentId: 99, opponentName: "Nova Norbury", wins: 2, losses: 1, undecided: 0, matches: 3 },
        ],
      }),
    });
    const html = renderDossier(dossier);
    expect(html).toContain("2-1");
    expect(html).toContain("vs Nova Norbury");
    expect(html).not.toContain("player #99");
  });

  it("appends an undecided count to a head-to-head row when nonzero", () => {
    const dossier = buildDossier({
      team: buildTeamProfile({
        headToHead: [
          { playerId: 1, opponentId: 99, opponentName: "Nova Norbury", wins: 1, losses: 0, undecided: 1, matches: 2 },
        ],
      }),
    });
    const html = renderDossier(dossier);
    expect(html).toContain("1-0 (1 undecided)");
  });

  it("escapes an opponent name that would otherwise inject markup into the rendered HTML", () => {
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
    const html = renderDossier(dossier);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("headToHead present but with no rows for this player renders an explicit none-on-file note", () => {
    const dossier = buildDossier({
      team: buildTeamProfile({
        // A cross pair against a DIFFERENT player id — this dossier's only player never met anyone.
        headToHead: [{ playerId: 999, opponentId: 1, opponentName: "Someone Else", wins: 0, losses: 0, undecided: 0, matches: 0 }],
      }),
    });
    const html = renderDossier(dossier);
    expect(html).toContain("Prior meetings vs our players: none on file.");
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
    const html = renderDossier(dossier);
    const occurrences = html.toLowerCase().split("not available in this build").length - 1;
    expect(occurrences).toBe(1);
  });

  it("renders a dedicated 'Prior meetings vs our players' section separate from the per-player blocks", () => {
    const html = renderDossier(buildDossier());
    expect(html).toMatch(/<section id="prior-meetings">/);
  });

  // Issue #122, Task 4/7: the twin of markdown's heading pin — the heading now names the exemption
  // explicitly, since this section is NOT filtered by the page's 12-month window.
  it("the prior-meetings heading names the exemption: 'all meetings on file'", () => {
    const html = renderDossier(buildDossier());
    expect(html).toContain("<h2>Prior meetings vs our players (all meetings on file)</h2>");
  });

  // Issue #122, Task 4: the twin of markdown's record-line pin — this line used to read
  // `<strong>2026 record:</strong>`; it now names the actual 12-month window rather than a bare
  // year, and reads from the renamed `.windowed` key.
  it("renders each player's record line with the window label, not a bare year", () => {
    const dossier = buildDossier({ window: "12mo to 2026-08-28" });
    const html = renderDossier(dossier);
    expect(html).toContain("<strong>Record (12mo to 2026-08-28):</strong> singles 3-1,");
    expect(html).toContain("doubles 1-2</p>");
    expect(html).not.toContain("<strong>2026 record:</strong>");
  });

  // Issue #122, Task 7: the twin of markdown's evidence-scope-sentence pin.
  it("the evidence-scope sentence no longer claims prior meetings share the same scope as records and tendencies", () => {
    const html = renderDossier(buildDossier());
    expect(html).toContain("<strong>Records and court-slot tendencies below were computed over:</strong>");
    expect(html).not.toContain("Records, court-slot tendencies and prior meetings");
    expect(html).toContain("Prior meetings below draws on the same leagues but every date on file, not the 12-month window above.");
  });
});

// #126 — the HTML twin of the markdown own-team-book suite. Both renderers consume one shape
// (src/report/types.ts), so the same facts are asserted in both files: a renderer that drifts is
// the failure this pairing exists to catch.
describe("own-team book (HTML)", () => {
  const homeTeam = buildTeamProfile({ isHome: true });

  it("renders the section on the home team's dossier", () => {
    const html = renderDossier(buildDossier({ team: homeTeam, ownTeam: buildOwnTeamBook() }));
    expect(html).toContain("Own-team book");
  });

  it("omits the section entirely on an opponent's dossier", () => {
    const html = renderDossier(buildDossier({ ownTeam: null }));
    expect(html).not.toContain("Own-team book");
  });

  it("keeps a day nobody answered for as a column", () => {
    // The markdown suite's twin of this test explains why this is the dangerous case.
    const html = renderDossier(
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

    expect(html).toContain("2026-08-30");
  });

  it("renders an empty book as an explicit 'none recorded', not as an absent section", () => {
    const html = renderDossier(
      buildDossier({
        team: homeTeam,
        ownTeam: buildOwnTeamBook({
          availability: { days: ["2026-08-28"], players: [] },
          notes: { player: [], pairing: [] },
        }),
      }),
    );

    expect(html).toContain("Own-team book");
    expect(html.toLowerCase()).toContain("none recorded");
  });

  it("does not emit a zero-column table when the named event has no date range on file", () => {
    // The markdown twin explains the state: `events.starts_on`/`ends_on` are nullable, so a named
    // event can have no days.
    const html = renderDossier(
      buildDossier({
        team: homeTeam,
        ownTeam: buildOwnTeamBook({
          availability: { days: [], players: [{ playerId: 1, canonicalName: "Nova Norbury", days: [] }] },
        }),
      }),
    );

    expect(html.toLowerCase()).toContain("no date range on file");
    // An empty grid would read as "nobody is available" rather than "this event has no dates".
    expect(html).not.toContain("<table class=\"roster\"><thead><tr><th>Player</th></tr></thead>");
  });

  it("says availability needs a named event rather than printing an empty grid", () => {
    const html = renderDossier(
      buildDossier({ team: homeTeam, ownTeam: buildOwnTeamBook({ availability: null }) }),
    );
    expect(html.toLowerCase()).toContain("no event named");
  });

  it("escapes markup in free-text note content", () => {
    // Captain notes are arbitrary operator text landing in an HTML document.
    const hostile = "<script>alert(1)</script>";
    const html = renderDossier(
      buildDossier({
        team: homeTeam,
        ownTeam: buildOwnTeamBook({
          notes: {
            player: [
              {
                noteId: 1,
                playerId: 1,
                canonicalName: "Nova Norbury",
                note: hostile,
                createdAt: "2026-08-09T00:00:00.000Z",
              },
            ],
            pairing: [],
          },
        }),
      }),
    );

    expect(html).not.toContain(hostile);
    expect(html).toContain(escapeHtml(hostile));
  });

  it("escapes markup in a player's name inside the availability grid", () => {
    // The grid renders names from a DIFFERENT source than the roster table above it, so it needs
    // its own escaping proof rather than inheriting that table's.
    const nastyName = '<img src=x onerror="alert(1)">';
    const html = renderDossier(
      buildDossier({
        team: homeTeam,
        ownTeam: buildOwnTeamBook({
          availability: {
            days: ["2026-08-28"],
            players: [{ playerId: 1, canonicalName: nastyName, days: [{ day: "2026-08-28", status: "available" }] }],
          },
        }),
      }),
    );

    expect(html).not.toContain(nastyName);
    expect(html).toContain(escapeHtml(nastyName));
  });
});

describe("renderDossier — WTN provenance disclosure (#132)", () => {
  const withWtn = (observedOn: string, playerId = 1) =>
    buildPlayerProfile({
      identity: { playerId, canonicalName: `Player ${playerId}`, aliases: [], ageRange: null, gender: null, ustaUaid: null, wtnTennisId: null, tennisrecordUrl: null },
      ratingTrajectory: [
        { source: "wtn_singles", latest: { id: playerId, value: 30.35, ratingType: null, observedOn }, series: [] },
      ],
    });

  it("names the publisher, its publication date, and that the two are not reconciled", () => {
    const html = renderDossier(buildDossier({ players: [withWtn("2026-08-05")] }));

    expect(html).toContain("USTA player profile");
    expect(html).toContain("published 2026-08-05");
    expect(html).toContain("worldtennisnumber.com");
    expect(html).toContain("does not reconcile");
  });

  it("still renders, claiming nothing, when no player has a WTN", () => {
    const html = renderDossier(buildDossier());

    expect(html).toContain("none on file");
  });

  it("escapes a hostile observed_on rather than emitting it into the markup", () => {
    // `observed_on` is an unconstrained TEXT column, so it is as untrusted as a scraped name.
    const html = renderDossier(buildDossier({ players: [withWtn('2026-08-05"><script>x</script>')] }));

    expect(html).not.toContain("<script>x</script>");
  });

  it("says the same sentence as the markdown dossier, from the one shared derivation", () => {
    // The guard on this repo's most-repeated defect class: the same fact derived independently in
    // two renderers, which has now shipped four times (docs/findings.md; PR #134 three times, PR
    // #135 once). Comparing the two OUTPUTS catches a second copy in a way that comparing each
    // against its own literal never would.
    const dossier = buildDossier({ players: [withWtn("2026-08-05")] });
    const sentence = formatWtnProvenanceLine(dossier.players.map((p) => p.ratingTrajectory));

    expect(renderDossier(dossier)).toContain(escapeHtml(sentence));
    expect(renderDossierMarkdown(dossier)).toContain(sentence);
  });
});
