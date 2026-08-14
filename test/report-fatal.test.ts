import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFatal } from "../src/cli/report-fatal.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Every `src/**\/*.ts` whose text matches `pattern`, as sorted `src`-relative paths. Both callers
 * assert an exact list, so the walk asserts its own non-vacuousness: a broken walk returning
 * nothing would make an "only this file" claim pass for the wrong reason.
 */
function sourceFilesMatching(pattern: RegExp): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(join(entry.parentPath, entry.name));
  }
  expect(files.length).toBeGreaterThan(30);
  return files
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file))
    .sort();
}

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

  // Contractor review of f1242fd, finding 2. `docs/cli/GRAMMAR.md` tells an operator that a
  // `status=error` line carrying `class=` was NOT printed by a command — it is how you tell nadal
  // crashing from nadal refusing. Nothing enforced that: `emitSummary` takes arbitrary field names
  // from ~30 call sites, so the documented invariant was a convention one new command could break
  // silently, and the doc would go on asserting it. This is the check that makes the sentence true.
  it("`class=` is emitted by this module and nothing else — the invariant GRAMMAR.md states", () => {
    const emitters = sourceFilesMatching(/\[\s*"class"\s*,/);
    expect(emitters).toEqual(["cli/report-fatal.ts"]);
  });

  // Contractor review of 2aa63b9, finding 1, second half. GRAMMAR.md now tells a `--json` consumer
  // that stderr is one JSON object per line, and names the only two lines that are not — both from
  // before a command is dispatched. That sentence is an enumeration of source, so it decays the
  // moment someone adds a fifth `console.error`. This is what makes it decay LOUDLY.
  it("every stderr writer in src/ is one GRAMMAR.md accounts for", () => {
    // Direct callers. `src/cli/emit.ts` is deliberately absent and is asserted separately below:
    // it picks the stream with `const write = toStderr ? console.error : console.log`, so it never
    // spells the call — a detail worth having found here rather than in the claim's next reader.
    expect(sourceFilesMatching(/console\.error\(/)).toEqual([
      // `tn mcp serve` rejecting arguments: documented as taking no flags at all.
      "cli/commands/mcp-serve.ts",
      // An unknown noun/verb: nothing was dispatched, so no command's output mode applies.
      "cli/router.ts",
      // Telemetry's own write failure — an object under `--json` as of this issue.
      "telemetry/request-log.ts",
    ]);

    // The fourth writer, and the one every command's output actually travels through.
    expect(sourceFilesMatching(/toStderr \? console\.error : console\.log/)).toEqual(["cli/emit.ts"]);
  });

  // Stated because the guard above reads source text, and a guard's blind spot belongs next to the
  // guard rather than in a reviewer's memory: it catches the literal `["class", …]` tuple, which is
  // how every summary field in this repo is written today, and would NOT catch a field name built
  // from a variable (`[key, value]`). That is a real hole and an acceptable one — the alternative is
  // reserving field names inside `emitSummary` at runtime, which buys a check on a path no command
  // takes for a vocabulary of exactly one word. If a command ever does compute field names, this
  // guard stops being sufficient and GRAMMAR.md's claim has to be re-derived rather than trusted.
  it("the guard above would actually fire — a second literal emitter breaks it", () => {
    const sample = `emitSummary("x", "error", [["message", m], ["class", c]], opts)`;
    expect(/\[\s*"class"\s*,/.test(sample)).toBe(true);
    expect(/\[\s*"class"\s*,/.test(`emitSummary("x", "error", [["message", m]], opts)`)).toBe(false);
  });
});
