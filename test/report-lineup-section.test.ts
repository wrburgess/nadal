// The predicted-lineup section in the rendered dossier (#17 PR B, Task 7). Spec § Deliverables #1
// puts the predicted lineup IN the per-opponent dossier, not only behind `tn lineup plan` — a
// courtside binder is where it actually gets read.
//
// Both renderers are held to the same three properties, because this document is printed and
// carried to a court where nobody can check its provenance:
//   1. it says it is a guess, in the heading AND in prose;
//   2. every row carries its confidence and what it rests on, so a rating-only placement cannot be
//      mistaken for an observed partnership;
//   3. an absence is stated, never rendered as an empty table or omitted entirely.

import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { players, teamMatches, teamMemberships, teams } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers } from "../src/ingest/upsert.js";
import { resolveEventFormat } from "../src/query/lineup.js";
import { addEvent } from "../src/query/events.js";
import { renderDossier } from "../src/report/html.js";
import { renderDossierMarkdown } from "../src/report/markdown.js";
import { buildTeamDossier } from "../src/report/write.js";
import { buildDossier, buildLineupPlan } from "./helpers/dossier.js";
import { useTnDbPath } from "./helpers/tn-db.js";

describe("predicted-lineup section — markdown", () => {
  it("labels the section a guess in both the heading and the prose", () => {
    const md = renderDossierMarkdown(buildDossier());

    expect(md).toContain("## Predicted lineup (a guess)");
    expect(md).toContain("A guess, not a lineup card");
    expect(md).toContain("12 observed court matches across a roster of 6");
  });

  it("renders one row per court, with players, confidence and what the placement rests on", () => {
    const md = renderDossierMarkdown(buildDossier());

    expect(md).toContain("| S1 | Ada Ashby | high | 6 singles matches |");
    expect(md).toContain("| D1 | Bo Bramwell / Cy Calder | high | 5 matches together |");
    // The distinction that matters: D2's players have never played together, and the row has to
    // say so rather than reading like D1 with a lower grade.
    expect(md).toContain("| D2 | Del Duxbury / Emory Ellerby | low | placed by rating — no shared history |");
  });

  it("names the unplaced players, the rating scale, and where the court list came from", () => {
    const md = renderDossierMarkdown(buildDossier());

    expect(md).toContain("**Not placed:** Ira Inglewood (1 court match)");
    // The human label, not the raw source string — a binder reading "ranked within ntrp" beside a
    // roster row reading "NTRP" is drift, so both go through `ratingSourceLabel`.
    expect(md).toContain("**Ratings:** ranked within NTRP; unrated: Ira Inglewood.");
    expect(md).toContain("**Courts:** 3, taken from this team's observed match history — not from the event format.");
  });

  // #63: the presenter must READ slotSource/slotEvent rather than hardcoding the "observed" claim —
  // asserted by the OLD sentence's absence, not merely the new one's presence, per the plan's own
  // "silent-lie" regression shape.
  it("names the event when slotSource is event-format, and the old observed sentence is genuinely absent", () => {
    const lineup = buildLineupPlan({}, { slotSource: "event-format", slotEvent: { id: 1, name: "Springfield Sectionals 2026" } });
    const md = renderDossierMarkdown(buildDossier({ lineup }));

    expect(md).toContain('**Courts:** 3, from the format of event "Springfield Sectionals 2026".');
    expect(md).not.toContain("taken from this team's observed match history — not from the event format.");
  });

  it("escapes an event name with markdown metacharacters", () => {
    const lineup = buildLineupPlan({}, { slotSource: "event-format", slotEvent: { id: 1, name: "Springfield | <script>alert(1)</script>" } });
    const md = renderDossierMarkdown(buildDossier({ lineup }));

    expect(md, "a raw pipe would corrupt the surrounding prose").not.toContain("| Springfield | <script>");
    expect(md).not.toContain("<script>alert(1)</script>");
  });

  it("states the absence when there is no history to predict from", () => {
    const md = renderDossierMarkdown(buildDossier({ lineup: null }));

    expect(md).toContain("## Predicted lineup (a guess)");
    expect(md).toContain("No court-match history on file for this team, so there is nothing to predict from.");
    expect(md, "an absence must not render an empty table").not.toContain("| Court | Players |");
  });

  it("says so plainly when nobody is rated", () => {
    const md = renderDossierMarkdown(buildDossier({ lineup: buildLineupPlan({ ratingSource: null, unranked: [] }) }));

    expect(md).toContain("**Ratings:** none on file");
  });

  it("renders an unfilled court rather than omitting it", () => {
    const lineup = buildLineupPlan();
    lineup.slots[2]!.players = [];
    const md = renderDossierMarkdown(buildDossier({ lineup }));

    expect(md).toContain("_(unfilled — roster exhausted)_");
  });

  it("escapes a player name that would otherwise break the table or inject markup", () => {
    const lineup = buildLineupPlan();
    lineup.slots[0]!.players = [{ playerId: 1, canonicalName: "Dan | <script>alert(1)</script>" }];
    const md = renderDossierMarkdown(buildDossier({ lineup }));

    expect(md, "a raw pipe would corrupt the row").not.toContain("| Dan | <script>");
    expect(md).toContain("\\|");
    expect(md).not.toContain("<script>");
  });
});

describe("predicted-lineup section — HTML", () => {
  it("labels the section a guess in both the heading and the prose", () => {
    const html = renderDossier(buildDossier());

    expect(html).toContain("<h2>Predicted lineup (a guess)</h2>");
    expect(html).toContain("A guess, not a lineup card");
  });

  it("renders each court with its players, confidence and basis", () => {
    const html = renderDossier(buildDossier());

    expect(html).toContain("<td>S1</td><td>Ada Ashby</td><td>high</td><td>6 singles matches</td>");
    expect(html).toContain("<td>D1</td><td>Bo Bramwell / Cy Calder</td><td>high</td><td>5 matches together</td>");
    expect(html).toContain("placed by rating — no shared history");
  });

  it("names the event when slotSource is event-format, and the old observed sentence is genuinely absent", () => {
    const lineup = buildLineupPlan({}, { slotSource: "event-format", slotEvent: { id: 1, name: "Springfield Sectionals 2026" } });
    const html = renderDossier(buildDossier({ lineup }));

    expect(html).toContain('<strong>Courts:</strong> 3, from the format of event "Springfield Sectionals 2026".');
    expect(html).not.toContain("taken from this team's observed match history");
  });

  it("escapes an event name containing markup", () => {
    const lineup = buildLineupPlan({}, { slotSource: "event-format", slotEvent: { id: 1, name: "Springfield <script>alert(1)</script>" } });
    const html = renderDossier(buildDossier({ lineup }));

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("states the absence when there is no history to predict from", () => {
    const html = renderDossier(buildDossier({ lineup: null }));

    expect(html).toContain("No court-match history on file for this team, so there is nothing to predict from.");
    expect(html).not.toContain("<th>Confidence</th>");
  });

  it("escapes a player name containing markup", () => {
    const lineup = buildLineupPlan();
    lineup.slots[0]!.players = [{ playerId: 1, canonicalName: "Dan <script>alert(1)</script>" }];
    const html = renderDossier(buildDossier({ lineup }));

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("stays self-contained — the new section fetches nothing", () => {
    const html = renderDossier(buildDossier());
    const lineupSection = html.slice(html.indexOf('<section id="predicted-lineup"'));

    expect(lineupSection).not.toMatch(/<script\s+src=/i);
    expect(lineupSection).not.toMatch(/<link\s/i);
    expect(lineupSection).not.toMatch(/https?:\/\//);
  });
});

// Found by the independent Codex review of PR #47 (rated medium). Markdown escaping and HTML
// entity-escaping each defend their own medium's syntax and say nothing about control, format, or
// line-separator characters — so a RIGHT-TO-LEFT OVERRIDE inside a scraped name survived both and
// could visually reorder a rendered dossier, including which player sits on which court. This
// document is printed and carried to a court, where nobody can check it against the source.
describe("dossier renderers strip control and bidi characters, not just markup", () => {
  // From character codes, so this source file contains no literal escape sequence.
  const RTL_OVERRIDE = String.fromCharCode(0x202e);
  const LINE_SEPARATOR = String.fromCharCode(0x2028);
  const ESC = String.fromCharCode(0x1b);

  function dossierWithName(name: string) {
    const lineup = buildLineupPlan();
    lineup.slots[0]!.players = [{ playerId: 1, canonicalName: name }];
    return buildDossier({ lineup });
  }

  it.each([
    ["a bidi override", RTL_OVERRIDE],
    ["a line separator", LINE_SEPARATOR],
    ["an ANSI escape", ESC],
  ])("markdown strips %s from a player name", (_label, hostile) => {
    const md = renderDossierMarkdown(dossierWithName(`Ada${hostile}Ashby`));
    expect(md).not.toContain(hostile);
    expect(md).toContain("Ada");
  });

  it.each([
    ["a bidi override", RTL_OVERRIDE],
    ["a line separator", LINE_SEPARATOR],
    ["an ANSI escape", ESC],
  ])("HTML strips %s from a player name", (_label, hostile) => {
    const html = renderDossier(dossierWithName(`Ada${hostile}Ashby`));
    expect(html).not.toContain(hostile);
    expect(html).toContain("Ada");
  });

  it("strips them from the team name too, not only from roster names", () => {
    const dossier = buildDossier();
    dossier.team.teamName = `Team${RTL_OVERRIDE}Versteeg`;
    expect(renderDossierMarkdown(dossier)).not.toContain(RTL_OVERRIDE);
    expect(renderDossier(dossier)).not.toContain(RTL_OVERRIDE);
  });

  it("still escapes the markup each medium cares about — sanitizing did not replace escaping", () => {
    const md = renderDossierMarkdown(dossierWithName("Ada | Ashby"));
    expect(md).toContain("\\|");
    const html = renderDossier(dossierWithName("Ada <b> Ashby"));
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("buildTeamDossier wires the real prediction in", () => {
  useTnDbPath();

  it("attaches a real lineup for a team with history", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const team = db.insert(teams).values({ name: "IA/Versteeg/40&Over3.5M" }).returning().get();
      const ids: number[] = [];
      for (const name of ["Ada Ashby", "Bo Bramwell", "Cy Calder"]) {
        const p = db.insert(players).values({ canonicalName: name }).returning().get();
        ids.push(p.id);
        db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
      }
      backfillNameKeys(db);

      const opponent = db.insert(teams).values({ name: "Report Opponent" }).returning().get();
      const tm = db
        .insert(teamMatches)
        .values({ homeTeamId: team.id, visitingTeamId: opponent.id, sourceMatchId: "report-tm-1" })
        .returning()
        .get();
      for (let i = 0; i < 3; i++) {
        const cm = upsertCourtMatch(db, {
          teamMatchId: tm.id,
          slot: "D1",
          discipline: "doubles",
          winnerSide: "home",
          score: "6-3 6-4",
          leagueContext: "40+ 3.5",
          playedOn: "2026-05-01",
          sourceMatchId: `dossier-${i}`,
        });
        upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: ids[1]!, side: "home" });
        upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: ids[2]!, side: "home" });
      }

      const dossier = buildTeamDossier(db, team.id, { since: "2026-01-01" });

      expect(dossier.lineup).not.toBeNull();
      expect(dossier.lineup!.slots.map((s) => s.slot)).toEqual(["D1"]);
      expect(renderDossierMarkdown(dossier)).toContain("Bo Bramwell / Cy Calder");
    } finally {
      sqlite.close();
    }
  });

  // A `report build` over five teams must not die because one of them has been created but not yet
  // pulled — the refusal is caught and rendered, not propagated.
  it("attaches null for a team with no history rather than failing the whole dossier build", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const team = db.insert(teams).values({ name: "NE/Penland/40&Over3.5M" }).returning().get();
      backfillNameKeys(db);

      const dossier = buildTeamDossier(db, team.id, { since: "2026-01-01" });

      expect(dossier.lineup).toBeNull();
      expect(renderDossierMarkdown(dossier)).toContain("nothing to predict from");
    } finally {
      sqlite.close();
    }
  });

  // #63: the event name threads all the way from `report build`'s CLI argument down to
  // `getLineupPlan`, so a dossier built with an event named uses THAT event's courts.
  it("threads an eventName through to getLineupPlan, so the dossier uses the event's courts", () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const team = db.insert(teams).values({ name: "IA/Versteeg/40&Over3.5M" }).returning().get();
      const ids: number[] = [];
      for (const name of ["Ada Ashby", "Bo Bramwell", "Cy Calder"]) {
        const p = db.insert(players).values({ canonicalName: name }).returning().get();
        ids.push(p.id);
        db.insert(teamMemberships).values({ playerId: p.id, teamId: team.id, eventId: null }).run();
      }
      backfillNameKeys(db);

      const opponent = db.insert(teams).values({ name: "Report Opponent" }).returning().get();
      const tm = db
        .insert(teamMatches)
        .values({ homeTeamId: team.id, visitingTeamId: opponent.id, sourceMatchId: "report-tm-event-1" })
        .returning()
        .get();
      const cm = upsertCourtMatch(db, {
        teamMatchId: tm.id,
        slot: "D1",
        discipline: "doubles",
        winnerSide: "home",
        score: "6-3 6-4",
        leagueContext: "40+ 3.5",
        playedOn: "2026-05-01",
        sourceMatchId: "dossier-event-1",
      });
      upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: ids[1]!, side: "home" });
      upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId: ids[2]!, side: "home" });
      addEvent(db, {
        name: "Springfield Sectionals 2026",
        kind: "tournament",
        startsOn: "2026-08-28",
        endsOn: "2026-08-30",
        format: "D1:doubles",
      });

      // `buildTeamDossier` takes an ALREADY-RESOLVED event, never a name — the resolution belongs to
      // the batch entry point so one build cannot straddle two format versions.
      const dossier = buildTeamDossier(db, team.id, {
        since: "2026-01-01",
        event: resolveEventFormat(db, "Springfield Sectionals 2026"),
      });

      expect(dossier.lineup).not.toBeNull();
      expect(dossier.lineup!.slotSource).toBe("event-format");
      expect(dossier.lineup!.slotEvent).toMatchObject({ name: "Springfield Sectionals 2026" });
      expect(renderDossierMarkdown(dossier)).toContain('from the format of event "Springfield Sectionals 2026"');
    } finally {
      sqlite.close();
    }
  });
});
