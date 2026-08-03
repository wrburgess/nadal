import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { recordPlayerAlias } from "../../ingest/disambiguate.js";
import { ambiguousMessage } from "../../ingest/errors.js";
import { globalFlags, parsePayloadArgs } from "../args.js";
import { emitSummary } from "../emit.js";

/**
 * `tn player alias <known> <other>` (#94) — the "these are the SAME person, spelled two ways"
 * ruling, the counterpart to `tn player distinct`.
 *
 * Payload positionals, no new flags — the same grammar shape `player avail` and `player note` use,
 * which is what lets a second name be required without inventing a flag for it. `<known>` accepts
 * the usual `usta:`/`wtn:`/`tr:` prefix-IDs as well as a bare name, since the whole point of a
 * prefix-ID is naming an exact identity when the spelling is what is in question.
 *
 * Argument ORDER is load-bearing and asymmetric: `<other>` is recorded against `<known>`, and only
 * `<known>` has to already exist. Getting them backwards refuses (`unknown target`) rather than
 * doing the opposite thing, because a spelling that is not on file cannot resolve as a target.
 */
export const playerAlias: Command = {
  noun: "player",
  verb: "alias",
  summary: "Record a second spelling as the same person as a known player",
  run: async (args) => {
    const parsed = parsePayloadArgs(args, 1);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("player alias", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("player alias", "error", [["message", "missing target"]], opts);
      return 1;
    }
    const [other] = parsed.payload;
    if (other === undefined) {
      emitSummary("player alias", "error", [["message", "usage: tn player alias <known> <other>"]], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const result = recordPlayerAlias(db, { knownTarget: parsed.target, alias: other });

      // Idempotent: `recorded=false` says the spelling already pointed here, which is the state the
      // caller asked for — so a re-run exits 0 rather than reporting a failure that isn't one.
      if (result.kind === "recorded" || result.kind === "already-recorded") {
        emitSummary(
          "player alias",
          "ok",
          [
            ["player", result.player.canonicalName],
            ["alias", result.alias],
            ["recorded", String(result.kind === "recorded")],
          ],
          opts,
        );
        return 0;
      }

      const message =
        result.kind === "empty-alias"
          ? "an alias cannot be blank"
          : result.kind === "unknown-target"
            ? `unknown target "${parsed.target}"`
            : result.kind === "ambiguous-target"
              ? ambiguousMessage(result)
              : `"${other}" already belongs to ${result.holder.canonicalName} — recording it here would leave the name resolving to two players, permanently`;
      emitSummary("player alias", "error", [["message", message]], opts);
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
