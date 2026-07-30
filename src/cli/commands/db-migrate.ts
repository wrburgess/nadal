import type { Command } from "../router.js";
import { dbPath, runMigrations } from "../../db/client.js";

// \p{Cc} (Unicode category "Control") covers the full ASCII C0 block, DEL, and the full Latin-1 C1
// block (NEL, CSI, OSC, ST, ...) in one property escape — a terminal or log consumer that
// recognizes any of these could rewrite, hide, or reformat output built from an unsanitized value.
// Line Separator / Paragraph Separator are category Zl/Zp, not Cc, so they're listed explicitly
// (via character code, not a literal escape sequence, to avoid embedding one in the source).
const CC_PROPERTY_ESCAPE = String.fromCharCode(0x5c) + "p{Cc}"; // "\p{Cc}"
const CONTROL_CHARS = new RegExp(
  `[${CC_PROPERTY_ESCAPE}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  "gu",
);

/** Strip control characters (including newlines and Unicode line separators) so a value stays safe inside a one-line summary. */
export function sanitizeSummaryValue(value: string): string {
  return value.replace(CONTROL_CHARS, " ").trim();
}

/**
 * Make a value safe to embed inside a double-quoted field of a one-line `key=value` CLI summary
 * (e.g. `message="..."`): strip control characters, then backslash-escape backslashes and double
 * quotes — backslashes FIRST, so an escaped backslash immediately preceding a quote can't be
 * misread by an escape-aware parser as also escaping that quote (an even-length backslash run
 * before a quote is unambiguous only when backslashes are escaped before quotes are).
 *
 * Not used for the unquoted `path=` field: `TN_DB_PATH` may legally contain `"`, and escaping it
 * there would print a path that no longer matches the file actually migrated.
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
    console.log(`db migrate status=ok path=${sanitizeSummaryValue(dbPath())}`);
    return 0;
  },
};
