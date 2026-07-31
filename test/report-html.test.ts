import { describe, expect, it } from "vitest";
import { escapeHtml, renderDossier } from "../src/report/html.js";
import { buildDossier, buildEmptyDossier, buildPlayerProfile, buildTeamProfile } from "./helpers/dossier.js";

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

  it("renders head-to-head rows when headToHead is present", () => {
    const dossier = buildDossier({
      team: buildTeamProfile({
        headToHead: [{ playerId: 1, opponentId: 99, wins: 2, losses: 1, undecided: 0, matches: 3 }],
      }),
    });
    const html = renderDossier(dossier);
    expect(html).toContain("2-1");
  });

  it("appends an undecided count to a head-to-head row when nonzero", () => {
    const dossier = buildDossier({
      team: buildTeamProfile({
        headToHead: [{ playerId: 1, opponentId: 99, wins: 1, losses: 0, undecided: 1, matches: 2 }],
      }),
    });
    const html = renderDossier(dossier);
    expect(html).toContain("1-0 (1 undecided)");
  });

  it("headToHead present but with no rows for this player renders an explicit none-on-file note", () => {
    const dossier = buildDossier({
      team: buildTeamProfile({
        // A cross pair against a DIFFERENT player id — this dossier's only player never met anyone.
        headToHead: [{ playerId: 999, opponentId: 1, wins: 0, losses: 0, undecided: 0, matches: 0 }],
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
});
