import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { pullArchivedUstaProfile } from "../../ingest/archived.js";
import { fetchPage } from "../../ingest/fetch.js";
import { pullPlayer } from "../../ingest/player-pull.js";
import { parseArgs } from "../args.js";
import { quoteSummaryValue } from "../summary.js";

function summarize(fields: Array<[string, string]>): string {
  return `player pull ${fields.map(([k, v]) => `${k}=${v}`).join(" ")}`;
}

type ReportableResult =
  | { kind: "ok"; player: { canonicalName: string }; archivedPath: string; courtMatchCount?: number }
  | { kind: "unknown-target"; message: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "error"; message: string };

function report(result: ReportableResult): number {
  if (result.kind === "ok") {
    console.log(
      summarize([
        ["status", "ok"],
        ["player", `"${quoteSummaryValue(result.player.canonicalName)}"`],
        ["matches", String(result.courtMatchCount ?? 0)],
        ["archived", `"${quoteSummaryValue(result.archivedPath)}"`],
      ]),
    );
    return 0;
  }
  const message =
    result.kind === "ambiguous" ? `ambiguous target: ${result.candidates.join(", ")}` : result.message;
  console.error(summarize([["status", "error"], ["message", `"${quoteSummaryValue(message)}"`]]));
  return 1;
}

export const playerPull: Command = {
  noun: "player",
  verb: "pull",
  summary: "Pull a player's ratings and match history from TennisRecord",
  run: async (args) => {
    const parsed = parseArgs(args, [], ["from", "source-url"]);
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
      // `usta:`/`wtn:` name the login-gated source: WTN rides on the same USTA profile page (one
      // fetch, two parsers — see src/ingest/archived.ts), so both route through the archived,
      // login-assisted path rather than a live fetch. That path REQUIRES `--from`/`--source-url`
      // since this tool never automates a login.
      const isLoginGated = parsed.target.startsWith("usta:") || parsed.target.startsWith("wtn:");
      if (isLoginGated) {
        if (typeof from !== "string" || typeof sourceUrl !== "string") {
          console.error(
            summarize([
              ["status", "error"],
              [
                "message",
                `"${quoteSummaryValue(`target "${parsed.target}" requires --from and --source-url (login-assisted path)`)}"`,
              ],
            ]),
          );
          return 1;
        }
        const result = await pullArchivedUstaProfile({ db, path: from, sourceUrl });
        return report(result);
      }

      const result = await pullPlayer({
        db,
        fetchPage,
        target: parsed.target,
        from: typeof from === "string" && typeof sourceUrl === "string" ? { path: from, sourceUrl } : undefined,
      });
      return report(result);
    } finally {
      sqlite.close();
    }
  },
};
