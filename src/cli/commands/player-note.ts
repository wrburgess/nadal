import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { resolvePlayerTarget } from "../../query/player-profile.js";
import {
  EmptyCaptainNoteError,
  NoHomeTeamError,
  PlayerNotOnHomeRosterError,
  SelfPairingCaptainNoteError,
  addCaptainNote,
} from "../../query/captain-notes.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitSummary } from "../emit.js";

function isCaptainNoteRefusal(
  err: unknown,
): err is EmptyCaptainNoteError | SelfPairingCaptainNoteError | PlayerNotOnHomeRosterError | NoHomeTeamError {
  return (
    err instanceof EmptyCaptainNoteError ||
    err instanceof SelfPairingCaptainNoteError ||
    err instanceof PlayerNotOnHomeRosterError ||
    err instanceof NoHomeTeamError
  );
}

/**
 * `tn player note <name|usta:…> "<text>"` (spec § Interfaces). Payload positionals, no new flags —
 * same grammar shape as `player avail` (Task 3). CLI-level notes are always about the player alone;
 * a PAIRING note (`pairPlayerId` set) is reachable only over MCP (Task 7's `player_note` tool),
 * matching spec § Interfaces: captain notes are "captured conversationally" through agent chat, and
 * a pairing needs a second name to disambiguate — awkward as a rigid third CLI positional, natural
 * as a conversational MCP argument.
 */
export const playerNote: Command = {
  noun: "player",
  verb: "note",
  summary: "Append a captain note about a home-team player or pairing",
  run: async (args) => {
    const parsed = parsePayloadArgs(args, 1);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player note", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player note", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [text] = parsed.payload;
    if (text === undefined) {
      emitSummary("player note", "error", [["message", 'usage: tn player note <name> "<text>"']], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const resolution = resolvePlayerTarget(db, parsed.target);
      if (resolution.kind === "not-found") {
        emitSummary("player note", "error", [["message", `unknown target "${parsed.target}"`]], opts);
        return 1;
      }
      if (resolution.kind === "ambiguous") {
        emitSummary(
          "player note",
          "error",
          [["message", `ambiguous target: ${resolution.candidates.join(", ")}`]],
          opts,
        );
        return 1;
      }

      try {
        const note = addCaptainNote(db, { playerId: resolution.playerId, text });
        emitSummary("player note", "ok", [["player", parsed.target], ["note", note.note]], opts);
        return 0;
      } catch (err) {
        if (!isCaptainNoteRefusal(err)) throw err;
        emitSummary("player note", "error", [["message", err.message]], opts);
        return 1;
      }
    } finally {
      sqlite.close();
    }
  },
};
