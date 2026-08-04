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
import { courtMatchPlayers, courtMatches, players, ratingObservations } from "../src/db/schema.js";
import { AmbiguousIdentityError, ambiguousMessage, type AmbiguousIdentity } from "../src/ingest/errors.js";
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

  // #96. One pass can meet SEVERAL ambiguities, and reporting only the first costs a slow network
  // round trip per remaining one (measured: Dale Dixon, 4 attempts; NE/Penland, 3 full team runs).
  // They render through the SAME formatter — a second one is a second shape for one event, which is
  // the drift `ambiguousMessage` was moved into this module to prevent.
  describe("ambiguousMessage renders a whole pass, not only its first ambiguity (#96)", () => {
    const PARTNER: AmbiguousIdentity = {
      incoming: "Brian Beene",
      candidates: ["Bryan Beene"],
      context: "match partner",
    };
    const OPPONENT: AmbiguousIdentity = {
      incoming: "Ryan Johnson",
      candidates: ["Ryan Johnsen", "Ryan Johnston"],
      context: "match opponent",
    };
    const PROFILE: AmbiguousIdentity = {
      incoming: "Jeff O'Connor",
      candidates: ["Jeff O'Conner"],
      context: "player profile name",
    };

    // A list of ONE is the same event as a bare one, so it renders identically — #94's shape,
    // byte for byte, which seven assertions in this file already depend on.
    it("a list of one renders exactly what the bare identity renders", () => {
      expect(ambiguousMessage({ identities: [PARTNER] })).toBe(ambiguousMessage(PARTNER));
      expect(ambiguousMessage({ identities: [PARTNER] })).toBe(
        'ambiguous identity "Brian Beene" (match partner) — near: Bryan Beene',
      );
    });

    it("several render on ONE line, each numbered, with the count stated up front", () => {
      expect(ambiguousMessage({ identities: [PARTNER, OPPONENT, PROFILE] })).toBe(
        "3 ambiguous identities — " +
          '[1] "Brian Beene" (match partner) — near: Bryan Beene; ' +
          '[2] "Ryan Johnson" (match opponent) — near: Ryan Johnsen, Ryan Johnston; ' +
          `[3] "Jeff O'Connor" (player profile name) — near: Jeff O'Conner`,
      );
    });

    // Every consumer sanitizes the RENDERED line as one string, which only works while the line is
    // one line. A multi-line report would also break `emitSummary`'s one-line contract silently.
    it("never spans lines, however many it carries", () => {
      const rendered = ambiguousMessage({ identities: [PARTNER, OPPONENT, PROFILE] });
      expect(rendered.split(String.fromCharCode(10))).toHaveLength(1);
    });

    // The count is computed from the LIST, never from the rendered text, so a scraped name that
    // spells the entry markers cannot manufacture an entry — it can only contradict the count.
    // Asserted as the whole line, including what the forgery attempt actually produces, rather than
    // claiming an escaping guarantee this format does not have.
    it("a hostile incoming name cannot forge an entry — the stated count comes from the list", () => {
      const forged: AmbiguousIdentity = {
        incoming: '"; [3] "Ghost Player',
        candidates: ["Nova Norbiry"],
        context: "match partner",
      };
      expect(ambiguousMessage({ identities: [forged, OPPONENT] })).toBe(
        "2 ambiguous identities — " +
          '[1] ""; [3] "Ghost Player" (match partner) — near: Nova Norbiry; ' +
          '[2] "Ryan Johnson" (match opponent) — near: Ryan Johnsen, Ryan Johnston',
      );
    });
  });

  describe("AmbiguousIdentityError", () => {
    it("carries the three facts as fields", () => {
      const err = new AmbiguousIdentityError([
        { incoming: "Karson Davis", candidates: ["Mason Davis"], context: "match partner" },
      ]);
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
      expect(new AmbiguousIdentityError([identity]).message).toBe(ambiguousMessage(identity));
    });

    // #96: the error is what carries a whole pass's collection out of the transaction it rolls back,
    // so it holds the LIST and mirrors its first entry onto the three flat fields. The mirror is not
    // decoration — `archived.ts` and `team-pull.ts` build their single-identity results from it, and
    // it is what an unexpected rethrow shows.
    it("carries every identity of the pass, and its message reports all of them", () => {
      const first = { incoming: "Brian Beene", candidates: ["Bryan Beene"], context: "match opponent" };
      const second = { incoming: "Ryan Johnson", candidates: ["Ryan Johnsen"], context: "match partner" };
      const err = new AmbiguousIdentityError([first, second]);

      expect(err.identities).toEqual([first, second]);
      expect(err.incoming).toBe("Brian Beene");
      expect(err.message).toBe(ambiguousMessage({ identities: [first, second] }));
      expect(err.message).toBe(
        "2 ambiguous identities — " +
          '[1] "Brian Beene" (match opponent) — near: Bryan Beene; ' +
          '[2] "Ryan Johnson" (match partner) — near: Ryan Johnsen',
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

  // #96 finding 2. An ambiguous identity aborts the whole player pull — correctly, and #94 depends
  // on that rollback — but it used to abort at the FIRST one, so N ambiguities in one player's
  // history cost N slow network round trips to surface. Measured live: Dale Dixon took 4 attempts
  // (Brian Beene → Ryan Johnson → Jeff O'Connor → ok), and NE/Penland needed three full `--players`
  // runs (~4 min each) because every run re-fetches every roster member to reach the next one.
  //
  // This does not weaken the abort. One refusal, one rollback, zero rows — the pass now REPORTS
  // everything it met on the way there.
  describe("pullPlayer collects every ambiguity of the pass, not just the first (#96)", () => {
    it("reports each one in encounter order, and a name met three times exactly once", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const nearPartner = oneEditAway(FIRST_PARTNER);
        const nearOpponent = oneEditAway(FIRST_OPPONENT);
        resolvePlayer(db, { name: nearPartner });
        resolvePlayer(db, { name: nearOpponent });

        const result = await pullPlayer({
          db,
          fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
          url: matchHistory.source.url,
        });

        expect(result.kind).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error("expected ambiguous");

        // Encounter order: the fixture's first record names its partner before its opponents. The
        // partner (`Nova Norbury`) is named in THREE of the 14 records, and appears here once — a
        // repeated ambiguity is one decision for a human, not three lines of report.
        expect(result.identities).toEqual([
          { incoming: FIRST_PARTNER, candidates: [nearPartner], context: "match partner" },
          { incoming: FIRST_OPPONENT, candidates: [nearOpponent], context: "match opponent" },
        ]);

        // The three flat fields are `identities[0]`, so every reader written against the #94 shape
        // (both CLI commands, both MCP pull tools) keeps reporting a true fact.
        expect(result).toMatchObject({
          incoming: FIRST_PARTNER,
          candidates: [nearPartner],
          context: "match partner",
        });

        // What an operator actually reads — one line, both decisions, ruled in one sitting.
        expect(ambiguousMessage(result)).toBe(
          "2 ambiguous identities — " +
            `[1] "${FIRST_PARTNER}" (match partner) — near: ${nearPartner}; ` +
            `[2] "${FIRST_OPPONENT}" (match opponent) — near: ${nearOpponent}`,
        );
      } finally {
        sqlite.close();
      }
    });

    // Collecting means the pass keeps RESOLVING after the first refusal, and resolution creates rows
    // for names it has never seen. So "still writes nothing" is re-read from the database rather
    // than inferred from the returned kind — the rollback is the whole reason this is safe to do.
    //
    // Labelled deliberately: GREEN before and after, because it pins what the FIX could break rather
    // than what the issue reports, and an unlabelled always-green test reads as one that cannot
    // fail. Verified by mutation instead: writing the court matches before the refusal reddens it.
    it("still writes NOTHING — the rollback the whole design depends on is unchanged", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const seeded = [oneEditAway(FIRST_PARTNER), oneEditAway(FIRST_OPPONENT)];
        for (const name of seeded) resolvePlayer(db, { name });

        const result = await pullPlayer({
          db,
          fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
          url: matchHistory.source.url,
        });

        expect(result.kind).toBe("ambiguous");
        // Not one row for the profiled player, nor for any of the 30-odd names met while scanning
        // the history past the first refusal.
        expect(db.select().from(players).all().map((p) => p.canonicalName).sort()).toEqual([...seeded].sort());
        expect(db.select().from(courtMatches).all()).toHaveLength(0);
        expect(db.select().from(courtMatchPlayers).all()).toHaveLength(0);
        expect(db.select().from(ratingObservations).all()).toHaveLength(0);
      } finally {
        sqlite.close();
      }
    });

    // The profiled player's own name being ambiguous used to abort before a single history name was
    // looked at, so the operator ruled on it, re-ran, and met the history's ambiguities one at a
    // time from there. All of them are reachable in the same pass.
    it("an ambiguous PROFILE name no longer hides the history's ambiguities behind it", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const nearProfiled = oneEditAway(PROFILED);
        const nearPartner = oneEditAway(FIRST_PARTNER);
        resolvePlayer(db, { name: nearProfiled });
        resolvePlayer(db, { name: nearPartner });

        const result = await pullPlayer({
          db,
          fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
          url: matchHistory.source.url,
        });

        expect(result.kind).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
        expect(result.identities).toEqual([
          { incoming: PROFILED, candidates: [nearProfiled], context: "player profile name" },
          { incoming: FIRST_PARTNER, candidates: [nearPartner], context: "match partner" },
        ]);
      } finally {
        sqlite.close();
      }
    });

    // Non-vacuity for this whole block: ONE seeded near-name still reports exactly one identity, so
    // the assertions above are pinning the collection and not merely the fixture's shape.
    it("one ambiguity is still reported as one — the plural form is not a new floor", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const nearPartner = oneEditAway(FIRST_PARTNER);
        resolvePlayer(db, { name: nearPartner });

        const result = await pullPlayer({
          db,
          fetchPage: createStubFetcher({ [matchHistory.source.url]: { body: matchHistory.html } }),
          url: matchHistory.source.url,
        });

        expect(result.kind).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
        expect(result.identities).toHaveLength(1);
        expect(ambiguousMessage(result)).toBe(
          `ambiguous identity "${FIRST_PARTNER}" (match partner) — near: ${nearPartner}`,
        );
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

    // #96. The cascade is where the one-per-attempt cost was measured (NE/Penland: three full
    // `--players` runs, ~4 min each, to surface 6 ambiguities, because each run re-fetches every
    // roster member to reach the next one). One run, one warning, every decision — on one line,
    // because the line is sanitized as ONE rendered string and a multi-line report cannot be.
    it("the cascade warning carries EVERY ambiguity the cascaded pull met, on one line", async () => {
      runMigrations();
      const { db, sqlite } = openDb();
      try {
        const nearPartner = oneEditAway(FIRST_PARTNER);
        const nearOpponent = oneEditAway(FIRST_OPPONENT);
        resolvePlayer(db, { name: nearPartner });
        resolvePlayer(db, { name: nearOpponent });

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

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("expected ok");
        expect(result.skippedRosterEntries).toEqual([PROFILED]);

        expect(warnSpy).toHaveBeenCalledWith(
          `team pull: cascading "${PROFILED}" failed (ambiguous) — 2 ambiguous identities — ` +
            `[1] "${FIRST_PARTNER}" (match partner) — near: ${nearPartner}; ` +
            `[2] "${FIRST_OPPONENT}" (match opponent) — near: ${nearOpponent} — skipped`,
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
