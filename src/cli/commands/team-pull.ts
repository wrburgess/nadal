import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { fetchPage } from "../../ingest/fetch.js";
import { pullTeam } from "../../ingest/team-pull.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary, type SummaryField } from "../emit.js";

export const teamPull: Command = {
  noun: "team",
  verb: "pull",
  summary: "Pull a team roster and schedule from TennisRecord",
  run: async (args) => {
    const parsed = parseArgs(args, ["players"], ["from", "source-url"]);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("team pull", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("team pull", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const from = parsed.flags.from;
    const sourceUrl = parsed.flags["source-url"];
    if ((from !== undefined) !== (sourceUrl !== undefined)) {
      emitSummary("team pull", "error", [["message", "--from requires --source-url and vice versa"]], opts);
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
        const fields: SummaryField[] = [
          ["team", result.team.name],
          ["roster", result.rosterCount],
          ["matches", result.matchCount],
          ["archived", result.archivedPath],
          // Issue #49: retirement REMOVES a player from every current-roster read/write, so it has
          // to be visible in the command's own output, not only in the database — included in
          // `fields` (rather than only the `ok` branch below) so the `partial` branch, which
          // spreads `fields` too, reports it just as honestly.
          ["retired", result.retiredCount],
        ];

        // The team transaction has already committed, so a cascade failure is NOT an error — but it
        // is not `ok` either. Discarding `skippedRosterEntries` and printing `status=ok` meant a
        // command that was explicitly asked to enrich players could report success having enriched
        // ZERO of them, with an irreversible team write already on disk. (Codex adversarial review,
        // PR #31, rated high.) A requested-but-unfulfilled cascade reports `status=partial`, names
        // the entries, and exits non-zero — the outcome is visible to a caller that only reads the
        // exit code.
        if (result.skippedRosterEntries.length > 0) {
          emitSummary(
            "team pull",
            "partial",
            [
              ...fields,
              ["skipped", result.skippedRosterEntries.length],
              ["skippedEntries", result.skippedRosterEntries.join(", ")],
            ],
            opts,
          );
          return 1;
        }

        emitSummary("team pull", "ok", fields, opts);
        return 0;
      }

      const message =
        result.kind === "ambiguous"
          ? `ambiguous target: ${result.candidates.join(", ")}`
          : result.message;
      emitSummary("team pull", "error", [["message", message]], opts);
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
