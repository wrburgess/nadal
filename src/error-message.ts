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
 * **The whole body is inside the `try`, including the `err.message` READ** — the first draft of this
 * function guarded only the `String()` call, and an `Error` carrying a throwing `message` GETTER
 * (or a Proxy trapping `getPrototypeOf`) therefore threw straight out of the function whose entire
 * contract is that it does not. Caught by this PR's own adversarial pass, and it is the same defect
 * class one level further in: the remedy inherited the shape of the bug. Reading a property off an
 * attacker-shaped object IS an operation that can throw, exactly like coercing one.
 *
 * `String()` and template interpolation do NOT agree, which is why the two interpolating call
 * sites use this function too rather than relying on the template literal's own coercion:
 * `String(Symbol("x"))` returns `"Symbol(x)"`, while `` `${Symbol("x")}` `` throws.
 */
export function errorMessage(err: unknown): string {
  try {
    const raw: unknown = err instanceof Error ? err.message : err;
    if (typeof raw === "string") return raw;
    return String(raw);
  } catch {
    return UNPRINTABLE;
  }
}

/**
 * The sibling of `errorMessage` for the OTHER thing this codebase reads off a caught value: its
 * class name, used to build a telemetry `outcome` of the form `error:<ClassName>`.
 *
 * It exists because the first pass of #64 swept `err.message` and left
 * `err instanceof Error ? err.constructor.name : "unknown"` standing — the identical hazard on a
 * different property, in the two functions (`logRequest`, `logMcpTool`) whose stated contract is
 * that telemetry never breaks the request. The independent Reviewer found it on PR #84 with a
 * concrete trace: a thrown `Proxy` whose `getPrototypeOf` trap throws makes the `instanceof` itself
 * throw, so `logRequest` REJECTS instead of returning the wrapped call's exit code. It does not even
 * need a Proxy — an `Error` with `constructor` redefined to `undefined` throws on `.name`.
 *
 * Fixing the message read and not the class read was a partial class fix, which is the exact shape
 * (`docs/findings.md` class C1) the rest of this PR is about. Kept beside `errorMessage` so the two
 * unconstrained reads have one home and neither can be hardened without the other being noticed.
 *
 * `"unknown"` is the fallback because it is the value the original expression already used for a
 * non-`Error` throw — this widens *when* that branch is taken, and invents no new outcome vocabulary
 * for `request_log.outcome` to grow.
 */
export function errorClass(err: unknown): string {
  try {
    if (!(err instanceof Error)) return "unknown";
    const name: unknown = (err.constructor as { name?: unknown } | undefined)?.name;
    return typeof name === "string" && name.length > 0 ? name : "unknown";
  } catch {
    return "unknown";
  }
}
