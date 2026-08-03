// The event-format shape (#63) — a human-typed CLI/MCP string ("S1:singles,D1:doubles,…") turned
// into a validated, ordered court list, and the same list read back out of the stored `events.format`
// column. Both directions share ONE validator so the writer and the reader can never disagree about
// what a legal format is.
//
// Discipline is a CLOSED zod enum here (`singles | doubles`), unlike `derive.ts`'s open `Discipline`
// type — a human-typed format is a different input class from a scraped one, and `derive.ts` places
// any non-"singles" slot as a two-player court, so an unvalidated typo ("single") would silently
// become a doubles court. Refusing names both legal values rather than guessing which one was meant.

import { describe, expect, it } from "vitest";
import {
  InvalidEventFormatError,
  encodeEventFormat,
  parseEventFormat,
  readEventFormat,
} from "../src/query/event-format.js";

describe("parseEventFormat", () => {
  it("parses a comma-separated slot:discipline list, order preserved", () => {
    const result = parseEventFormat("S1:singles,D1:doubles,D2:doubles,D3:doubles");
    expect(result).toEqual([
      { slot: "S1", discipline: "singles" },
      { slot: "D1", discipline: "doubles" },
      { slot: "D2", discipline: "doubles" },
      { slot: "D3", discipline: "doubles" },
    ]);
  });

  it("trims whitespace around entries and around the colon", () => {
    const result = parseEventFormat(" S1 : singles , D1 : doubles ");
    expect(result).toEqual([
      { slot: "S1", discipline: "singles" },
      { slot: "D1", discipline: "doubles" },
    ]);
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["only commas", ",,"],
  ])("refuses %s", (_label, input) => {
    expect(() => parseEventFormat(input)).toThrow(InvalidEventFormatError);
  });

  it("refuses an entry with no colon at all, naming the entry", () => {
    let thrown: unknown;
    try {
      parseEventFormat("S1:singles,D1doubles");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidEventFormatError);
    expect((thrown as Error).message).toContain("D1doubles");
  });

  it("refuses a blank slot", () => {
    expect(() => parseEventFormat(":singles")).toThrow(InvalidEventFormatError);
  });

  it("refuses a blank discipline", () => {
    expect(() => parseEventFormat("S1:")).toThrow(InvalidEventFormatError);
  });

  it.each([
    ["S1:single"],
    ["D1:mixed"],
  ])("refuses an unknown discipline (%s), naming singles/doubles", (input) => {
    let thrown: unknown;
    try {
      parseEventFormat(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidEventFormatError);
    expect((thrown as Error).message).toContain("singles");
    expect((thrown as Error).message).toContain("doubles");
  });

  it("refuses a duplicate slot — it would collapse two courts into one", () => {
    expect(() => parseEventFormat("D1:doubles,D1:doubles")).toThrow(InvalidEventFormatError);
  });

  it("splits on the FIRST colon, so a slot value carrying a second colon lands in the discipline and refuses", () => {
    // "S1:doubles:extra" -> slot "S1", discipline "doubles:extra" (not a legal discipline).
    expect(() => parseEventFormat("S1:doubles:extra")).toThrow(InvalidEventFormatError);
  });

  it("round-trips through encodeEventFormat/readEventFormat unchanged", () => {
    const parsed = parseEventFormat("S1:singles,D1:doubles,D2:doubles,D3:doubles");
    const roundTripped = readEventFormat(encodeEventFormat(parsed));
    expect(roundTripped).toEqual(parsed);
  });
});

describe("readEventFormat", () => {
  // The column is plain `text` (see src/db/schema.ts), so every case below hands this function the
  // RAW stored string — the same thing drizzle returns — rather than an already-parsed value. That
  // distinction is load-bearing: passing a parsed object would make each case trip the "not text"
  // guard and never reach the shape validation it is meant to exercise.
  it("returns null for a null column value", () => {
    expect(readEventFormat(null)).toBeNull();
  });

  it("returns null for an undefined column value", () => {
    expect(readEventFormat(undefined)).toBeNull();
  });

  it("returns the validated list for a well-formed stored value", () => {
    const stored = [
      { slot: "S1", discipline: "singles" as const },
      { slot: "D1", discipline: "doubles" as const },
    ];
    expect(readEventFormat(encodeEventFormat(stored))).toEqual(stored);
  });

  // The case that motivated the column being plain `text` rather than drizzle `{ mode: "json" }`:
  // under json mode this parse ran inside drizzle's row mapper for EVERY reader of the events table,
  // so unparseable bytes threw a raw SyntaxError out of `eventsForDay` (`tn player avail`),
  // `match add` and `addEvent` — four commands with nothing to do with formats — before any guard
  // could see them. Here it is one named refusal, from the only decoder there is.
  it.each([
    ["bytes that are not JSON at all", "not json at all"],
    ["truncated JSON", '[{"slot":"S1","disc'],
    ["the empty string", ""],
    ["a bare word", "S1:singles"],
  ])("fails closed with a NAMED refusal on %s", (_label, raw) => {
    expect(() => readEventFormat(raw)).toThrow(InvalidEventFormatError);
  });

  it("never echoes the unparseable bytes back in the message", () => {
    expect(() => readEventFormat("sekrit-looking garbage")).toThrow(
      /stored event format is not valid JSON — re-record it/,
    );
    try {
      readEventFormat("sekrit-looking garbage");
    } catch (err) {
      expect((err as Error).message).not.toContain("sekrit-looking garbage");
    }
  });

  it.each([
    ["a non-string column value (number)", 42],
    ["a non-string column value (already-parsed array)", [{ slot: "S1", discipline: "singles" }]],
  ])("fails closed on %s", (_label, raw) => {
    expect(() => readEventFormat(raw)).toThrow(InvalidEventFormatError);
  });

  it.each([
    ["valid JSON that is not an array (object)", { slot: "S1", discipline: "singles" }],
    ["valid JSON that is not an array (string)", "S1:singles"],
    ["valid JSON that is not an array (number)", 42],
    ["an array of non-objects", ["S1:singles", "D1:doubles"]],
    ["an empty array", []],
    ["an array of wrong-shaped objects", [{ court: "S1", type: "singles" }]],
    ["an array with an unknown discipline", [{ slot: "S1", discipline: "single" }]],
    ["an array with a duplicate slot", [{ slot: "D1", discipline: "doubles" }, { slot: "D1", discipline: "doubles" }]],
    // A reader that accepts what its own writer cannot produce is not fail-closed. `parseEventFormat`
    // trims before validating, so none of these can ever be WRITTEN — and each does real damage if
    // read: a slot named `" D1 "` matches no observed row, so the team's real `D1` history is
    // silently skipped and the lineup reports a malformed court as supplied by the event; and
    // `"D1"` beside `" D1 "` walks past duplicate detection as two different strings, giving the
    // event two courts where it has one. (Codex adversarial review of PR #82, Finding 2 [medium].)
    ["a slot with leading whitespace", [{ slot: " D1", discipline: "doubles" }]],
    ["a slot with trailing whitespace", [{ slot: "D1 ", discipline: "doubles" }]],
    ["a whitespace-only slot", [{ slot: "   ", discipline: "doubles" }]],
    [
      "a padded duplicate that would bypass distinct-slot detection",
      [{ slot: "D1", discipline: "doubles" }, { slot: " D1 ", discipline: "doubles" }],
    ],
    ["an entry carrying an unknown extra key", [{ slot: "D1", discipline: "doubles", seed: 1 }]],
  ])("fails closed on %s", (_label, decoded) => {
    expect(() => readEventFormat(JSON.stringify(decoded))).toThrow(InvalidEventFormatError);
  });
});
