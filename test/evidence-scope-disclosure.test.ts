// Issue #97 scope item 3, across every surface that prints a scoped record:
//
//   "Dossier and `player show` name the filter applied and the count it excluded. Not optional — a
//    filtered record that does not say what it filtered, or what it still contains, is the same
//    class of problem this issue was opened for."
//
// Two things are asserted everywhere below, and they are not the same requirement:
//   1. A SCOPED read names its filter, its excluded count, AND what survived (the accepted residual
//      — 37%–69% of remaining evidence is still out-of-league).
//   2. An UNSCOPED read says so explicitly. A reader who cannot tell a scoped page from an unscoped
//      one has learned nothing from either, which is the defect one step further out.
//
// `tn team show` is covered too. It is not named in the issue, but it renders the roster's records
// and slot tendencies from the SAME `getTeamProfile` call the dossier uses — leaving it silent would
// keep one surface on the unfiltered path with no way to say so.

import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { players, teamMemberships, teams } from "../src/db/schema.js";
import { upsertCourtMatch, upsertCourtMatchPlayers, upsertRatingObservation } from "../src/ingest/upsert.js";
import { addEvent } from "../src/query/events.js";
import { resolveEvent } from "../src/query/lineup.js";
import { buildTeamDossier } from "../src/report/write.js";
import { renderDossier } from "../src/report/html.js";
import { renderDossierMarkdown } from "../src/report/markdown.js";
import { seasonWindow } from "../src/cli/window.js";
import { seedTeamWithRosters } from "./helpers/roster.js";
import { useTnDbPath } from "./helpers/tn-db.js";

type Db = ReturnType<typeof openDb>["db"];

const SPRINGFIELD = {
  name: "Springfield Sectionals",
  kind: "tournament",
  startsOn: "2026-08-28",
  endsOn: "2026-08-30",
  format: "S1:singles,D1:doubles,D2:doubles,D3:doubles",
};

let nextMid = 0;

function play(db: Db, playerIds: number[], slot: string, leagueContext: string | null): void {
  nextMid += 1;
  const cm = upsertCourtMatch(db, {
    teamMatchId: null,
    slot,
    discipline: "doubles",
    winnerSide: "home",
    score: "6-3 6-4",
    leagueContext,
    playedOn: "2026-05-01",
    sourceMatchId: `disclosure-${nextMid}`,
  });
  for (const playerId of playerIds) upsertCourtMatchPlayers(db, { courtMatchId: cm.id, playerId, side: "home" });
}

/**
 * One opponent with the measured live shape: real in-league play, more mixed play than in-league at
 * the same slots, and a second adult league that the `Mixed` exclusion does NOT remove — so the
 * "what is still in here" half of the disclosure has something true and awkward to report, rather
 * than a tidy all-in-league residual that would let a weaker assertion pass.
 */
function seed(): { db: Db; sqlite: ReturnType<typeof openDb>["sqlite"]; teamId: number; playerName: string } {
  runMigrations();
  const { db, sqlite } = openDb();
  const teamId = db.insert(teams).values({ name: "OK/Dickason/40&Over3.5M" }).returning().get().id;
  const playerName = "Nova Norbury";
  const nova = db.insert(players).values({ canonicalName: playerName }).returning().get().id;
  db.insert(teamMemberships).values({ playerId: nova, teamId, eventId: null }).run();
  backfillNameKeys(db);

  play(db, [nova], "D1", "Adult 40+ 3.5");
  play(db, [nova], "D1", "Adult 18+ 3.5");
  play(db, [nova], "D2", "Mixed 40+ 7.0");
  play(db, [nova], "D2", "Mixed 18+ 7.0");
  play(db, [nova], "D3", "Mixed Other 8.0");

  addEvent(db, { ...SPRINGFIELD, leagueScope: "exclude:Mixed" });
  addEvent(db, { ...SPRINGFIELD, name: "Unscoped Event" });
  return { db, sqlite, teamId, playerName };
}

describe("tn player show", () => {
  useTnDbPath("disclosure.db");

  it("names the scope, the excluded count, and what still counts", async () => {
    const { sqlite, playerName } = seed();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", playerName, SPRINGFIELD.name]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain('excluding league contexts starting with "Mixed"');
    expect(printed).toContain('(event "Springfield Sectionals")');
    expect(printed).toContain("2 of 5 court matches retained, 3 excluded");
    // The residual, concretely — and note it is NOT all in-league, which is exactly the point.
    expect(printed).toContain("leagues counted: Adult 18+ 3.5 (1), Adult 40+ 3.5 (1)");
    // And the records above it actually moved.
    expect(printed).toContain("slots: D1×2");
  });

  it("says so explicitly when NO scope applies, rather than printing nothing", async () => {
    const { sqlite, playerName } = seed();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", playerName]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain("no league scope applied — every league counts, 5 court matches");
    expect(printed).toContain("Mixed 40+ 7.0 (1)");
  });

  it("reports 'no scope applied' — naming the event — when the named event records none", async () => {
    const { sqlite, playerName } = seed();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", playerName, "Unscoped Event"]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    // Naming the event is what stops this reading as "you forgot to pass one".
    expect(printed).toContain('no league scope applied (event "Unscoped Event") — every league counts');
  });

  it("refuses an unknown event rather than silently falling back to unscoped", async () => {
    const { sqlite, playerName } = seed();
    sqlite.close();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "show", playerName, "Nope"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('player show status=error message="unknown event \\"Nope\\""');
    // Nothing printed: a refusal must not also emit a profile a reader could mistake for scoped.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("carries the scope summary through --json as structured fields", async () => {
    const { sqlite, playerName } = seed();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["player", "show", playerName, SPRINGFIELD.name, "--json"]);

    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      evidenceScope: { scope: unknown; excluded: number; retained: number; unclassified: number };
    };
    expect(parsed.evidenceScope.scope).toEqual({ mode: "exclude", prefixes: ["Mixed"] });
    expect(parsed.evidenceScope).toMatchObject({ retained: 2, excluded: 3, unclassified: 0 });
  });
});

describe("tn team show", () => {
  useTnDbPath("disclosure.db");

  it("names the scope and the excluded count, and says the team record is not covered by it", async () => {
    const { sqlite } = seed();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["team", "show", "OK/Dickason/40&Over3.5M", SPRINGFIELD.name]);

    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain('excluding league contexts starting with "Mixed"');
    expect(printed).toContain("2 of 5 court matches retained, 3 excluded");
    expect(printed).toContain("the team record above is from team fixtures, not scoped by this");
  });

  it("says so explicitly when unscoped", async () => {
    const { sqlite } = seed();
    sqlite.close();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["team", "show", "OK/Dickason/40&Over3.5M"]);

    expect(logSpy.mock.calls[0]?.[0] as string).toContain("no league scope applied — every league counts");
  });
});

describe("tn event add", () => {
  useTnDbPath("disclosure.db");

  it("records the sixth positional and echoes it in the writer's own grammar", async () => {
    runMigrations();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch([
      "event", "add", "Springfield Sectionals", "tournament", "2026-08-28", "2026-08-30",
      "S1:singles,D1:doubles,D2:doubles,D3:doubles", "exclude:Mixed",
    ]);

    expect(code).toBe(0);
    // Echoed as the text that would RE-create it, so the line an operator copies back into a command
    // is the same round trip the stored-value guard checks.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('leagueScope="exclude:Mixed"'));
  });

  it("omits the field entirely when no scope is on file — an invocation predating #97 prints what it always did", async () => {
    runMigrations();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["event", "add", "Plain", "league", "2026-03-01", "2026-06-01"]);

    expect(logSpy.mock.calls[0]?.[0] as string).not.toContain("leagueScope");
  });

  it("refuses a malformed scope, naming both legal modes, and writes nothing", async () => {
    runMigrations();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch([
      "event", "add", "Springfield", "tournament", "2026-08-28", "2026-08-30", "S1:singles", "drop:Mixed",
    ]);

    expect(code).toBe(1);
    const message = errSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain("unknown mode");
    expect(message).toContain("exclude | only");
    const { db, sqlite } = openDb();
    expect(db.select().from(teams).all()).toHaveLength(0);
    sqlite.close();
  });
});

describe("the dossier, both renderings", () => {
  useTnDbPath("disclosure.db");

  it("carries an Evidence scope section naming the filter, the counts, and the residual", () => {
    const { db, sqlite, teamId } = seed();
    try {
      const dossier = buildTeamDossier(db, teamId, {
        season: seasonWindow("2026-08-28"),
        event: resolveEvent(db, SPRINGFIELD.name),
      });

      const md = renderDossierMarkdown(dossier);
      const html = renderDossier(dossier);

      for (const [label, rendered] of [
        ["markdown", md],
        ["html", html],
      ] as const) {
        expect(rendered, label).toContain("Evidence scope");
        expect(rendered, label).toContain("excluding league contexts starting with");
        expect(rendered, label).toContain("Springfield Sectionals");
        expect(rendered, label).toContain("2 of 5 court matches retained, 3 excluded");
        // The accepted residual, stated rather than implied: what survived is still not all
        // in-league, and the page names which leagues.
        expect(rendered, label).toContain("Adult 18+ 3.5 (1)");
        expect(rendered, label).toContain("Adult 40+ 3.5 (1)");
        // And the honest boundary — the scope does not govern the whole page.
        expect(rendered, label).toContain("neither is filtered by this scope");
      }
    } finally {
      sqlite.close();
    }
  });

  it("states 'no league scope applied' when the build named no event", () => {
    const { db, sqlite, teamId } = seed();
    try {
      const dossier = buildTeamDossier(db, teamId, { season: seasonWindow("2026-08-28") });

      for (const rendered of [renderDossierMarkdown(dossier), renderDossier(dossier)]) {
        expect(rendered).toContain("no league scope applied");
        expect(rendered).toContain("every league counts, 5 court matches");
        // The mixed rows really are still in there, which is what makes the sentence true.
        expect(rendered).toContain("Mixed 40+ 7.0 (1)");
      }
    } finally {
      sqlite.close();
    }
  });

  it("escapes a hostile league context in both media rather than interpolating it raw", () => {
    const { db, sqlite, teamId } = seed();
    try {
      const nova = db.select().from(players).all()[0]!.id;
      // `league_context` is scraped, so it is attacker-influenced exactly like a player name — and it
      // now reaches a printed binder and a markdown table for the first time (#97). Neither escape
      // was previously exercised on this field, because nothing rendered it.
      play(db, [nova], "D1", "Adult <script>alert(1)</script> | 3.5");

      const dossier = buildTeamDossier(db, teamId, { season: seasonWindow("2026-08-28") });

      const html = renderDossier(dossier);
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");

      const md = renderDossierMarkdown(dossier);
      expect(md).not.toContain("<script>alert(1)</script>");
      // A raw pipe would break the surrounding document's tables; a raw `<` survives CommonMark as
      // live HTML.
      expect(md).toContain("\\|");
      expect(md).toContain("\\<script\\>");
    } finally {
      sqlite.close();
    }
  });
});

// Task 7 (#113): the roster-source line and the NOT REGISTERED block, on all three surfaces — CLI
// text (`tn team show`), markdown, and HTML — the same #97 "both branches always print" discipline
// applied to a different disclosure.
describe("roster disclosure (#113)", () => {
  useTnDbPath();

  function seedRegisteredEvent() {
    runMigrations();
    const { db, sqlite } = openDb();
    const fixture = seedTeamWithRosters(db, {
      teamName: "OK/Dickason/40&over3.5M",
      season: ["Registered Rey", "Absent Ada", "Absent Zed"],
      registered: { eventName: "Springfield Sectionals 2026", names: ["Registered Rey"] },
    });
    const adaId = fixture.seasonPlayerIds.get("Absent Ada")!;
    upsertRatingObservation(db, { playerId: adaId, source: "wtn_singles", value: 4.28, observedOn: "2026-01-01" });
    // Absent Zed carries NO rating on file at all — must still print, as "—".
    // `buildTeamDossier` threads its `event` option straight into `getLineupPlan`, which refuses an
    // event with no format on file — a format is added here purely so the dossier-level tests below
    // reach the roster assertions, not because they are about the predicted lineup.
    addEvent(db, {
      name: "Springfield Sectionals 2026",
      kind: "tournament",
      startsOn: "2026-08-28",
      endsOn: "2026-08-30",
      format: "S1:singles",
    });
    sqlite.close();
    return fixture;
  }

  describe("tn team show", () => {
    it("registered branch: states the count, the event, and the NOT REGISTERED block, all in ONE console.log", async () => {
      seedRegisteredEvent();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch([
        "team", "show", "OK/Dickason/40&over3.5M", "Springfield Sectionals 2026",
      ]);

      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      expect(printed).toContain('registered 1 for event "Springfield Sectionals 2026" (season roster: 3)');
      expect(printed).toContain("Registered Rey");
      // The NOT REGISTERED block: name + rating, both absent players present.
      expect(printed).toContain("Absent Ada");
      expect(printed).toContain("4.28");
      expect(printed).toContain("Absent Zed");
      expect(printed).toContain("—");
      expect(printed).toContain("WTN-S");
    });

    it("season branch (no event named): states the fallback, with NO NOT REGISTERED block", async () => {
      seedRegisteredEvent();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["team", "show", "OK/Dickason/40&over3.5M"]);

      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      expect(printed).toContain("season roster — no event named");
      // "Absent Ada" legitimately appears in the ordinary roster listing (the season branch shows
      // the full roster, Ada included) — what must NOT appear is the compact block itself.
      expect(printed).not.toContain("not registered (watch for adds)");
    });

    it("season branch (event named, nothing registered): still renders the full roster, no absent block", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      seedTeamWithRosters(db, { teamName: "Team A", season: ["Player One", "Player Two"] });
      addEvent(db, { name: "Unregistered Event", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30" });
      sqlite.close();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await dispatch(["team", "show", "Team A", "Unregistered Event"]);

      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      expect(printed).toContain('season roster (event "Unregistered Event") — no registered members');
      expect(printed).toContain("Player One");
      expect(printed).toContain("Player Two");
    });
  });

  describe("the dossier, both renderings", () => {
    it("registered branch: names the roster source and renders a NOT REGISTERED section on both media", () => {
      const fixture = seedRegisteredEvent();
      const { db, sqlite } = openDb();
      try {
        const dossier = buildTeamDossier(db, fixture.teamId, {
          season: seasonWindow("2026-08-28"),
          event: resolveEvent(db, "Springfield Sectionals 2026"),
        });

        const md = renderDossierMarkdown(dossier);
        const html = renderDossier(dossier);

        // Markdown does not escape a plain double quote; HTML does (`&quot;`) — asserted per-medium
        // rather than as one shared substring.
        expect(md).toContain('registered 1 for event "Springfield Sectionals 2026" (season roster: 3)');
        expect(html).toContain("registered 1 for event &quot;Springfield Sectionals 2026&quot; (season roster: 3)");

        for (const [label, rendered] of [
          ["markdown", md],
          ["html", html],
        ] as const) {
          expect(rendered, label).toContain("Absent Ada");
          expect(rendered, label).toContain("4.28");
          expect(rendered, label).toContain("Absent Zed");
          expect(rendered, label).toContain("WTN-S");
          // Registered Rey gets the FULL detail block (Player detail section), never the compact one.
          expect(rendered, label).toContain("Registered Rey");
        }
      } finally {
        sqlite.close();
      }
    });

    it("season branch: renders exactly as an unscoped dossier always has — no NOT REGISTERED section", () => {
      const fixture = seedRegisteredEvent();
      const { db, sqlite } = openDb();
      try {
        const dossier = buildTeamDossier(db, fixture.teamId, { season: seasonWindow("2026-08-28") });

        for (const rendered of [renderDossierMarkdown(dossier), renderDossier(dossier)]) {
          expect(rendered).toContain("season roster — no event named");
          // "4.28" (Ada's rating) legitimately still appears in the ordinary roster table's Ratings
          // column — every season member gets the FULL player-detail block here, Ada included. What
          // must NOT appear is the compact NOT REGISTERED section itself.
          expect(rendered).not.toContain("Not registered (watch for adds)");
        }
      } finally {
        sqlite.close();
      }
    });

    it("escapes a hostile absent player name on both media", () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const fixture = seedTeamWithRosters(db, {
          teamName: "Team A",
          season: ["Registered Rey", "Dan<script>alert(1)</script>Kestrel"],
          registered: { eventName: "Event X", names: ["Registered Rey"] },
        });
        addEvent(db, { name: "Event X", kind: "tournament", startsOn: "2026-08-28", endsOn: "2026-08-30", format: "S1:singles" });
        const dossier = buildTeamDossier(db, fixture.teamId, {
          season: seasonWindow("2026-08-28"),
          event: resolveEvent(db, "Event X"),
        });

        const html = renderDossier(dossier);
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;script&gt;");

        const md = renderDossierMarkdown(dossier);
        expect(md).not.toContain("<script>alert(1)</script>");
        expect(md).toContain("\\<script\\>");
      } finally {
        sqlite.close();
      }
    });
  });
});
