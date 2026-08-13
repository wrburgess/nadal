import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFatal } from "../src/cli/report-fatal.js";

// #160. `logRequest` caught every error a command threw, labelled a telemetry row with its class,
// and printed NOTHING — `tn` exited 1 with zero bytes on both streams. This module is the missing
// operator-facing half. It lives in its own file rather than inside `src/telemetry/request-log.ts`
// so the decision about what a human sees on a crash is not owned by the telemetry module; only
// the CALL sits at the catch site, which is what keeps PR #84's "logRequest never rejects"
// guarantee untouched.
describe("reportFatal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one status=error line to STDERR carrying both the message and the error class", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportFatal("player show", new TypeError("boom"), { json: false, quiet: false });

    expect(logSpy).not.toHaveBeenCalled();
    // Pinned as the WHOLE string, not a substring match: the defect being fixed is "prints
    // nothing", and a partial assertion cannot tell a complete diagnostic from a truncated one.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('player show status=error message="boom" class="TypeError"');
  });

  it("--quiet does NOT suppress it — an error the operator cannot see is the bug itself", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportFatal("player show", new Error("boom"), { json: false, quiet: true });

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("--json emits a parseable object, so a machine consumer sees the failure too", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportFatal("player show", new RangeError("bad"), { json: true, quiet: false });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload: unknown = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(payload).toEqual({ status: "error", message: "bad", class: "RangeError" });
  });

  it("a hostile thrown value does not make the REPORTER throw — the #64/#84 shape, one door over", () => {
    // The whole point of this function is to run inside a catch. If it can throw there, it
    // replaces the operator's real error with its own — exactly what #64 recorded when a
    // non-string `message` reached `.replace()` and the TypeError became the failure.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = new Error("real failure");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("trap");
      },
    });
    Object.defineProperty(hostile, "constructor", {
      get() {
        throw new Error("trap");
      },
    });

    expect(() => reportFatal("player show", hostile, { json: false, quiet: false })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("a non-Error thrown value is still reported rather than dropped", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportFatal("player show", "a bare string", { json: false, quiet: false });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'player show status=error message="a bare string" class="unknown"',
    );
  });
});
