import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { pullArchivedUstaProfile } from "../../ingest/archived.js";
import { fetchPage } from "../../ingest/fetch.js";
import { pullPlayer } from "../../ingest/player-pull.js";
import { globalFlags, parseArgs } from "../args.js";
import { ambiguousMessage, emitSummary, type EmitOpts } from "../emit.js";

type ReportableResult =
  | { kind: "ok"; player: { canonicalName: string }; archivedPath: string; courtMatchCount?: number }
  | { kind: "unknown-target"; message: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "error"; message: string };

function report(result: ReportableResult, opts: EmitOpts): number {
  if (result.kind === "ok") {
    emitSummary(
      "player pull",
      "ok",
      [
        ["player", result.player.canonicalName],
        ["matches", result.courtMatchCount ?? 0],
        ["archived", result.archivedPath],
      ],
      opts,
    );
    return 0;
  }
  const message =
    result.kind === "ambiguous" ? ambiguousMessage(result) : result.message;
  emitSummary("player pull", "error", [["message", message]], opts);
  return 1;
}

export const playerPull: Command = {
  noun: "player",
  verb: "pull",
  summary: "Pull a player's ratings and match history from TennisRecord",
  // Declared here rather than only inline in `run` below (#44 Task 4) so `dispatch`'s
  // value-flag-aware `--help` scan (src/cli/router.ts) reads the exact same list `run` parses
  // with — one declaration, not two that a future edit could let drift apart. Self-reference is
  // safe: `run` is a closure that only reads `playerPull` when it is actually invoked, long after
  // this object literal has finished initializing.
  valueFlags: ["from", "source-url"],
  run: async (args) => {
    const parsed = parseArgs(args, playerPull.booleanFlags ?? [], playerPull.valueFlags ?? []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player pull", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player pull", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const from = parsed.flags.from;
    const sourceUrl = parsed.flags["source-url"];
    if ((from !== undefined) !== (sourceUrl !== undefined)) {
      emitSummary("player pull", "error", [["message", "--from requires --source-url and vice versa"]], opts);
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
          emitSummary(
            "player pull",
            "error",
            [["message", `target "${parsed.target}" requires --from and --source-url (login-assisted path)`]],
            opts,
          );
          return 1;
        }
        const result = await pullArchivedUstaProfile({ db, path: from, sourceUrl });
        return report(result, opts);
      }

      const result = await pullPlayer({
        db,
        fetchPage,
        target: parsed.target,
        from: typeof from === "string" && typeof sourceUrl === "string" ? { path: from, sourceUrl } : undefined,
      });
      return report(result, opts);
    } finally {
      sqlite.close();
    }
  },
};
