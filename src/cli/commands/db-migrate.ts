import type { Command } from "../router.js";
import { dbPath, runMigrations } from "../../db/client.js";

export const dbMigrate: Command = {
  noun: "db",
  verb: "migrate",
  summary: "Apply pending schema migrations",
  run: async () => {
    runMigrations();
    console.log(`db migrate status=ok path=${dbPath()}`);
    return 0;
  },
};
