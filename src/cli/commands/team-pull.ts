import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { fetchPage } from "../../ingest/fetch.js";
import { pullTeam } from "../../ingest/team-pull.js";
import { parseArgs } from "../args.js";
import { quoteSummaryValue } from "../summary.js";

function summarize(fields: Array<[string, string]>): string {
  return `team pull ${fields.map(([k, v]) => `${k}=${v}`).join(" ")}`;
}

export const teamPull: Command = {
  noun: "team",
  verb: "pull",
  summary: "Pull a team roster and schedule from TennisRecord",
  run: async (args) => {
    const parsed = parseArgs(args, ["players"], ["from", "source-url"]);
    if (parsed.error !== undefined) {
      console.error(summarize([["status", "error"], ["message", `"${quoteSummaryValue(parsed.error)}"`]]));
      return 1;
    }
    if (parsed.target === undefined) {
      console.error(
        summarize([["status", "error"], ["message", `"${quoteSummaryValue("missing target")}"`]]),
      );
      return 1;
    }
    const from = parsed.flags.from;
    const sourceUrl = parsed.flags["source-url"];
    if ((from !== undefined) !== (sourceUrl !== undefined)) {
      console.error(
        summarize([
          ["status", "error"],
          ["message", `"${quoteSummaryValue("--from requires --source-url and vice versa")}"`],
        ]),
      );
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const result = await pullTeam({
        db,
        fetchPage,
        target: parsed.target,
        cascadePlayers: parsed.flags.players === true,
        from: typeof from === "string" && typeof sourceUrl === "string" ? { path: from, sourceUrl } : undefined,
      });

      if (result.kind === "ok") {
        const fields: Array<[string, string]> = [
          ["team", `"${quoteSummaryValue(result.team.name)}"`],
          ["roster", String(result.rosterCount)],
          ["matches", String(result.matchCount)],
          ["archived", `"${quoteSummaryValue(result.archivedPath)}"`],
        ];

        // The team transaction has already committed, so a cascade failure is NOT an error — but it
        // is not `ok` either. Discarding `skippedRosterEntries` and printing `status=ok` meant a
        // command that was explicitly asked to enrich players could report success having enriched
        // ZERO of them, with an irreversible team write already on disk. (Codex adversarial review,
        // PR #31, rated high.) A requested-but-unfulfilled cascade reports `status=partial`, names
        // the entries, and exits non-zero — the outcome is visible to a caller that only reads the
        // exit code.
        if (result.skippedRosterEntries.length > 0) {
          console.error(
            summarize([
              ["status", "partial"],
              ...fields,
              ["skipped", String(result.skippedRosterEntries.length)],
              ["skippedEntries", `"${quoteSummaryValue(result.skippedRosterEntries.join(", "))}"`],
            ]),
          );
          return 1;
        }

        console.log(summarize([["status", "ok"], ...fields]));
        return 0;
      }

      const message =
        result.kind === "ambiguous"
          ? `ambiguous target: ${result.candidates.join(", ")}`
          : result.message;
      console.error(summarize([["status", "error"], ["message", `"${quoteSummaryValue(message)}"`]]));
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
