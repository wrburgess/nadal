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
