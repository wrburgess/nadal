// \p{Cc} (Unicode category "Control") covers the full ASCII C0 block, DEL, and the full Latin-1 C1
// block (NEL, CSI, OSC, ST, ...) in one property escape — a terminal or log consumer that
// recognizes any of these could rewrite, hide, or reformat output built from an unsanitized value.
// \p{Cf} (category "Format") covers invisible formatting characters, including the bidirectional
// override/isolate controls (e.g. RIGHT-TO-LEFT OVERRIDE) that can make a terminal/log viewer render
// a one-line summary with its fields visually reordered — the same "Trojan Source" class of spoofing
// applied to CLI/log output instead of source code.
// Line Separator / Paragraph Separator are category Zl/Zp (neither Cc nor Cf), so they're listed
// explicitly (via character code, not a literal escape sequence, to avoid embedding one in the
// source — see the two property-escape strings below, built the same way for the same reason).
//
// Together, Cc + Cf + Zl/Zp cover every Unicode general category plausibly relevant to "can this
// character corrupt or visually spoof a single-line CLI summary" — this is the deliberate stopping
// point for this sanitizer, not an arbitrary partial list.
const CC_PROPERTY_ESCAPE = String.fromCharCode(0x5c) + "p{Cc}"; // "\p{Cc}"
const CF_PROPERTY_ESCAPE = String.fromCharCode(0x5c) + "p{Cf}"; // "\p{Cf}"
const CONTROL_CHARS = new RegExp(
  `[${CC_PROPERTY_ESCAPE}${CF_PROPERTY_ESCAPE}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  "gu",
);

/**
 * Strip control characters (including newlines and Unicode line separators) so a value stays safe
 * inside a one-line summary. Deliberately does NOT trim leading/trailing whitespace: every summary
 * field this feeds is quoted (quoteSummaryValue()), so edge spaces are unambiguous once inside the
 * quotes — trimming them would silently misname a real path (e.g. TN_DB_PATH="/tmp/x.db ", legal
 * POSIX) and would make request_log.args lossy for edge whitespace.
 */
export function sanitizeValue(value: string): string {
  return value.replace(CONTROL_CHARS, " ");
}

/**
 * `sanitizeValue` applied to every string leaf of an arbitrary JSON-shaped value — objects, arrays,
 * and the strings inside them, at any depth. Keys are sanitized too: every key in this codebase is
 * code-authored, so it cannot currently matter, but a hostile key would spoof exactly as well as a
 * hostile value and the guard costs nothing.
 *
 * It lives here rather than in a CLI module because THREE different output boundaries need it and
 * only one of them is the CLI: `tn <cmd> --json` (src/cli/emit.ts), the MCP server's tool results
 * (src/mcp/server.ts), and — via `sanitizeValue` directly — the dossier renderers. Each serializer
 * escapes for its own medium and none of them escape this class: `JSON.stringify` handles the C0
 * controls but passes category-Cf characters (RIGHT-TO-LEFT OVERRIDE) and U+2028/U+2029 straight
 * through, which is precisely why the gap was invisible — partial escaping reads as escaping.
 * (Found across rounds 3 and 4 of the independent Codex review of PR #47.)
 *
 * Non-JSON types (`Date`, `Map`, `Set`, functions) are returned unchanged: nothing in this codebase
 * puts one in a serialized payload, and JSON.stringify would flatten or drop them anyway, so
 * "handling" them here would be inventing a contract no caller has. A cyclic structure is likewise
 * not guarded — `JSON.stringify` already throws on one, so this function cannot make that outcome
 * worse, and a silent recursion guard would hide a bug rather than surface it.
 */
export function sanitizeJson(value: unknown): unknown {
  if (typeof value === "string") return sanitizeValue(value);
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitizeValue(k), sanitizeJson(v)]));
  }
  return value;
}
