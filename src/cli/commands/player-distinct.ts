import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { declareDistinctPlayer } from "../../ingest/disambiguate.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitSummary, type SummaryField } from "../emit.js";

/**
 * `tn player distinct <name> [<near-name>]` (#94, #142) — the "these are DIFFERENT people" ruling on
 * an ambiguity the identity ladder reported and refused to guess at.
 *
 * A target positional plus an OPTIONAL counterpart, no flags, matching every command but
 * `team pull`/`player pull`. It is one of only two commands that write `players` / `player_aliases`
 * outside a scrape (`player alias` is the other), and it exists because before it a reported
 * ambiguity had no resolution path at all: the ladder's tier-3 contract is "report the candidates
 * and create nothing", which is the right refusal and was a dead end.
 *
 * The counterpart is for the case the single-name form cannot reach (#142): a pull rolls back on
 * refusal, so when BOTH sides of an ambiguity first appeared in that pull, neither is on disk
 * afterwards and there is no committed neighbour to be near. Naming the counterpart from the
 * warning is what makes such a ruling expressible; `alsoCreated=` says when it minted a second
 * person, because that is a write the caller should not have to infer.
 *
 * The refusals are worth more than the success here, so each gets its own message rather than one
 * generic failure — see `declareDistinctPlayer` for why a name that is near NOTHING is refused
 * rather than created.
 */
export const playerDistinct: Command = {
  noun: "player",
  verb: "distinct",
  summary: "Declare similar names different people, creating any of them not yet on file",
  run: async (args) => {
    const parsed = parsePayloadArgs(args, 1);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player distinct", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player distinct", "error", [["message", "missing target"]], opts);
      return 1;
    }
    // Absent is the single-name form, which is unchanged. A BLANK one is a different thing and is
    // refused downstream rather than quietly read as absent.
    const [nearName] = parsed.payload;

    const { db, sqlite } = openDb();
    try {
      const result = declareDistinctPlayer(db, { name: parsed.target, nearName });

      if (result.kind === "created") {
        const fields: SummaryField[] = [
          ["player", result.player.canonicalName],
          ["created", "true"],
          ["distinctFrom", result.distinctFrom.join(", ")],
        ];
        // Emitted only when it happened: a second person on file is a write the caller did not
        // name as the target, so it is reported rather than left to be discovered later.
        if (result.alsoCreated.length > 0) fields.push(["alsoCreated", result.alsoCreated.join(", ")]);
        emitSummary("player distinct", "ok", fields, opts);
        return 0;
      }
      // Idempotent, not a failure: the state the caller asked for is the state on disk, so
      // re-running a runbook step exits 0. `created=false` is what tells the two apart.
      if (result.kind === "already-on-file") {
        const fields: SummaryField[] = [
          ["player", result.player.canonicalName],
          ["created", "false"],
        ];
        if (result.alsoCreated.length > 0) fields.push(["alsoCreated", result.alsoCreated.join(", ")]);
        emitSummary("player distinct", "ok", fields, opts);
        return 0;
      }

      const message =
        result.kind === "empty-name"
          ? "a player name cannot be blank"
          : result.kind === "not-near"
            ? `"${parsed.target}" and "${nearName}" are further apart than the fuzzy radius, so no pull ever reported them together. Check both spellings against the warning that named them.`
            : result.kind === "same-name"
              ? `"${parsed.target}" and "${nearName}" are the same name to the identity ladder, so they cannot be declared different people — creating both would make that name ambiguous permanently.`
              : result.kind === "not-ambiguous"
                // The one message a #142 ambiguity actually reaches, so it carries the way out:
                // both sides rolled back with the pull, which is why nothing is near it on file.
                ? `"${parsed.target}" is not ambiguous — it matches no player on file and is near none, so nothing refused it. If a pull DID report it, the name it was near rolled back with that pull and is not on file either; re-run naming that counterpart: \`tn player distinct "${parsed.target}" "<the name it was near>"\`. Otherwise check the spelling against the reported name, or run \`tn player pull\` to create it.`
                : `"${result.name}" is already on file more than once (${result.candidates.join(", ")}) — those rows need merging, which this command cannot do`;
      emitSummary("player distinct", "error", [["message", message]], opts);
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
