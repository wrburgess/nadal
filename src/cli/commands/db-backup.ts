import type { Command } from "../router.js";
import { backupDatabase } from "../../db/backup.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary } from "../emit.js";
import { errorMessage } from "../../error-message.js";

// Issue #110. Modelled on `db-migrate.ts` exactly: zero positionals, no flags of its own, both a
// parse error and a stray positional rejected through `emitSummary` so `--quiet`/`--json` are real
// here too. No `--to` flag — the issue does not ask for a destination override, and PROJECT.md ->
// "What a PR is for" is explicit that correctness work not advancing Springfield is triaged, not
// folded in.
export const dbBackup: Command = {
  noun: "db",
  verb: "backup",
  summary: "Take a verified snapshot of the database",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("db backup", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target !== undefined) {
      emitSummary("db backup", "error", [["message", `unexpected argument "${parsed.target}"`]], opts);
      return 1;
    }
    try {
      const result = await backupDatabase();
      emitSummary(
        "db backup",
        "ok",
        [
          ["source", result.source],
          ["destination", result.destination],
          ["tables", result.tables.length],
          ["rows", result.rows],
        ],
        opts,
      );
      return 0;
    } catch (err) {
      // #64: `errorMessage()`, not `err.message` — a hostile non-string `message` would otherwise
      // reach `quoteSummaryValue`'s `.replace()` and throw a TypeError instead of emitting this
      // command's deterministic one-line summary.
      emitSummary("db backup", "error", [["message", errorMessage(err)]], opts);
      return 1;
    }
  },
};
