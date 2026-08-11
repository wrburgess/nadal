import { describe, expect, it } from "vitest";
import { findUsDate, parseUsDate } from "../src/parsers/dom.js";

describe("findUsDate", () => {
  it("finds the date inside a longer label", () => {
    // The shape both callers actually meet: the date is never the whole string. USTA's NTRP block
    // reads `Updated Date 12/31/24` and the WTN widget's subtitle reads `Updated 08/05/2026`.
    expect(findUsDate("Updated Date 12/31/24")).toBe("2024-12-31");
    expect(findUsDate("Updated 08/05/2026")).toBe("2026-08-05");
    expect(findUsDate("Last Played 06/10/2025")).toBe("2025-06-10");
  });

  it("reads a two-digit year as 20xx, the rule the NTRP date already ran on", () => {
    expect(findUsDate("Updated 11/26/25")).toBe("2025-11-26");
  });

  it("does not truncate a four-digit year to its first two digits", () => {
    // The defect this extraction surfaced, pinned so it cannot come back. `parseNtrp` carried
    // `(\d{2}|\d{4})`, and JS alternation is leftmost-wins rather than longest-match: against
    // `2026` the `\d{2}` branch matches `20` and the date reads `2020-08-05` — plausible, five
    // years wrong, and silent. It was unreachable there because USTA's NTRP block always prints a
    // two-digit year; the WTN subtitles this helper now also serves print four.
    expect(findUsDate("Updated 08/05/2026")).not.toBe("2020-08-05");
    expect(findUsDate("Updated 12/31/2024")).toBe("2024-12-31");
  });

  it("zero-pads a single-digit month and day", () => {
    expect(findUsDate("Updated 8/5/2026")).toBe("2026-08-05");
  });

  it("returns null rather than a malformed ISO string when there is no date", () => {
    // `null` and not a partial date: a caller that must refuse can only do so if "no date" is
    // distinguishable from "some date". A half-built `2026--` would read as a value.
    expect(findUsDate("Updated soon")).toBeNull();
    expect(findUsDate("")).toBeNull();
    expect(findUsDate(undefined)).toBeNull();
  });
});

describe("parseUsDate", () => {
  it("still requires the whole cell to be the date", () => {
    // The contract its eight TennisRecord callers depend on: a cell carrying a date PLUS other text
    // is not a date cell. `findUsDate` above is the deliberately different question, and widening
    // this one to match it would silently start reading dates out of prose cells.
    expect(parseUsDate("11/15/2025")).toBe("2025-11-15");
    expect(parseUsDate("Updated 11/15/2025")).toBeNull();
  });

  it("shares its conversion with findUsDate", () => {
    // One derivation, two questions. If the two ever build the ISO string separately, this is the
    // assertion that notices.
    expect(parseUsDate("8/5/2026")).toBe(findUsDate("on 8/5/2026"));
  });
});
