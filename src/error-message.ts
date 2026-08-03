// Deliberately NOT exported: `test/error-message.test.ts` pins this literal by hand, because a test
// that imported the constant would assert only that the function returns whatever the module says
// it returns — true for any value, and therefore evidence of nothing.
const UNPRINTABLE = "[unprintable error message]";

/**
 * Turn any caught value into a printable string. Every `catch (err: unknown)` that reads a message
 * off an unconstrained thrown value goes through here; the sites that narrow to a project-defined
 * error class first (`ParseError`, `OutputPathError`, the refusal predicates, …) do not need it,
 * because those constructors are in this repo and take a `string`.
 *
 * It replaces the shape `err instanceof Error ? err.message : String(err)`, which puts the
 * coercion on the WRONG branch. TypeScript types `Error.prototype.message` as `string`, so the
 * `instanceof` branch looks safe and is not: `message` is an ordinary writable own property, so a
 * subclassed, mutated, or cross-realm error can carry any value. That value then reaches a string
 * API — `sanitizeValue`'s `.replace()`, `quoteSummaryValue`'s, or a template literal — and throws a
 * TypeError from inside the catch, converting a handled error into an unhandled one. That is
 * exactly the failure the catch existed to prevent, and on the telemetry path it violates a stated
 * invariant ("telemetry must never break the request itself"). Reported as a deferred Codex
 * round-2 finding on PR #20; fixed under issue #64.
 *
 * `String(...)` is wrapped rather than called bare because `String()` is not total either: it
 * invokes the value's `Symbol.toPrimitive`/`toString`, so it throws on an object whose `toString`
 * throws and on a null-prototype object (`Object.create(null)` has no `toString` at all). Coercing
 * without that guard would move the same defect one step down instead of closing it.
 *
 * `String()` and template interpolation do NOT agree, which is why the two interpolating call
 * sites use this function too rather than relying on the template literal's own coercion:
 * `String(Symbol("x"))` returns `"Symbol(x)"`, while `` `${Symbol("x")}` `` throws.
 */
export function errorMessage(err: unknown): string {
  const raw: unknown = err instanceof Error ? err.message : err;
  if (typeof raw === "string") return raw;
  try {
    return String(raw);
  } catch {
    return UNPRINTABLE;
  }
}
