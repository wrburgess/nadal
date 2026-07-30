import type { Command } from "../router.js";
import { dbPath, runMigrations } from "../../db/client.js";
import { quoteSummaryValue } from "../summary.js";

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
