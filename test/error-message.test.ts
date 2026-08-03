import { describe, expect, it } from "vitest";
import { errorClass, errorMessage } from "../src/error-message.js";

/**
 * An `Error` whose `message` is not a string. TypeScript types `Error.prototype.message` as
 * `string`, so this shape cannot be written directly — which is precisely why the defect survived
 * review: the type system asserts it is impossible and the runtime does not enforce that at all.
 * `message` is an ordinary writable own property, so a subclass, a mutation, or a cross-realm error
 * can carry any value.
 */
function errorWithMessage(message: unknown): Error {
  const err = new Error();
  Object.defineProperty(err, "message", { value: message, writable: true, configurable: true });
  return err;
}

describe("errorMessage", () => {
  it("returns an ordinary Error's message unchanged", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a thrown string unchanged", () => {
    expect(errorMessage("raw string")).toBe("raw string");
  });

  it("coerces a thrown non-Error, non-string value (the branch that was already correct)", () => {
    expect(errorMessage({ a: 1 })).toBe("[object Object]");
  });

  it("coerces an Error whose message is an object instead of throwing (#64, docs/findings.md)", () => {
    // The reported defect. Before the fix, `err instanceof Error ? err.message : String(err)` put
    // the coercion on the wrong branch, so this object reached `sanitizeValue`'s `.replace()` and
    // threw a TypeError from inside the catch that was supposed to be handling the error.
    const err = errorWithMessage({ a: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(() => errorMessage(err)).not.toThrow();
    expect(errorMessage(err)).toBe("[object Object]");
  });

  it("coerces an Error whose message is undefined rather than returning undefined", () => {
    expect(errorMessage(errorWithMessage(undefined))).toBe("undefined");
  });

  it("coerces a Symbol message, which String() handles but template interpolation does not", () => {
    // This case is why the two INTERPOLATING call sites use this function too rather than relying
    // on the template literal's own coercion: `String(sym)` returns "Symbol(x)", but `${sym}`
    // throws "Cannot convert a Symbol value to a string". The second assertion pins that
    // asymmetry, so a later reader cannot conclude the interpolating sites were safe all along.
    const sym = Symbol("x");
    expect(errorMessage(errorWithMessage(sym))).toBe("Symbol(x)");
    expect(() => `${sym as unknown as string}`).toThrow(TypeError);
  });

  it("falls back for a message whose own toString throws, instead of rethrowing from the catch", () => {
    // String() is not total either: it invokes the value's toString/Symbol.toPrimitive. Coercing
    // without guarding this would move the same defect one step down rather than closing it.
    const hostile = {
      toString(): string {
        throw new Error("nope");
      },
    };
    expect(() => errorMessage(errorWithMessage(hostile))).not.toThrow();
    // Pinned as a literal, not imported from the module: importing the constant would make this
    // assertion tautological — it would pass for any value the module happened to return.
    expect(errorMessage(errorWithMessage(hostile))).toBe("[unprintable error message]");
  });

  it("falls back for a null-prototype object, which has no toString at all", () => {
    const noProto = Object.create(null) as object;
    expect(() => errorMessage(noProto)).not.toThrow();
    expect(errorMessage(noProto)).toBe("[unprintable error message]");
  });

  it("falls back when the message GETTER throws — the read itself, not just the coercion", () => {
    // Found by this PR's own adversarial pass, and the sharpest case here: the first draft guarded
    // only the `String()` call, so `err.message` was read OUTSIDE the try. An Error carrying a
    // throwing getter then threw straight out of the function whose whole contract is that it does
    // not — the remedy had inherited the shape of the bug it was written to fix. Reading a property
    // off an attacker-shaped object is an operation that can throw, exactly like coercing one.
    const err = new Error();
    Object.defineProperty(err, "message", {
      get(): string {
        throw new Error("getter blew up");
      },
      configurable: true,
    });
    expect(err).toBeInstanceOf(Error);
    expect(() => errorMessage(err)).not.toThrow();
    expect(errorMessage(err)).toBe("[unprintable error message]");
  });

  it("falls back when `instanceof` itself throws — a Proxy trapping getPrototypeOf", () => {
    // The same argument one step earlier in the expression: `err instanceof Error` is not a free
    // operation either. It is inside the try for the same reason the property read is, and this
    // pins that rather than leaving it to the reader to notice from the brace placement.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error("prototype trap blew up");
        },
      },
    );
    expect(() => errorMessage(hostile)).not.toThrow();
    expect(errorMessage(hostile)).toBe("[unprintable error message]");
  });
});

describe("errorClass", () => {
  it("returns an ordinary Error's constructor name", () => {
    expect(errorClass(new Error("boom"))).toBe("Error");
  });

  it("returns a subclass's own name", () => {
    class BoomError extends Error {}
    expect(errorClass(new BoomError("boom"))).toBe("BoomError");
  });

  it("returns 'unknown' for a non-Error throw — the branch the original expression already had", () => {
    expect(errorClass("a thrown string")).toBe("unknown");
    expect(errorClass(undefined)).toBe("unknown");
  });

  it("returns 'unknown' when `instanceof` itself throws — Reviewer finding 3 on PR #84", () => {
    // The Reviewer's trace. `err instanceof Error` invokes this Proxy's getPrototypeOf trap, so
    // building `error:<ClassName>` threw from inside `logRequest`'s catch and the wrapped call's
    // exit code never came back.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error("trap");
        },
      },
    );
    expect(() => errorClass(hostile)).not.toThrow();
    expect(errorClass(hostile)).toBe("unknown");
  });

  it("returns 'unknown' when the constructor was removed — no Proxy required", () => {
    const err = new Error("boom");
    Object.defineProperty(err, "constructor", { value: undefined, configurable: true });
    expect(errorClass(err)).toBe("unknown");
  });

  it("returns 'unknown' for an ANONYMOUS class rather than the empty string", () => {
    // Kills the `name.length > 0` half of the guard, which nothing else reaches. Without it an
    // anonymous Error subclass writes the outcome `"error:"` — a telemetry value that names no
    // class and is indistinguishable from a truncation.
    //
    // Destructured out of an array because a plain `const X = class extends Error {}` would get the
    // name "X" from JS's NamedEvaluation and so would NOT be anonymous; array destructuring is not
    // a NamedEvaluation position, so the class keeps its empty name. (The comma-operator form does
    // the same thing at runtime but is a `tsc` error — TS2695.) The first assertion pins that the
    // fixture really is anonymous, since the whole test is vacuous if it is not.
    const [AnonError] = [class extends Error {}];
    expect(AnonError.name).toBe("");
    expect(errorClass(new AnonError("boom"))).toBe("unknown");
  });

  it("returns 'unknown' when the constructor's name is a Symbol", () => {
    // A Symbol here would otherwise be interpolated into `error:${...}`, and template interpolation
    // THROWS on a Symbol — the same asymmetry errorMessage exists for, arriving by another route.
    //
    // This case does NOT on its own prove the `typeof name === "string"` half is mutation-killed —
    // see the next test, which is the one that does.
    const err = new Error("boom");
    const ctor = function (): void {};
    Object.defineProperty(ctor, "name", { value: Symbol("weird") });
    Object.defineProperty(err, "constructor", { value: ctor, configurable: true });
    expect(() => errorClass(err)).not.toThrow();
    expect(errorClass(err)).toBe("unknown");
  });

  it("returns 'unknown' for a non-string name that HAS a length — the case that kills the typeof guard", () => {
    // Reviewer finding on PR #84 @ 5e6dad8, and it was a correction to a claim I had made rather
    // than to the code: the commit asserted that BOTH halves of `errorClass`'s guard were
    // mutation-killed, and that was false.
    //
    // The mutant is `name.length > 0` alone, keeping a type assertion so `tsc` stays happy. Every
    // fixture above survives it, including the Symbol one — `Symbol("weird").length` is `undefined`
    // and `undefined > 0` is false, so that mutant still answers "unknown". The `typeof` half was
    // therefore load-bearing and untested at the same time.
    //
    // A name that is not a string but DOES report `length: 1` separates them. Verified against the
    // mutant before writing this: it returns the OBJECT, and `` `error:${obj}` `` then invokes
    // `toString` and throws inside `logRequest`'s catch — the exact totality regression this guard
    // exists to prevent.
    const err = new Error("boom");
    Object.defineProperty(err, "constructor", {
      value: {
        name: {
          length: 1,
          toString(): string {
            throw new Error("boom");
          },
        },
      },
      configurable: true,
    });
    expect(() => errorClass(err)).not.toThrow();
    expect(errorClass(err)).toBe("unknown");
  });
});
