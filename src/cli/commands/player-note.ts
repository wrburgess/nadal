import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { ambiguousMessage } from "../../ingest/errors.js";
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
import type { SummaryField } from "../emit.js";

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
 * `tn player note <name|usta:…> "<text>" [<pair-name>]` (spec § Interfaces). Payload positionals, no
 * new flags — same grammar shape as `player avail` (Task 3).
 *
 * The trailing `[<pair-name>]` records a PAIRING note (#150), and it is deliberately the LAST
 * positional rather than the second: the note text keeps a fixed position, so arity never decides
 * what a positional MEANS. `tn player note Randy Mark` records a note reading "Mark" about Randy and
 * cannot be silently misread as a pairing by a captain who omitted the quotes — the failure a
 * `<name> <pair> <text>` ordering would have made plausible and invisible. It is the same optional
 * trailing positional `player avail`, `lineup plan` and `report build` use for `[event]`, and
 * `player distinct` for `[<near-name>]` (#142).
 *
 * This replaced a deliberate #17 PR A decision that pairing notes were MCP-only, on the HC's
 * direction of 2026-08-11. What changed is evidence rather than taste: `pair_player_id` had two
 * renderers and zero rows, `request_log` recorded 407 invocations of which none were MCP, and the
 * stated reason ("awkward as a rigid third CLI positional") had been overtaken by this CLI's own
 * grammar — `player avail` already carried three payload positionals.
 */
export const playerNote: Command = {
  noun: "player",
  verb: "note",
  summary: "Append a captain note about a home-team player or pairing",
  run: async (args) => {
    const parsed = parsePayloadArgs(args, 2);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player note", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player note", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [text, pairTarget] = parsed.payload;
    if (text === undefined) {
      emitSummary("player note", "error", [["message", 'usage: tn player note <name> "<text>" [<pair-name>]']], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      // ONE resolution path for both names, differing only in the two labels it is handed. Written
      // as a parameter rather than a second copied block because the partner's diagnostics must not
      // drift from the target's: a copied block whose `context:` string was left unchanged would
      // report a PARTNER collision as a target collision, sending the reader to re-check a name that
      // was never in question.
      const resolveName = (
        name: string,
        labels: { notFound: string; ambiguous: string },
      ): { playerId: number } | { message: string } => {
        const resolution = resolvePlayerTarget(db, name);
        if (resolution.kind === "not-found") return { message: `unknown ${labels.notFound} "${name}"` };
        if (resolution.kind === "ambiguous") {
          return {
            message: ambiguousMessage({ incoming: name, candidates: resolution.candidates, context: labels.ambiguous }),
          };
        }
        return { playerId: resolution.playerId };
      };

      // `target`/`player name target` are the pre-#150 spellings, kept verbatim — this change adds a
      // positional, and a caller parsing the existing refusal should not have to care that it did.
      const subject = resolveName(parsed.target, { notFound: "target", ambiguous: "player name target" });
      if ("message" in subject) {
        emitSummary("player note", "error", [["message", subject.message]], opts);
        return 1;
      }

      let pairPlayerId: number | undefined;
      if (pairTarget !== undefined) {
        const partner = resolveName(pairTarget, { notFound: "pairing partner", ambiguous: "pairing partner name" });
        if ("message" in partner) {
          emitSummary("player note", "error", [["message", partner.message]], opts);
          return 1;
        }
        pairPlayerId = partner.playerId;
      }

      try {
        const note = addCaptainNote(db, { playerId: subject.playerId, pairPlayerId, text });
        emitSummary(
          "player note",
          "ok",
          [
            ["player", parsed.target],
            // Omitted entirely rather than printed empty on a solo note: `pair=""` reads as "a
            // pairing note whose partner has no name" rather than "not a pairing note" — the same
            // distinction the dossier draws between `—` and `unavailable`, and the shape
            // `alsoCreated=`/`field=`/`roster=` already use.
            ...(pairTarget === undefined ? [] : [["pair", pairTarget] as SummaryField]),
            ["note", note.note],
          ],
          opts,
        );
        return 0;
      } catch (err) {
        if (!isCaptainNoteRefusal(err)) throw err;
        // The service can only spell an id (it is handed ids, not names). With a pairing note two
        // players are in play, so a bare `player 47 …` cannot say which one failed — substitute the
        // name this command already resolved for that exact id.
        const message =
          err instanceof PlayerNotOnHomeRosterError
            ? `${err.playerId === pairPlayerId ? `pairing partner "${pairTarget}"` : `player "${parsed.target}"`} is not on the home team's roster`
            : err.message;
        emitSummary("player note", "error", [["message", message]], opts);
        return 1;
      }
    } finally {
      sqlite.close();
    }
  },
};
