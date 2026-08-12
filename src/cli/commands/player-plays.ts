import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import {
  AmbiguousPlayerTargetError,
  InvalidPlaysError,
  NoHomeTeamError,
  PlayerNotOnHomeRosterError,
  UnknownPlayerTargetError,
  setPlays,
} from "../../query/player-plays.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitSummary } from "../emit.js";

/** Every error `setPlays` can throw for a caller-fixable reason — as opposed to a genuine bug, which
 * should still surface as an uncaught throw rather than a tidy `status=error` line. */
function isPlaysRefusal(
  err: unknown,
): err is
  | InvalidPlaysError
  | NoHomeTeamError
  | PlayerNotOnHomeRosterError
  | UnknownPlayerTargetError
  | AmbiguousPlayerTargetError {
  return (
    err instanceof InvalidPlaysError ||
    err instanceof NoHomeTeamError ||
    err instanceof PlayerNotOnHomeRosterError ||
    err instanceof UnknownPlayerTargetError ||
    err instanceof AmbiguousPlayerTargetError
  );
}

/**
 * `tn player plays <name|usta:…> <both|doubles-only>` (#149) — payload positional, no new flags,
 * matching GRAMMAR.md's stated exception list (`team pull`/`player pull` are the ONLY commands with
 * flags beyond the global three). Models `src/cli/commands/player-avail.ts`'s shape.
 *
 * **Target resolution lives INSIDE `setPlays`** (`src/query/player-plays.ts`), unlike `player avail`
 * / `player note`, whose services take an already-resolved `playerId` and so resolve the target in
 * this layer first. `setPlays` resolves its own target and throws the identical
 * `UnknownPlayerTargetError` / `AmbiguousPlayerTargetError` taxonomy every other command's own
 * resolution step throws — fully formatted (`ambiguousMessage`) already applied inside the service —
 * so this command has nothing to resolve or reformat before calling it.
 */
export const playerPlays: Command = {
  noun: "player",
  verb: "plays",
  summary: "Record a home-team player's play-style constraint (both or doubles-only)",
  run: async (args) => {
    // One payload positional: `<both|doubles-only>`. Same parser, same global flags, no flags of its
    // own — GRAMMAR.md's "payload positionals, no new flags" shape.
    const parsed = parsePayloadArgs(args, 1);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player plays", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player plays", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [plays] = parsed.payload;
    if (plays === undefined) {
      emitSummary(
        "player plays",
        "error",
        [["message", "usage: tn player plays <name> <both|doubles-only>"]],
        opts,
      );
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const result = setPlays(db, { player: parsed.target, plays });
      emitSummary(
        "player plays",
        "ok",
        [
          ["player", parsed.target],
          ["plays", result.plays],
        ],
        opts,
      );
      return 0;
    } catch (err) {
      if (!isPlaysRefusal(err)) throw err;
      emitSummary("player plays", "error", [["message", err.message]], opts);
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
