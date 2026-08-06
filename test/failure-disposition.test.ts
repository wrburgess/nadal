import { describe, expect, it } from "vitest";
import { dispositionOfThrown } from "../src/ingest/failure-disposition.js";
import { FetchError } from "../src/ingest/fetch.js";
import { AmbiguousIdentityError } from "../src/ingest/errors.js";
import { ParseError } from "../src/parsers/types.js";

/** A caught value carrying a libuv/Node `code`, the shape a socket or SQLite failure arrives in. */
function errorWithCode(code: unknown, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

/** An `Error` renamed the way `AbortSignal.timeout` names its rejection. */
function namedError(name: string): Error {
  const err = new Error(`aborted: ${name}`);
  err.name = name;
  return err;
}

describe("dispositionOfThrown — HTTP status", () => {
  // A pull that failed on one of these will typically succeed on an immediate individual retry;
  // #98's evidence is four such failures in one 20-player session, every one clean on retry.
  it.each([408, 425, 429, 500, 502, 503, 504])("classifies HTTP %i as retryable", (status) => {
    expect(dispositionOfThrown(new FetchError(`fetch failed with status ${status}: u`, status, "u"))).toBe("retryable");
  });

  it.each([400, 403, 404, 410, 451])("classifies HTTP %i as permanent", (status) => {
    expect(dispositionOfThrown(new FetchError(`fetch failed with status ${status}: u`, status, "u"))).toBe("permanent");
  });

  /**
   * The edges of the enumeration, both sides of each. A table of "the statuses we thought of" passes
   * whether the predicate is `=== 429` or `>= 429`; only the neighbours distinguish them, and an
   * off-by-one on `500` is what would silently reclassify every server error as permanent.
   */
  it.each([
    [407, "permanent"],
    [408, "retryable"],
    [409, "permanent"],
    [424, "permanent"],
    [425, "retryable"],
    [426, "permanent"],
    [428, "permanent"],
    [429, "retryable"],
    [430, "permanent"],
    [499, "permanent"],
    [500, "retryable"],
    [599, "retryable"],
    [600, "permanent"],
  ])("classifies the boundary status %i as %s", (status, expected) => {
    expect(dispositionOfThrown(new FetchError("boundary", status as number, "u"))).toBe(expected);
  });
});

describe("dispositionOfThrown — transport failures", () => {
  // `fetchPage` passes `AbortSignal.timeout(20_000)`, whose rejection is named `TimeoutError`.
  it.each(["TimeoutError", "AbortError"])("classifies a %s abort as retryable", (name) => {
    expect(dispositionOfThrown(namedError(name))).toBe("retryable");
  });

  it.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"])(
    "classifies the socket code %s as retryable",
    (code) => {
      expect(dispositionOfThrown(errorWithCode(code))).toBe("retryable");
    },
  );

  /**
   * `ENOTFOUND` is NXDOMAIN, which a permanently dead host returns exactly as a flapping resolver
   * does — so it cannot be positively identified as transient, and this module never claims a
   * `retryable` it has not positively identified. An earlier revision had it retryable on the
   * strength of an unmeasured claim about this source. (Codex review of PR #119, rated medium.)
   *
   * `EAI_AGAIN` beside it is the contrast that makes the rule legible rather than arbitrary: the
   * resolver itself says "temporary failure, try again", which IS a positive identification.
   */
  it("does NOT classify ENOTFOUND as retryable — NXDOMAIN is not evidence of a transient fault", () => {
    expect(dispositionOfThrown(errorWithCode("ENOTFOUND"))).toBe("unclassified");
    expect(dispositionOfThrown(errorWithCode("EAI_AGAIN"))).toBe("retryable");
  });

  /**
   * The enumeration's edge, in the direction the docs used to overclaim. These are real libuv codes
   * for a network fault, and they are `unclassified` because this module enumerates rather than
   * pattern-matches `E*` — pinned so the prose in GRAMMAR.md and the runbook cannot drift back into
   * promising "a socket error" as a class.
   */
  it.each(["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "ECONNABORTED"])(
    "leaves the unenumerated network code %s unclassified rather than claiming a wider class",
    (code) => {
      expect(dispositionOfThrown(errorWithCode(code))).toBe("unclassified");
    },
  );

  /**
   * The case a two-level check passes and a walk is required for. undici surfaces every socket
   * failure as a bare `TypeError: fetch failed` and puts the real code on `.cause`; a wrapper one
   * level deeper is not hypothetical either, since drizzle wraps better-sqlite3 the same way
   * (src/db/client.ts). Depth 2 is what separates "walks the chain" from "checks err.cause".
   */
  it("finds a socket code wrapped one level deep", () => {
    const wrapped = new TypeError("fetch failed", { cause: errorWithCode("ECONNRESET") });
    expect(dispositionOfThrown(wrapped)).toBe("retryable");
  });

  it("finds a socket code wrapped two levels deep", () => {
    const inner = errorWithCode("ECONNREFUSED");
    const wrapped = new TypeError("fetch failed", { cause: new Error("layer", { cause: inner }) });
    expect(dispositionOfThrown(wrapped)).toBe("retryable");
  });

  it("finds a FetchError wrapped in a cause chain, not only at the top", () => {
    const wrapped = new Error("outer", { cause: new FetchError("inner", 503, "u") });
    expect(dispositionOfThrown(wrapped)).toBe("retryable");
  });

  /**
   * A walk with no bound is how a hang ships. `Error.cause` is an ordinary writable property, so a
   * cycle is constructible — and this classifier runs inside a `catch`, where a hang is indistinguishable
   * from the pull itself being slow.
   */
  it("terminates on a cyclic cause chain rather than hanging", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b, writable: true, configurable: true });
    expect(dispositionOfThrown(a)).toBe("unclassified");
  });
});

describe("dispositionOfThrown — classes that need a human", () => {
  it("classifies a ParseError as permanent — retrying reproduces it", () => {
    expect(dispositionOfThrown(new ParseError("no match-history table", "table.matches"))).toBe("permanent");
  });

  it("classifies an AmbiguousIdentityError as permanent — it refuses identically until someone rules", () => {
    const err = new AmbiguousIdentityError([
      { incoming: "Austin DuBois", candidates: ["Justin DuBois"], context: "match opponent" },
    ]);
    expect(dispositionOfThrown(err)).toBe("permanent");
  });

  it("finds a ParseError wrapped in a cause chain", () => {
    expect(dispositionOfThrown(new Error("outer", { cause: new ParseError("inner", "div.large") }))).toBe("permanent");
  });
});

describe("dispositionOfThrown — SQLite contention", () => {
  it.each(["SQLITE_BUSY", "SQLITE_LOCKED"])("classifies %s as retryable", (code) => {
    expect(dispositionOfThrown(errorWithCode(code))).toBe("retryable");
  });

  // The extended result codes better-sqlite3 actually registers
  // (`node_modules/better-sqlite3/src/util/constants.cpp`), reached through a drizzle wrapper the way
  // a real migration/query failure arrives.
  it.each(["SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT", "SQLITE_LOCKED_SHAREDCACHE"])(
    "classifies the extended code %s behind a wrapper as retryable",
    (code) => {
      expect(dispositionOfThrown(new Error("Failed to run the query", { cause: errorWithCode(code) }))).toBe(
        "retryable",
      );
    },
  );

  /**
   * `SQLITE_LOCKED_VTAB` shares `SQLITE_LOCKED`'s prefix and is NOT contention — a locked virtual
   * table does not clear on a retry. It is the case that makes `SQLITE_LOCKED` an exact set while
   * `SQLITE_BUSY` stays a prefix, and a prefix match here would hand out the one verdict this module
   * treats as worst to get wrong: a `retryable` an operator acts on twice.
   */
  it("does NOT classify SQLITE_LOCKED_VTAB as retryable — a locked vtab is not contention", () => {
    expect(dispositionOfThrown(errorWithCode("SQLITE_LOCKED_VTAB"))).toBe("unclassified");
  });

  it("does not claim a constraint violation is retryable", () => {
    expect(dispositionOfThrown(errorWithCode("SQLITE_CONSTRAINT_UNIQUE"))).toBe("unclassified");
  });
});

/**
 * The FetchError branch's fallback, which a `typeof status === "number"` test would route to
 * `permanent` instead — asserting "retrying reproduces this" about a status nothing identified.
 * `NaN` and `Infinity` are both numbers and neither compares into the 5xx range, so they reached the
 * `return "permanent"` below the range check. Constructible without a cast, so this is a real input
 * class rather than a defensive branch no fixture can distinguish.
 */
describe("dispositionOfThrown — a FetchError with an unusable status", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a fractional status", 503.5],
    // The four land on DIFFERENT wrong answers under a `typeof` test — NaN and both infinities fall
    // through to `permanent`, while `503.5` compares into the 5xx range and comes back `retryable` —
    // so the title says "rather than guessing" instead of naming one of them.
  ])("classifies a status of %s as unclassified rather than guessing", (_label, status) => {
    expect(dispositionOfThrown(new FetchError("odd", status as number, "u"))).toBe("unclassified");
  });

  it("classifies a FetchError whose status was never set as unclassified", () => {
    expect(dispositionOfThrown(new FetchError("no status", undefined as unknown as number, "u"))).toBe("unclassified");
  });
});

describe("dispositionOfThrown — the honest default", () => {
  it("classifies a bare Error as unclassified rather than guessing", () => {
    expect(dispositionOfThrown(new Error("boom"))).toBe("unclassified");
  });

  // The message says 503 and the object is not a FetchError. Classifying by rendered text is the
  // option this issue's assessment rejected, and this pins that it was not quietly reintroduced:
  // a scraped page whose parse error quotes it could otherwise buy itself a `retryable` label.
  it("does not classify by message text — a lookalike message is still unclassified", () => {
    expect(dispositionOfThrown(new Error("fetch failed with status 503: https://example.test"))).toBe("unclassified");
  });

  it("does not classify a plain object that merely looks like a FetchError", () => {
    expect(dispositionOfThrown({ name: "FetchError", status: 503 })).toBe("unclassified");
  });
});

/**
 * Total and non-throwing, on the precedent of `errorMessage` (src/error-message.ts): this function
 * runs INSIDE a `catch`, so a throw here converts a handled failure into an unhandled one — the exact
 * failure the catch existed to prevent. Every case below is asserted twice, on not-throwing and on
 * the value, because a function that returned the right answer by crashing is not a passing case.
 */
describe("dispositionOfThrown — hostile input never throws", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "ECONNRESET"],
    ["a number", 503],
    ["a symbol", Symbol("x")],
    ["a null-prototype object", Object.create(null)],
  ])("returns unclassified for %s", (_label, value) => {
    expect(() => dispositionOfThrown(value)).not.toThrow();
    expect(dispositionOfThrown(value)).toBe("unclassified");
  });

  it("survives a Proxy whose getPrototypeOf trap throws — the case that breaks `instanceof` itself", () => {
    const hostile = new Proxy(new Error("boom"), {
      getPrototypeOf() {
        throw new Error("trap");
      },
    });
    expect(() => dispositionOfThrown(hostile)).not.toThrow();
    expect(dispositionOfThrown(hostile)).toBe("unclassified");
  });

  it("survives an error whose `code` getter throws", () => {
    const hostile = new Error("boom");
    Object.defineProperty(hostile, "code", {
      get() {
        throw new Error("trap");
      },
    });
    expect(() => dispositionOfThrown(hostile)).not.toThrow();
    expect(dispositionOfThrown(hostile)).toBe("unclassified");
  });

  it("survives an error whose `cause` getter throws", () => {
    const hostile = new Error("boom");
    Object.defineProperty(hostile, "cause", {
      get() {
        throw new Error("trap");
      },
    });
    expect(() => dispositionOfThrown(hostile)).not.toThrow();
    expect(dispositionOfThrown(hostile)).toBe("unclassified");
  });

  it("survives an error whose `name` getter throws", () => {
    const hostile = new Error("boom");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("trap");
      },
    });
    expect(() => dispositionOfThrown(hostile)).not.toThrow();
    expect(dispositionOfThrown(hostile)).toBe("unclassified");
  });

  // A retryable code sitting behind a throwing hop. The walk must not abandon the whole chain on one
  // hostile link when a later one carries a real, classifiable fact.
  it("keeps walking past a hop whose `code` getter throws", () => {
    const hostileHop = new Error("hop");
    Object.defineProperty(hostileHop, "code", {
      get() {
        throw new Error("trap");
      },
    });
    Object.defineProperty(hostileHop, "cause", {
      value: errorWithCode("ECONNRESET"),
      writable: true,
      configurable: true,
    });
    expect(dispositionOfThrown(hostileHop)).toBe("retryable");
  });
});
