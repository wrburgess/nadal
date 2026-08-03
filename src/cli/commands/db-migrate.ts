import type { Command } from "../router.js";
import { dbPath, runMigrations } from "../../db/client.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary } from "../emit.js";
import { errorMessage } from "../../error-message.js";

// #44 Task 5: folded-in adjacent defect. `run` used to take no `args` at all, so `tn db migrate
// --jsno bogus-extra-arg` was silently accepted — every token was discarded before `runMigrations`
// ran unconditionally, reporting `status=ok` on exit 0. `db migrate` takes ZERO positionals and NO
// flags of its own (`dbMigrate` declares no `booleanFlags`/`valueFlags` on the Command object,
// matching what `parseArgs(args, [], [])` below accepts), so both a parse error AND a positional
// (which `parseArgs` would otherwise treat as this command's "target") are rejected here — routed
// through the same `emitSummary` every other command uses, which is what makes `--quiet`/`--json`
// real for this command too, as GRAMMAR.md already promised for every command. The rendered
// strings are unchanged from before this fix (`db migrate status=ok path="…"` /
// `db migrate status=error message="…"`), so the pre-existing cwd/exit-code tests stay green.
export const dbMigrate: Command = {
  noun: "db",
  verb: "migrate",
  summary: "Apply pending schema migrations",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("db migrate", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target !== undefined) {
      emitSummary("db migrate", "error", [["message", `unexpected argument "${parsed.target}"`]], opts);
      return 1;
    }
    try {
      runMigrations();
    } catch (err) {
      // #64: `err instanceof Error ? err.message : String(err)` let a non-string `message` reach
      // `quoteSummaryValue`'s `.replace()`, so this command threw a TypeError INSTEAD of emitting
      // its deterministic one-line summary — and `logRequest`'s own catch absorbed the TypeError,
      // leaving exit 1 with no summary line at all.
      emitSummary("db migrate", "error", [["message", errorMessage(err)]], opts);
      return 1;
    }
    emitSummary("db migrate", "ok", [["path", dbPath()]], opts);
    return 0;
  },
};
