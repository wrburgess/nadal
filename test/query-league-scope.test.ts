// The league-scope shape (#97) — a human-typed CLI/MCP string ("exclude:Mixed") turned into a
// validated scope, the same scope read back out of the stored `events.league_scope` column, and the
// one predicate that decides whether a court match survives it.
//
// The twin of `query-event-format.test.ts`, deliberately: `league-scope.ts` is modelled on
// `event-format.ts` line for line, including the round-trip guard on the stored value, so the
// hardening three Codex rounds put into that module is not re-learned here from scratch.

import { describe, expect, it } from "vitest";
import {
  InvalidLeagueScopeError,
  encodeLeagueScope,
  leagueScopeLabel,
  leagueScopeRetains,
  leagueScopeText,
  parseLeagueScope,
  readLeagueScope,
} from "../src/query/league-scope.js";

describe("parseLeagueScope", () => {
  it("parses an exclusion with a single prefix", () => {
    expect(parseLeagueScope("exclude:Mixed")).toEqual({ mode: "exclude", prefixes: ["Mixed"] });
  });

  it("parses the exact inverse — the September mixed-doubles event reuses it", () => {
    expect(parseLeagueScope("only:Mixed")).toEqual({ mode: "only", prefixes: ["Mixed"] });
  });

  it("parses several comma-separated prefixes, order preserved", () => {
    expect(parseLeagueScope("exclude:Mixed,Combo,Tri-Level")).toEqual({
      mode: "exclude",
      prefixes: ["Mixed", "Combo", "Tri-Level"],
    });
  });

  it("trims whitespace around the mode, the colon, and each prefix", () => {
    expect(parseLeagueScope("  exclude : Mixed , Combo ")).toEqual({
      mode: "exclude",
      prefixes: ["Mixed", "Combo"],
    });
  });

  it("splits on the FIRST colon only, so a prefix may itself contain one", () => {
    expect(parseLeagueScope("exclude:Mixed:Other")).toEqual({ mode: "exclude", prefixes: ["Mixed:Other"] });
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "   "],
  ])("refuses %s", (_label, input) => {
    expect(() => parseLeagueScope(input)).toThrow(InvalidLeagueScopeError);
  });

  it("refuses an input with no colon at all, naming what was typed", () => {
    let thrown: unknown;
    try {
      parseLeagueScope("excludeMixed");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidLeagueScopeError);
    expect((thrown as Error).message).toContain("excludeMixed");
  });

  it("refuses an unknown mode, naming both legal ones", () => {
    let thrown: unknown;
    try {
      parseLeagueScope("drop:Mixed");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidLeagueScopeError);
    expect((thrown as Error).message).toContain("drop");
    expect((thrown as Error).message).toContain("exclude");
    expect((thrown as Error).message).toContain("only");
  });

  it("refuses a mode in the wrong case rather than folding it — a closed enum, like discipline", () => {
    expect(() => parseLeagueScope("Exclude:Mixed")).toThrow(InvalidLeagueScopeError);
  });

  it("refuses an empty prefix list", () => {
    expect(() => parseLeagueScope("exclude:")).toThrow(InvalidLeagueScopeError);
  });

  it("refuses a blank prefix among real ones, rather than silently dropping it", () => {
    expect(() => parseLeagueScope("exclude:Mixed,,Combo")).toThrow(InvalidLeagueScopeError);
  });

  it("refuses a repeated prefix", () => {
    let thrown: unknown;
    try {
      parseLeagueScope("exclude:Mixed,Mixed");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidLeagueScopeError);
    expect((thrown as Error).message).toContain("Mixed");
  });

  it("refuses a prefix repeated only in case — the match itself is case-insensitive, so they are one rule", () => {
    expect(() => parseLeagueScope("exclude:Mixed,MIXED")).toThrow(InvalidLeagueScopeError);
  });
});

describe("leagueScopeText", () => {
  it("is the exact string that would produce the scope", () => {
    expect(leagueScopeText({ mode: "exclude", prefixes: ["Mixed", "Combo"] })).toBe("exclude:Mixed,Combo");
  });

  it("round-trips through parseLeagueScope", () => {
    const scope = parseLeagueScope("only:Mixed,Combo");
    expect(parseLeagueScope(leagueScopeText(scope))).toEqual(scope);
  });
});

describe("readLeagueScope", () => {
  it("returns null for a null column — no scope recorded", () => {
    expect(readLeagueScope(null)).toBeNull();
  });

  it("returns null for undefined, the shape a missing column read has", () => {
    expect(readLeagueScope(undefined)).toBeNull();
  });

  it("decodes what encodeLeagueScope wrote", () => {
    const scope = parseLeagueScope("exclude:Mixed");
    expect(readLeagueScope(encodeLeagueScope(scope))).toEqual(scope);
  });

  it("refuses a non-text column value", () => {
    expect(() => readLeagueScope(42)).toThrow(InvalidLeagueScopeError);
  });

  it("refuses unparseable JSON without echoing the stored bytes", () => {
    let thrown: unknown;
    try {
      readLeagueScope("{not json");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidLeagueScopeError);
    expect((thrown as Error).message).not.toContain("{not json");
  });

  it.each([
    ["an array", JSON.stringify([{ mode: "exclude", prefixes: ["Mixed"] }])],
    ["a bare string", JSON.stringify("exclude:Mixed")],
    ["null inside the JSON", JSON.stringify(null)],
    ["an unknown mode", JSON.stringify({ mode: "drop", prefixes: ["Mixed"] })],
    ["a missing prefixes key", JSON.stringify({ mode: "exclude" })],
    ["an empty prefixes array", JSON.stringify({ mode: "exclude", prefixes: [] })],
    ["a non-string prefix", JSON.stringify({ mode: "exclude", prefixes: [7] })],
    ["a blank prefix", JSON.stringify({ mode: "exclude", prefixes: [""] })],
    ["an extra key our writer never emits", JSON.stringify({ mode: "exclude", prefixes: ["Mixed"], extra: 1 })],
  ])("refuses %s", (_label, raw) => {
    expect(() => readLeagueScope(raw)).toThrow(InvalidLeagueScopeError);
  });

  // The round-trip guard, derived from the grammar rather than enumerated — the same argument
  // `assertWriterCouldHaveProduced` makes in event-format.ts. A comma is a delimiter, so a prefix
  // containing one is UNWRITABLE and must be refused on read; a colon is not (only the first splits),
  // so a prefix containing one IS writable and must be accepted. A character blacklist gets the
  // second case wrong.
  it("refuses a prefix containing the list delimiter — no `tn event add` could have written it", () => {
    let thrown: unknown;
    try {
      readLeagueScope(JSON.stringify({ mode: "exclude", prefixes: ["Mixed,Combo"] }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidLeagueScopeError);
    // This one reaches the guard's NOT-EQUAL branch rather than its throw branch — `"Mixed,Combo"`
    // re-parses fine, into TWO prefixes, which is exactly why it is not what the writer emitted.
    // The message must therefore name the stored value, which is the operator-actionable part.
    expect((thrown as Error).message).toContain("Mixed,Combo");
    expect((thrown as Error).message).toContain("tn event add");
  });

  it("refuses a prefix the grammar cannot even re-parse, via the guard's other branch", () => {
    let thrown: unknown;
    try {
      // A lone comma re-parses to a blank prefix, which `parseLeagueScope` refuses outright — so
      // this exercises the throw branch the case above deliberately does not reach.
      readLeagueScope(JSON.stringify({ mode: "exclude", prefixes: [","] }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidLeagueScopeError);
    expect((thrown as Error).message).toContain("could have written");
  });

  it("accepts a prefix containing a colon, which the grammar CAN write", () => {
    expect(readLeagueScope(JSON.stringify({ mode: "exclude", prefixes: ["Mixed:Other"] }))).toEqual({
      mode: "exclude",
      prefixes: ["Mixed:Other"],
    });
  });

  it("refuses a stored prefix carrying whitespace the writer would have trimmed off", () => {
    expect(() => readLeagueScope(JSON.stringify({ mode: "exclude", prefixes: [" Mixed"] }))).toThrow(
      InvalidLeagueScopeError,
    );
  });
});

describe("leagueScopeRetains", () => {
  const exclude = { mode: "exclude", prefixes: ["Mixed"] } as const;
  const only = { mode: "only", prefixes: ["Mixed"] } as const;

  it("drops a matching row under exclude", () => {
    expect(leagueScopeRetains("Mixed 40+ 7.0", exclude)).toBe(false);
  });

  it("keeps a non-matching row under exclude", () => {
    expect(leagueScopeRetains("Adult 40+ 3.5", exclude)).toBe(true);
  });

  it("keeps a matching row under only", () => {
    expect(leagueScopeRetains("Mixed 40+ 7.0", only)).toBe(true);
  });

  it("drops a non-matching row under only", () => {
    expect(leagueScopeRetains("Adult 40+ 3.5", only)).toBe(false);
  });

  it("matches on a PREFIX, not on containment — 'Adult 40+ Mixed-ish' is not Mixed play", () => {
    expect(leagueScopeRetains("Adult 40+ Mixed-ish 3.5", exclude)).toBe(true);
  });

  // SQLite's own `LIKE` folds ASCII case, so `NOT LIKE 'Mixed%'` — the predicate this scope
  // implements — would already have excluded these. Matching case-sensitively here would be a
  // NARROWER filter than the one the ruling named, and a source that starts emitting a different
  // casing would silently re-open the defect.
  it.each(["MIXED 40+ 7.0", "mixed 40+ 7.0", "MiXeD Other 8.0"])("folds case: %s is Mixed play", (league) => {
    expect(leagueScopeRetains(league, exclude)).toBe(false);
    expect(leagueScopeRetains(league, only)).toBe(true);
  });

  it("matches any prefix in the list, not only the first", () => {
    const scope = { mode: "exclude", prefixes: ["Mixed", "Combo"] } as const;
    expect(leagueScopeRetains("Combo 6.5", scope)).toBe(false);
  });

  // The NULL rule, in both directions, stated once: a scope removes only what it can positively
  // classify. `src/ingest/match-add.ts` writes a null league context for EVERY court recorded from an
  // in-event scorecard photo — the event's own courts — so a rule that dropped unclassified rows
  // would discard the most in-scope evidence there is, under both modes.
  it("keeps an unclassified (null) row under exclude", () => {
    expect(leagueScopeRetains(null, exclude)).toBe(true);
  });

  it("keeps an unclassified (null) row under only, too — the rule does not flip with the mode", () => {
    expect(leagueScopeRetains(null, only)).toBe(true);
  });
});

describe("leagueScopeLabel", () => {
  it("names the exclusion in words a captain can read", () => {
    expect(leagueScopeLabel({ mode: "exclude", prefixes: ["Mixed"] })).toBe(
      'excluding league contexts starting with "Mixed"',
    );
  });

  it("names the inverse distinctly — the two must not read alike", () => {
    expect(leagueScopeLabel({ mode: "only", prefixes: ["Mixed"] })).toBe(
      'only league contexts starting with "Mixed"',
    );
  });

  it("lists every prefix", () => {
    expect(leagueScopeLabel({ mode: "exclude", prefixes: ["Mixed", "Combo"] })).toBe(
      'excluding league contexts starting with "Mixed" or "Combo"',
    );
  });
});
