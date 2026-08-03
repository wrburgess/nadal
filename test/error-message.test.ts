import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/error-message.js";

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
});
