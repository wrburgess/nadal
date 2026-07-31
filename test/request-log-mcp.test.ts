import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/client.js";
import { logMcpTool } from "../src/telemetry/request-log.js";
import { useTnDbPath } from "./helpers/tn-db.js";

const fixture = useTnDbPath();

beforeEach(() => {
  runMigrations(fixture.path());
});

function rows() {
  const sqlite = new Database(fixture.path());
  const r = sqlite.prepare("SELECT * FROM request_log").all() as Array<Record<string, unknown>>;
  sqlite.close();
  return r;
}

class BoomError extends Error {}

describe("logMcpTool", () => {
  it("writes surface=mcp, the tool name, sanitized args, start/end timestamps, and outcome=ok, returning the value", async () => {
    const result = await logMcpTool("team_show", { name: "Team A" }, async () => ({ teamName: "Team A" }));

    expect(result).toEqual({ teamName: "Team A" });
    const [row] = rows();
    expect(row).toMatchObject({ surface: "mcp", command: "team_show", outcome: "ok" });
    expect(row?.started_at).toBeTruthy();
    expect(row?.ended_at).toBeTruthy();
    expect(JSON.parse(String(row?.args))).toEqual({ name: "Team A" });
  });

  it("records outcome=error:<ClassName> AND still propagates the thrown error — telemetry must not swallow a tool failure", async () => {
    await expect(
      logMcpTool("player_note", { name: "X" }, async () => {
        throw new BoomError("boom");
      }),
    ).rejects.toBeInstanceOf(BoomError);

    const [row] = rows();
    expect(row?.outcome).toBe("error:BoomError");
    expect(row?.command).toBe("player_note");
  });

  it("sanitizes control and bidi characters embedded anywhere in the args object before persisting", async () => {
    const rtlOverride = String.fromCharCode(0x202e);
    const dirty = { name: `a\nb`, note: `c${rtlOverride}d`, nested: { text: `e\nf` } };

    await logMcpTool("player_note", dirty, async () => "ok");

    const [row] = rows();
    const storedArgs = JSON.parse(String(row?.args)) as Record<string, unknown>;
    expect(storedArgs).toEqual({ name: "a b", note: "c d", nested: { text: "e f" } });
  });

  it("sanitizes control/bidi characters inside array-valued args too", async () => {
    const rtlOverride = String.fromCharCode(0x202e);
    await logMcpTool("player_note", { tags: [`x\ny`, `z${rtlOverride}w`] }, async () => "ok");

    const [row] = rows();
    const storedArgs = JSON.parse(String(row?.args)) as { tags: string[] };
    expect(storedArgs.tags).toEqual(["x y", "z w"]);
  });

  it("a failing telemetry write does not break the tool call (mirrors the existing CLI case)", async () => {
    const seed = new Database(fixture.path());
    seed.exec("DROP TABLE request_log");
    seed.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await logMcpTool("team_show", {}, async () => "ok-value");
      expect(result).toBe("ok-value");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("telemetry: request_log write failed"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a failing telemetry write on the ERROR path still propagates the original tool error, not a telemetry error", async () => {
    const seed = new Database(fixture.path());
    seed.exec("DROP TABLE request_log");
    seed.close();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      logMcpTool("player_note", {}, async () => {
        throw new BoomError("boom");
      }),
    ).rejects.toBeInstanceOf(BoomError);
  });
});
