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
import { InvalidEventFormatError, parseEventFormat, readEventFormat } from "../src/query/event-format.js";

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

  it("round-trips through JSON.stringify/parse into readEventFormat unchanged", () => {
    const parsed = parseEventFormat("S1:singles,D1:doubles,D2:doubles,D3:doubles");
    const roundTripped = readEventFormat(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

describe("readEventFormat", () => {
  it("returns null for a null column value", () => {
    expect(readEventFormat(null)).toBeNull();
  });

  it("returns the validated list for a well-formed stored value", () => {
    const stored = [
      { slot: "S1", discipline: "singles" },
      { slot: "D1", discipline: "doubles" },
    ];
    expect(readEventFormat(stored)).toEqual(stored);
  });

  it.each([
    ["a non-array (plain object)", { slot: "S1", discipline: "singles" }],
    ["a non-array (string)", "S1:singles"],
    ["a non-array (number)", 42],
    ["an array of non-objects", ["S1:singles", "D1:doubles"]],
    ["an empty array", []],
    ["an array of wrong-shaped objects", [{ court: "S1", type: "singles" }]],
    ["an array with an unknown discipline", [{ slot: "S1", discipline: "single" }]],
    ["an array with a duplicate slot", [{ slot: "D1", discipline: "doubles" }, { slot: "D1", discipline: "doubles" }]],
  ])("fails closed on %s", (_label, raw) => {
    expect(() => readEventFormat(raw)).toThrow(InvalidEventFormatError);
  });
});
