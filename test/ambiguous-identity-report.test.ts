// Issue #94. The three facts a human needs to rule on an ambiguous identity — the INCOMING name,
// what it is NEAR, and WHERE it came from — reported the same way by every surface that reports one.
//
// This file exists because the reporting shape was pinned by NOTHING. Before it, the only assertion
// in 1529 tests that touched an ambiguity message at all was one `stringContaining("ambiguous
// target")` in `cli-lineup-plan-command.test.ts` — which the pre-#94 message and the post-#94
// message both satisfy, along with any other message starting those two words. So the defect the
// issue reports (a live `team pull` naming the wrong person, with the value a human had to rule on
// missing entirely) could be introduced, shipped, observed in production, and fixed without one
// test changing colour in either direction. Same class as #90: user-visible output nothing asserts.
//
// The rule these tests encode: assert the WHOLE rendered string, never a fragment. A fragment
// assertion is what let the old shape pass — it cannot tell "reports all three facts" from
// "reports one of them and happens to start with the same word".

import { describe, expect, it, vi } from "vitest";
import { openDb, runMigrations } from "../src/db/client.js";
import { dispatch } from "../src/cli/router.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { players } from "../src/db/schema.js";
import { AmbiguousIdentityError, ambiguousMessage } from "../src/ingest/errors.js";
import { resolvePlayer } from "../src/ingest/identity.js";
import { matchHistoryUrlFor } from "../src/ingest/player-pull.js";
import { pullPlayer } from "../src/ingest/player-pull.js";
import { pullTeam } from "../src/ingest/team-pull.js";
import { hrefParam } from "../src/parsers/dom.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import * as fetchModule from "../src/ingest/fetch.js";
import { createStubFetcher } from "./helpers/stub-fetcher.js";
import { loadFixture } from "./helpers/fixtures.js";
import { buildRosterPage } from "./helpers/roster-html.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const matchHistory = loadFixture("tennisrecord/match-history");

// The fixture's own names, read off it rather than hand-copied, so a re-captured fixture fails here
// loudly instead of silently seeding a near-name that is near nothing.
const PROFILED = "Avery Ashby";
const FIRST_PARTNER = "Nova Norbury";
const FIRST_OPPONENT = "Sawyer Sable";

/** A name one edit away from `name` — inside FUZZY_MAX_DISTANCE (2), so `resolvePlayer`'s tier 3
 * reports it as a candidate and creates nothing. Built by substitution rather than by hand so the
 * distance is a property of the helper, not of a literal a later edit could drift. */
function oneEditAway(name: string): string {
  const i = name.lastIndexOf("a") === -1 ? name.lastIndexOf("e") : name.lastIndexOf("a");
  if (i === -1) throw new Error(`oneEditAway: no vowel to substitute in "${name}"`);
  return `${name.slice(0, i)}${name[i] === "a" ? "o" : "i"}${name.slice(i + 1)}`;
}

describe("the ambiguous-identity report (#94)", () => {
  useTnDbPath();
  useTnRawPath();

  describe("ambiguousMessage — the one formatter every surface renders through", () => {
    it("renders all three facts in one line", () => {
      expect(
        ambiguousMessage({
          incoming: "Austin DuBois",
          candidates: ["Justin DuBois"],
          context: "match opponent",
        }),
      ).toBe('ambiguous identity "Austin DuBois" (match opponent) — near: Justin DuBois');
    });

    it("joins multiple candidates with a comma, still on one line", () => {
      expect(
        ambiguousMessage({ incoming: "Versteeg", candidates: ["Versteeg A", "Versteeg B"], context: "team name target" }),
      ).toBe('ambiguous identity "Versteeg" (team name target) — near: Versteeg A, Versteeg B');
    });

    // The live report this issue was opened about, reconstructed from the verified facts in it.
    // Asserted as a whole string so it states what a human reading stderr actually gets — the
    // pre-#94 rendering of this same event was `ambiguous target: Justin DuBois`, which names a
    // player who was never in question and omits `Austin DuBois` entirely.
    it("the incoming name is NOT one of the candidates — that distinction is the whole issue", () => {
      const rendered = ambiguousMessage({
        incoming: "Austin DuBois",
        candidates: ["Justin DuBois"],
        context: "match opponent",
      });
      expect(rendered).toContain("Austin DuBois");
      expect(rendered).not.toBe("ambiguous target: Justin DuBois");
    });
  });

  describe("AmbiguousIdentityError", () => {
    it("carries the three facts as fields", () => {
      const err = new AmbiguousIdentityError("Karson Davis", ["Mason Davis"], "match partner");
      expect(err.incoming).toBe("Karson Davis");
      expect(err.candidates).toEqual(["Mason Davis"]);
      expect(err.context).toBe("match partner");
      expect(err.name).toBe("AmbiguousIdentityError");
    });

    // A rethrow or a stack trace shows `message`, and a debugging read of stderr should not have to
    // reconcile two spellings of one event — so `message` IS the shared formatter's output, not a
    // second string that says the same thing slightly differently.
    it("its message is exactly what ambiguousMessage renders — one string, not two spellings", () => {
      const identity = { incoming: "Karson Davis", candidates: ["Mason Davis"], context: "match partner" };
      expect(new AmbiguousIdentityError(identity.incoming, identity.candidates, identity.context).message).toBe(
        ambiguousMessage(identity),
      );
    });
  });

  describe("pullPlayer names WHICH identity inside the pull was ambiguous", () => {
    it("the profiled player's own name, when that is what is ambiguous", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const near = oneEditAway(PROFILED);
        resolvePlayer(db, { name: near });

        const result = await pullPlayer({
          db,
          fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
          url: matchHistory.source.url,
        });

        expect(result.kind).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
        expect(result).toMatchObject({
          incoming: PROFILED,
          candidates: [near],
          context: "player profile name",
        });
      } finally {
        sqlite.close();
      }
    });

    // The class the issue is actually about: the cascade target resolves FINE and the ambiguity is
    // a name met while ingesting their history. Live, this was `Jeff Vernon` cascading cleanly while
    // his partner `Karson Davis` collided with an on-file `Mason Davis`.
    it("a PARTNER met inside the history — not the profiled player, who resolved fine", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const near = oneEditAway(FIRST_PARTNER);
        resolvePlayer(db, { name: near });

        const result = await pullPlayer({
          db,
          fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
          url: matchHistory.source.url,
        });

        expect(result.kind).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
        expect(result).toMatchObject({
          incoming: FIRST_PARTNER,
          candidates: [near],
          context: "match partner",
        });
        // The profiled player is NOT what is reported — the exact confusion #94 was opened about.
        expect(result.incoming).not.toBe(PROFILED);
      } finally {
        sqlite.close();
      }
    });

    it("an OPPONENT met inside the history", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const near = oneEditAway(FIRST_OPPONENT);
        resolvePlayer(db, { name: near });

        const result = await pullPlayer({
          db,
          fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
          url: matchHistory.source.url,
        });

        expect(result.kind).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
        expect(result).toMatchObject({
          incoming: FIRST_OPPONENT,
          candidates: [near],
          context: "match opponent",
        });
      } finally {
        sqlite.close();
      }
    });

    it("a NAME TARGET that matches two players on file — the target tier reports all three too", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        // Inserted directly, NOT through `resolvePlayer`: the second name is one edit from the
        // first, so the ladder would report it ambiguous and create nothing — the very refusal this
        // test needs two rows in place to provoke. `backfillNameKeys` supplies the `name_key` /
        // `name_key_length` columns the fuzzy band queries, exactly as a migrated row carries them.
        db.insert(players).values({ canonicalName: "Nova Norbury" }).run();
        db.insert(players).values({ canonicalName: "Nova Norbary" }).run();
        backfillNameKeys(db);

        const result = await pullPlayer({
          db,
          fetchPage: createStubFetcher({}),
          target: "Nova Norbiry",
        });

        expect(result.kind).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
        expect(result.incoming).toBe("Nova Norbiry");
        expect(result.context).toBe("player name target");
        expect([...result.candidates].sort()).toEqual(["Nova Norbary", "Nova Norbury"]);
      } finally {
        sqlite.close();
      }
    });
  });

  describe("pullTeam", () => {
    const TEAM_URL = "https://www.tennisrecord.com/adult/teamprofile.aspx?teamname=Test&year=2026";

    it("a ROSTER ROW's own name, when that is what is ambiguous", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const near = oneEditAway("Nova Norbury");
        resolvePlayer(db, { name: near });

        const result = await pullTeam({
          db,
          fetchPage: createStubFetcher({
            [TEAM_URL]: { body: buildRosterPage({ teamName: "Test Team", players: ["Nova Norbury"] }) },
          }),
          target: TEAM_URL,
        });

        expect(result.kind).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
        expect(result).toMatchObject({
          incoming: "Nova Norbury",
          candidates: [near],
          context: "team roster row",
        });
      } finally {
        sqlite.close();
      }
    });

    // The exact stderr line the issue quotes, in its fixed form. `console.warn` is a raw stderr
    // write with no summary formatter in front of it, so this is the ONLY place that line's shape is
    // stated — and it is the line an operator running a real pull actually reads.
    it("the --players cascade warning names the cascade target AND the identity that actually failed", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const near = oneEditAway(FIRST_PARTNER);
        resolvePlayer(db, { name: near });

        const roster = buildRosterPage({ teamName: "Test Team", players: [PROFILED] });
        const year = hrefParam(TEAM_URL, "year") ?? "2026";
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const result = await pullTeam({
          db,
          fetchPage: createStubFetcher({
            [TEAM_URL]: { body: roster },
            [matchHistoryUrlFor(PROFILED, year)]: { body: matchHistory.html },
          }),
          target: TEAM_URL,
          cascadePlayers: true,
        });

        // The team itself committed; only the enrichment was skipped — that is why this is a
        // warning and a `partial`, not an error.
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("expected ok");
        expect(result.skippedRosterEntries).toEqual([PROFILED]);

        expect(warnSpy).toHaveBeenCalledWith(
          `team pull: cascading "${PROFILED}" failed (ambiguous) — ` +
            `ambiguous identity "${FIRST_PARTNER}" (match partner) — near: ${near} — skipped`,
        );
        warnSpy.mockRestore();
      } finally {
        sqlite.close();
      }
    });

    // The warning interpolates a name parsed from a fetched page. Rendering the three facts through
    // a shared formatter must not reopen the hole PR #47 closed: the RENDERED line is sanitized as
    // one string, so a hostile name cannot inject the punctuation this format separates facts with,
    // nor write control codes to the terminal.
    it("sanitizes the rendered line, so a hostile incoming name cannot write control codes to stderr", async () => {
      const RTL_OVERRIDE = String.fromCharCode(0x202e);
      const ESC = String.fromCharCode(0x1b);
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const hostileIncoming = `Nova${RTL_OVERRIDE}${ESC}[2J Norbury`;
        // On file one edit from the hostile name, so the hostile name is the INCOMING side.
        resolvePlayer(db, { name: oneEditAway(hostileIncoming) });

        const roster = buildRosterPage({ teamName: "Test Team", players: [hostileIncoming] });
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await pullTeam({
          db,
          fetchPage: createStubFetcher({ [TEAM_URL]: { body: roster } }),
          target: TEAM_URL,
          cascadePlayers: true,
        });

        const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(warned).not.toContain(ESC);
        expect(warned).not.toContain(RTL_OVERRIDE);
        warnSpy.mockRestore();
      } finally {
        sqlite.close();
      }
    });
  });

  describe("the CLI surface", () => {
    it("tn player pull prints all three facts in its message= field", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      const near = oneEditAway(FIRST_PARTNER);
      resolvePlayer(db, { name: near });
      sqlite.close();

      vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
        url,
        status: 200,
        body: matchHistory.html,
        fetchedAt: new Date().toISOString(),
      }));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["player", "pull", matchHistory.source.url]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(
        `player pull status=error message="ambiguous identity \\"${FIRST_PARTNER}\\" (match partner) — near: ${near}"`,
      );
      vi.restoreAllMocks();
    });

    it("tn team pull prints all three facts in its message= field", async () => {
      const TEAM_URL = "https://www.tennisrecord.com/adult/teamprofile.aspx?teamname=Test&year=2026";
      runMigrations();
      const { db, sqlite } = openDb();
      const near = oneEditAway("Nova Norbury");
      resolvePlayer(db, { name: near });
      sqlite.close();

      const roster = buildRosterPage({ teamName: "Test Team", players: ["Nova Norbury"] });
      vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
        url,
        status: 200,
        body: roster,
        fetchedAt: new Date().toISOString(),
      }));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await dispatch(["team", "pull", TEAM_URL]);

      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(
        `team pull status=error message="ambiguous identity \\"Nova Norbury\\" (team roster row) — near: ${near}"`,
      );
      vi.restoreAllMocks();
    });
  });

  // The third reporting surface, and the one #94's first pass missed entirely: the formatter lived
  // in `src/cli/emit.ts`, so `src/mcp/tools.ts` went on throwing the pre-#94 `ambiguous target:
  // <candidates>` while both CLI commands had moved on. An agent driving nadal over MCP — the
  // primary interface, per spec § Interfaces — still got the wrong person's name and no incoming
  // value. That is what makes "one shared formatter so they cannot drift" a claim worth asserting
  // rather than describing.
  describe("the MCP surface reports the same three facts as the CLI", () => {
    it("player_pull's error carries the incoming name and the context, not just the candidates", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      const near = oneEditAway(FIRST_PARTNER);
      resolvePlayer(db, { name: near });
      sqlite.close();

      vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
        url,
        status: 200,
        body: matchHistory.html,
        fetchedAt: new Date().toISOString(),
      }));

      const tool = MCP_TOOLS.find((t) => t.name === "player_pull")!;
      await expect(tool.handler({ target: matchHistory.source.url })).rejects.toThrow(
        `ambiguous identity "${FIRST_PARTNER}" (match partner) — near: ${near}`,
      );
      vi.restoreAllMocks();
    });

    it("a target-tier ambiguity on player_show names the target it could not resolve", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      // Direct inserts, for the same reason as the target-tier test above.
      db.insert(players).values({ canonicalName: "Nova Norbury" }).run();
      db.insert(players).values({ canonicalName: "Nova Norbary" }).run();
      backfillNameKeys(db);
      sqlite.close();

      const tool = MCP_TOOLS.find((t) => t.name === "player_show")!;
      await expect(tool.handler({ target: "Nova Norbiry" })).rejects.toThrow(
        /^ambiguous identity "Nova Norbiry" \(target name\) — near: /,
      );
    });
  });

  // Non-vacuity. Every assertion above is an equality against a rendered string, so it would also
  // pass if the pipeline never reached an ambiguity at all and the expectations were never
  // evaluated — except that each one asserts `kind === "ambiguous"` first. This test states the
  // other half explicitly: the SAME fixture, WITHOUT the seeded near-name, resolves cleanly. Without
  // it, a seeding helper that silently stopped producing a near-name would leave the suite green.
  it("the seeded near-name is what causes the ambiguity — without it the same pull succeeds", async () => {
    runMigrations();
    const { db, sqlite } = openDb();
    try {
      const result = await pullPlayer({
        db,
        fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
        url: matchHistory.source.url,
      });
      expect(result.kind).toBe("ok");
      expect(db.select().from(players).all().length).toBeGreaterThan(1);
    } finally {
      sqlite.close();
    }
  });
});
