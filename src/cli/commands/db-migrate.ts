import type { Command } from "../router.js";
import { dbPath, runMigrations } from "../../db/client.js";

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

/** Strip control characters (including newlines and Unicode line separators) so a value stays safe inside a one-line summary. */
export function sanitizeSummaryValue(value: string): string {
  return value.replace(CONTROL_CHARS, " ").trim();
}

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
  return sanitizeSummaryValue(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export const dbMigrate: Command = {
  noun: "db",
  verb: "migrate",
  summary: "Apply pending schema migrations",
  run: async () => {
    try {
      runMigrations();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`db migrate status=error message="${quoteSummaryValue(message)}"`);
      return 1;
    }
    console.log(`db migrate status=ok path="${quoteSummaryValue(dbPath())}"`);
    return 0;
  },
};
