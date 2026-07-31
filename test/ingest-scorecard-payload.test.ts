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
      expect(result.data.event).toBe("Springfield Sectionals 2026");
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

  it("a court marked defaulted is exempt from the cardinality invariant (nobody played it)", () => {
    const payload = fourCourtPayload();
    payload.courts[1] = {
      slot: "D1",
      discipline: "doubles",
      homePlayers: ["Bo Bramwell", "Cy Calder"],
      visitingPlayers: [],
      defaulted: true,
    };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
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

  it("a bare name and a prefix-ID player entry both parse — resolution happens downstream, not here", () => {
    const payload = fourCourtPayload();
    payload.courts[0] = { ...payload.courts[0]!, homePlayers: ["usta:12345"] };
    const result = scorecardPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
