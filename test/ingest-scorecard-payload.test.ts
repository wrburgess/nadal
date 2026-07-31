import { describe, expect, it } from "vitest";
import { scorecardPayloadSchema } from "../src/ingest/scorecard.js";

// Task 1 (#18): the zod contract an agent's vision extraction must produce, and `tn match add`'s
// payload file must also satisfy — the CLI and MCP tool share this ONE schema so the two surfaces
// cannot silently drift on what counts as a valid scorecard.
//
// Payloads are built as plain `Record<string, unknown>` here (never the schema's own inferred
// type): every sad-path test deliberately constructs an INVALID shape, and fighting the valid
// type for that would just relocate the assertion from the test's own runtime check into a cast.

type RawCourt = Record<string, unknown>;
type RawPayload = Record<string, unknown> & { courts: RawCourt[] };

function fourCourtPayload(): RawPayload {
  return {
    playedOn: "2026-08-28",
    homeTeam: "IA/Versteeg/40&Over3.5M",
    visitingTeam: "Report Opponent",
    courts: [
      { slot: "S1", discipline: "singles", homePlayers: ["Ada Ashby"], visitingPlayers: ["Opp One"] },
      {
        slot: "D1",
        discipline: "doubles",
        homePlayers: ["Bo Bramwell", "Cy Calder"],
        visitingPlayers: ["Opp Two", "Opp Three"],
      },
      {
        slot: "D2",
        discipline: "doubles",
        homePlayers: ["Dev Duxbury", "Ella Ellerby"],
        visitingPlayers: ["Opp Four", "Opp Five"],
      },
      {
        slot: "D3",
        discipline: "doubles",
        homePlayers: ["Finn Farrow", "Gwen Gable"],
        visitingPlayers: ["Opp Six", "Opp Seven"],
      },
    ],
  };
}

describe("scorecardPayloadSchema", () => {
  it("happy: a four-court payload (S1, D1, D2, D3) parses", () => {
    const result = scorecardPayloadSchema.safeParse(fourCourtPayload());
    expect(result.success).toBe(true);
  });

  it("boundary: five courts (S1 + D1-D4, Tulsa 2025's shape) parses — the slot set is not hardcoded", () => {
    const payload = fourCourtPayload();
    payload.courts.push({
      slot: "D4",
      discipline: "doubles",
      homePlayers: ["Harlan Hartwell", "Ira Inglewood"],
      visitingPlayers: ["Opp Eight", "Opp Nine"],
    });
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("optional fields round-trip: event, scheduledTime, site, sourceImage, winnerSide, score", () => {
    const payload = fourCourtPayload();
    const withOptionals: RawPayload = {
      ...payload,
      event: "Springfield Sectionals 2026",
      scheduledTime: "9:00 AM",
      site: "Clayview Country Club",
      sourceImage: "/tmp/scorecard.png",
      courts: [{ ...payload.courts[0]!, winnerSide: "home", score: "6-3 6-4" }, ...payload.courts.slice(1)],
    };
    const result = scorecardPayloadSchema.safeParse(withOptionals);
    expect(result.success).toBe(true);
    if (result.success) {
      // All six named fields, not just the three the title used to claim without checking —
      // scheduledTime/site/sourceImage previously round-tripped only by the schema's own good
      // behavior, never by anything this test actually verified.
      expect(result.data.event).toBe("Springfield Sectionals 2026");
      expect(result.data.scheduledTime).toBe("9:00 AM");
      expect(result.data.site).toBe("Clayview Country Club");
      expect(result.data.sourceImage).toBe("/tmp/scorecard.png");
      expect(result.data.courts[0]?.winnerSide).toBe("home");
      expect(result.data.courts[0]?.score).toBe("6-3 6-4");
    }
  });

  it("sad: singles with two players per side fails on the cardinality invariant, not on shape alone", () => {
    const payload = fourCourtPayload();
    payload.courts[0] = {
      slot: "S1",
      discipline: "singles",
      homePlayers: ["Ada Ashby", "Extra Player"],
      visitingPlayers: ["Opp One"],
    };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("homePlayers"))).toBe(true);
    }
  });

  it("sad: doubles with one player per side fails the cardinality invariant", () => {
    const payload = fourCourtPayload();
    payload.courts[1] = {
      slot: "D1",
      discipline: "doubles",
      homePlayers: ["Bo Bramwell"],
      visitingPlayers: ["Opp Two", "Opp Three"],
    };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("homePlayers"))).toBe(true);
    }
  });

  it("a court marked defaulted is exempt from the cardinality invariant when BOTH sides are empty (nobody played it)", () => {
    const payload = fourCourtPayload();
    payload.courts[1] = {
      slot: "D1",
      discipline: "doubles",
      homePlayers: [],
      visitingPlayers: [],
      defaulted: true,
    };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // Codex adversarial review of PR #54 round 3, High finding 3: `defaulted: true` used to skip the
  // cardinality check ENTIRELY, so a payload could claim "nobody played" while still supplying (and
  // persisting) a full, roster-valid set of participants — a 3-vs-1 doubles court, say. `defaulted`
  // means nobody played, which means no participants; it is not merely an escape hatch from the
  // per-discipline COUNT rule.
  it("REGRESSION (Codex High finding 3): a defaulted court with players still present on either side fails — nobody played means no participants", () => {
    const payload = fourCourtPayload();
    payload.courts[1] = {
      slot: "D1",
      discipline: "doubles",
      homePlayers: ["Bo Bramwell", "Cy Calder"],
      visitingPlayers: [],
      defaulted: true,
    };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("homePlayers"))).toBe(true);
    }
  });

  it("REGRESSION (Codex High finding 3, the reviewer's concrete case): defaulted D1 with home [Ada, Bo, Cy] and visiting [Opp One] fails, not just an unbalanced count", () => {
    const payload = fourCourtPayload();
    payload.courts[1] = {
      slot: "D1",
      discipline: "doubles",
      homePlayers: ["Ada Ashby", "Bo Bramwell", "Cy Calder"],
      visitingPlayers: ["Opp One"],
      defaulted: true,
    };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("homePlayers"))).toBe(true);
      expect(result.error.issues.some((i) => i.path.includes("visitingPlayers"))).toBe(true);
    }
  });

  it("a defaulted court with only ONE side non-empty still fails — both sides must be empty, not just balanced", () => {
    const payload = fourCourtPayload();
    payload.courts[1] = {
      slot: "D1",
      discipline: "doubles",
      homePlayers: [],
      visitingPlayers: ["Opp Two"],
      defaulted: true,
    };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("visitingPlayers"))).toBe(true);
    }
  });

  it("sad: zero courts fails", () => {
    const payload = { ...fourCourtPayload(), courts: [] };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("sad: missing playedOn fails", () => {
    const payload = fourCourtPayload();
    delete payload.playedOn;
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("sad: a malformed calendar date (2026-02-31) fails, not just the pattern check", () => {
    const payload = { ...fourCourtPayload(), playedOn: "2026-02-31" };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("sad: winnerSide outside home|visiting fails", () => {
    const payload = fourCourtPayload();
    payload.courts[0] = { ...payload.courts[0]!, winnerSide: "north" };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("sad: a court missing slot fails", () => {
    const payload = fourCourtPayload();
    const withoutSlot = { ...payload.courts[0]! };
    delete withoutSlot.slot;
    payload.courts[0] = withoutSlot;
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  // Codex adversarial review (PR #54 round 7, rated Medium): `slot` was accepted as any non-empty
  // string and compared by raw equality downstream (the duplicate-slot count, the id-less court
  // upsert's write key), so `"D1"` and `"D1 "` were two DIFFERENT courts as far as either consumer
  // could tell — evading the duplicate-slot refusal within one payload, and creating a SECOND court
  // row on a re-ingest correction that used the whitespace-padded spelling instead of replacing the
  // first. Fixed by canonicalizing ONCE, here, so every downstream consumer sees the identical
  // trimmed string — the same "one ladder, one notion of a name" shape `nameKey` already closed for
  // team/player names and `normalizeTimeKey`/`normalizeSiteKey` closed for the parent-match
  // discriminators, arriving now through a payload field neither of those covers.
  it("REGRESSION (Codex round 7, rated Medium): a slot with leading/trailing whitespace is trimmed to its canonical form", () => {
    const payload = fourCourtPayload();
    payload.courts[0] = { ...payload.courts[0]!, slot: " D1 " };
    // Give it a distinct slot from the other courts so this parses on its own merits.
    payload.courts[1] = { ...payload.courts[1]!, slot: "D5" };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.courts[0]?.slot).toBe("D1");
  });

  it("REGRESSION (Codex round 7): a slot that is whitespace-only fails — trimming it leaves nothing", () => {
    const payload = fourCourtPayload();
    payload.courts[0] = { ...payload.courts[0]!, slot: "   " };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("a bare name and a prefix-ID player entry both parse — resolution happens downstream, not here", () => {
    const payload = fourCourtPayload();
    payload.courts[0] = { ...payload.courts[0]!, homePlayers: ["usta:12345"] };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
