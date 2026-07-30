import { sanitizeValue } from "../sanitize.js";

/**
 * Make a value safe to embed inside a double-quoted field of a one-line `key=value` CLI summary
 * (e.g. `message="..."`, `path="..."`): strip control characters, then backslash-escape backslashes
 * and double quotes — backslashes FIRST, so an escaped backslash immediately preceding a quote can't
 * be misread by an escape-aware parser as also escaping that quote (an even-length backslash run
 * before a quote is unambiguous only when backslashes are escaped before quotes are).
 *
 * Every summary field is quoted, not just error messages: an UNQUOTED value can contain a space or
 * `=`, letting a whitespace-delimited key/value parser see extra or duplicate fields it shouldn't —
 * including for a perfectly ordinary path once it contains a space (not even an adversarial case,
 * e.g. any home directory whose name has one).
 */
export function quoteSummaryValue(value: string): string {
  return sanitizeValue(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
