import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { declareDistinctPlayer } from "../../ingest/disambiguate.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary, type SummaryField } from "../emit.js";

/**
 * `tn player distinct <name>` (#94) — the "these are DIFFERENT people" ruling on an ambiguity the
 * identity ladder reported and refused to guess at.
 *
 * A target positional, no flags, matching every command but `team pull`/`player pull`. It is one of
 * only two commands that write `players` / `player_aliases` outside a scrape (`player alias` is the
 * other), and it exists because before it a reported ambiguity had no resolution path at all: the
 * ladder's tier-3 contract is "report the candidates and create nothing", which is the right refusal
 * and was a dead end.
 *
 * The refusals are worth more than the success here, so each gets its own message rather than one
 * generic failure — see `declareDistinctPlayer` for why a name that is near NOTHING is refused
 * rather than created.
 */
export const playerDistinct: Command = {
  noun: "player",
  verb: "distinct",
  summary: "Declare a name a different person from its near-matches, creating that player",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player distinct", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player distinct", "error", [["message", "missing target"]], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const result = declareDistinctPlayer(db, { name: parsed.target });

      if (result.kind === "created") {
        const fields: SummaryField[] = [
          ["player", result.player.canonicalName],
          ["created", "true"],
          ["distinctFrom", result.distinctFrom.join(", ")],
        ];
        emitSummary("player distinct", "ok", fields, opts);
        return 0;
      }
      // Idempotent, not a failure: the state the caller asked for is the state on disk, so
      // re-running a runbook step exits 0. `created=false` is what tells the two apart.
      if (result.kind === "already-on-file") {
        emitSummary(
          "player distinct",
          "ok",
          [["player", result.player.canonicalName], ["created", "false"]],
          opts,
        );
        return 0;
      }

      const message =
        result.kind === "empty-name"
          ? "a player name cannot be blank"
          : result.kind === "not-ambiguous"
            ? `"${parsed.target}" is not ambiguous — it matches no player on file and is near none, so nothing refused it. Check the spelling against the reported name, or run \`tn player pull\` to create it.`
            : `"${parsed.target}" is already on file more than once (${result.candidates.join(", ")}) — those rows need merging, which this command cannot do`;
      emitSummary("player distinct", "error", [["message", message]], opts);
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
