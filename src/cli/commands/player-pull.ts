import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { pullArchivedUstaProfile } from "../../ingest/archived.js";
import { fetchPage } from "../../ingest/fetch.js";
import { pullPlayer } from "../../ingest/player-pull.js";
import { pullArchivedWtnProfile } from "../../ingest/wtn-profile-pull.js";
import { ambiguousMessage, type AmbiguousIdentity } from "../../ingest/errors.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary, type EmitOpts } from "../emit.js";

type ReportableResult =
  | { kind: "ok"; player: { canonicalName: string }; archivedPath: string; courtMatchCount?: number }
  | { kind: "unknown-target"; message: string }
  | ({ kind: "ambiguous" } & AmbiguousIdentity)
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
      // These targets all read a SAVED PAGE rather than fetching, but for two different reasons,
      // and conflating them misdirects the operator:
      //
      //  - `usta:`/`wtn:` are LOGIN-gated. WTN rides on the same USTA profile page (one fetch, two
      //    parsers — see src/ingest/archived.ts), which only exists behind a signed-in session, and
      //    this tool never automates a login.
      //  - `wtn-profile:` (issue #128) is a THIRD, distinct source — a player's own WTN profile page
      //    at worldtennisnumber.com, not the ITF widget embedded in the USTA page — and it is
      //    **PUBLIC**. No login, no account, no token. What it needs is JavaScript: a plain fetch
      //    returns a data-less shell, so the saved page must be a post-render DOM. Telling an
      //    operator to log in for it sends them somewhere there is nothing to do, and contradicts
      //    docs/runbooks/capture-wtn-profile.md, which says explicitly not to.
      //
      // `wtn:` keeps its existing, documented meaning unchanged; `.startsWith("wtn:")` does not also
      // match `wtn-profile:…` (the fourth character differs, `-` vs `:`), so the two never collide.
      const isWtnProfile = parsed.target.startsWith("wtn-profile:");
      const isLoginGated = parsed.target.startsWith("usta:") || parsed.target.startsWith("wtn:");
      const needsSavedPage = isLoginGated || isWtnProfile;
      if (needsSavedPage) {
        if (typeof from !== "string" || typeof sourceUrl !== "string") {
          const why = isWtnProfile
            ? "public page, but client-rendered — save the post-render DOM; no login needed"
            : "login-assisted path";
          emitSummary(
            "player pull",
            "error",
            [["message", `target "${parsed.target}" requires --from and --source-url (${why})`]],
            opts,
          );
          return 1;
        }
        const result = isWtnProfile
          ? await pullArchivedWtnProfile({ db, path: from, sourceUrl })
          : await pullArchivedUstaProfile({ db, path: from, sourceUrl });
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
