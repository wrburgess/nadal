import type { Command } from "../router.js";
import { dbPath, runMigrations } from "../../db/client.js";

const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  "g",
);

/**
 * Make a value safe to embed in a one-line `key=value` CLI summary: strip control characters
 * (including newlines) and escape embedded double quotes, so a value placed inside a quoted
 * field (e.g. `message="..."`) can't be broken out of by its own content.
 */
export function sanitizeSummaryValue(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(/"/g, '\\"').trim();
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
      console.error(`db migrate status=error message="${sanitizeSummaryValue(message)}"`);
      return 1;
    }
    console.log(`db migrate status=ok path=${sanitizeSummaryValue(dbPath())}`);
    return 0;
  },
};
