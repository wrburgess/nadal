import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../src/db/client.js";
import { runMigrations } from "../src/db/client.js";
import { logRequest } from "../src/telemetry/request-log.js";
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

describe("request telemetry", () => {
  it("logs surface, command, args, timestamps, and ok outcome", async () => {
    const code = await logRequest("cli", "db migrate", ["--quiet"], async () => 0);
    expect(code).toBe(0);
    const [row] = rows();
    expect(row).toMatchObject({ surface: "cli", command: "db migrate", outcome: "ok" });
    expect(row?.started_at).toBeTruthy();
    expect(row?.ended_at).toBeTruthy();
    expect(JSON.parse(String(row?.args))).toEqual(["--quiet"]);
  });

  it("records error outcome and still returns the exit code when fn throws", async () => {
    const code = await logRequest("cli", "db migrate", [], async () => {
      throw new Error("boom");
    });
    expect(code).toBe(1);
    const [row] = rows();
    expect(String(row?.outcome)).toMatch(/^error:/);
  });

  it("records error:exit-N outcome and returns the exit code when fn returns non-zero without throwing", async () => {
    const code = await logRequest("cli", "x", [], async () => 2);
    expect(code).toBe(2);
    const [row] = rows();
    expect(row?.outcome).toBe("error:exit-2");
  });

  it("sanitizes control and bidi characters embedded in args before persisting", async () => {
    // Same contract as sanitizeValue() (Task 6, hardened via src/sanitize.ts):
    // control characters and bidi overrides must not survive into a value
    // that could later be rendered in a terminal or report. A newline and an
    // RTL override embedded in an arg must come out stripped/replaced.
    const rtlOverride = String.fromCharCode(0x202e);
    const dirty = [`a\nb`, `c${rtlOverride}d`];
    const code = await logRequest("cli", "db migrate", dirty, async () => 0);
    expect(code).toBe(0);
    const [row] = rows();
    const storedArgs = JSON.parse(String(row?.args)) as string[];
    expect(storedArgs).toEqual(["a b", "c d"]);
  });

  it("closes the sqlite handle even when the insert itself throws", async () => {
    // Drop request_log after migration so openDb() still succeeds but the
    // insert fails post-open — mirrors db-client-error-handling.test.ts's
    // seed-a-conflict approach, exercising close-on-error rather than the
    // before-first-migrate swallow path the other tests cover.
    const seed = new Database(fixture.path());
    seed.exec("DROP TABLE request_log");
    seed.close();

    const closeSpy = vi.spyOn(Database.prototype, "close");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await logRequest("cli", "db migrate", [], async () => 0);
      expect(code).toBe(0);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const ctx = closeSpy.mock.contexts[0] as InstanceType<typeof Database>;
      expect(ctx.open).toBe(false);
      // Not breaking the wrapped request is correct and stays (code is still 0 above) — but a
      // telemetry write failure (dropped table, SQLITE_BUSY, a read-only volume, ...) must not
      // vanish with zero signal: it needs to reach stderr so it's discoverable, not silently
      // swallowed forever.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("telemetry: request_log write failed"));
    } finally {
      closeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("sanitizes control and bidi characters in the telemetry failure diagnostic itself (Codex round-1 finding on PR #20)", async () => {
    // The diagnostic added for the dropped-table test above wraps `err.message` — and that
    // message can come from a real fs/SQLite error whose text embeds attacker-controlled
    // TN_DB_PATH content, including newlines or bidi overrides. Same threat model as
    // src/sanitize.ts's own doc comment: an unsanitized value here reintroduces terminal/log
    // injection on the one path meant to make failures DISCOVERABLE.
    const rtlOverride = String.fromCharCode(0x202e);
    const openDbSpy = vi.spyOn(client, "openDb").mockImplementation(() => {
      throw new Error(`bad\npath${rtlOverride}injected`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await logRequest("cli", "db migrate", [], async () => 0);
      expect(code).toBe(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const printed = errorSpy.mock.calls[0]?.[0] as string;
      expect(printed).toBe("telemetry: request_log write failed: bad path injected");
      expect(printed).not.toContain(rtlOverride);
      expect(printed).not.toContain("\n");
    } finally {
      openDbSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("survives a write failure whose Error carries a non-string message (#64, Codex round-2 on PR #20)", async () => {
    // The module's own contract is "telemetry must never break the request/tool call itself", and
    // the guard implementing it read `err instanceof Error ? err.message : String(err)` — which puts
    // the String() coercion on the WRONG branch. TypeScript types `Error.prototype.message` as
    // `string`, but it is an ordinary writable own property, so a subclassed, mutated, or
    // cross-realm error can carry anything. `sanitizeValue()` then called `.replace()` on a
    // non-string and threw a TypeError FROM INSIDE THE CATCH, propagating out of `logRequest` and
    // breaking the very request the catch existed to protect.
    //
    // Asserted on the side effects, not on "it ran": the wrapped fn's exit code must survive
    // untouched, and the diagnostic must still reach stderr exactly once.
    const err = new Error();
    Object.defineProperty(err, "message", { value: { hostile: true }, writable: true, configurable: true });
    const openDbSpy = vi.spyOn(client, "openDb").mockImplementation(() => {
      throw err;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await logRequest("cli", "db migrate", [], async () => 0);
      expect(code).toBe(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("telemetry: request_log write failed: [object Object]");
    } finally {
      openDbSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("classifies a hostile thrown value without throwing — Reviewer finding 3 on PR #84", async () => {
    // The Reviewer's trace, verbatim. `outcome` was built with
    // `err instanceof Error ? err.constructor.name : "unknown"`, and `instanceof` invokes this
    // Proxy's getPrototypeOf trap — so the CLASSIFIER threw, `logRequest` rejected, and the
    // wrapped call's exit code never came back. The first pass of #64 hardened the message read
    // and left the class read standing: a partial class fix, which is the shape this whole PR is
    // about.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error("trap");
        },
      },
    );
    const code = await logRequest("cli", "x", [], async () => {
      throw hostile;
    });
    expect(code).toBe(1);
    expect(rows()[0]?.outcome).toBe("error:unknown");
  });

  it("classifies an Error whose constructor was removed — no Proxy required", async () => {
    // The weaker variant, found while verifying the Reviewer's trace rather than taken from it:
    // `.constructor` is a writable property like `.message`, so `err.constructor.name` throws a
    // plain TypeError with no exotic object involved at all. Worth its own case because it shows
    // the finding is not confined to Proxies, which is how it would otherwise be remembered.
    const err = new Error("boom");
    Object.defineProperty(err, "constructor", { value: undefined, configurable: true });
    const code = await logRequest("cli", "x", [], async () => {
      throw err;
    });
    expect(code).toBe(1);
    expect(rows()[0]?.outcome).toBe("error:unknown");
  });
});
