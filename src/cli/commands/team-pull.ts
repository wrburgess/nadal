import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { fetchPage } from "../../ingest/fetch.js";
import { pullTeam } from "../../ingest/team-pull.js";
import { ambiguousMessage } from "../../ingest/errors.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary, type SummaryField } from "../emit.js";

export const teamPull: Command = {
  noun: "team",
  verb: "pull",
  summary: "Pull a team roster and schedule from TennisRecord",
  // Declared here rather than only inline in `run` below (#44 Task 4) so `dispatch`'s
  // value-flag-aware `--help` scan (src/cli/router.ts) reads the exact same lists `run` parses
  // with — one declaration, not two that a future edit could let drift apart. Self-reference is
  // safe: `run` is a closure that only reads `teamPull` when it is actually invoked, long after
  // this object literal has finished initializing.
  booleanFlags: ["players"],
  valueFlags: ["from", "source-url", "since"],
  run: async (args) => {
    const parsed = parseArgs(args, teamPull.booleanFlags ?? [], teamPull.valueFlags ?? []);
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
    // Issue #108. Passed through unvalidated on purpose: `cascadeYears` owns every rule about what a
    // season is, and re-checking the shape here would be a second spelling of one predicate. An
    // invalid value comes back as a `{ kind: "error" }` and prints on the `status=error` branch below.
    const since = parsed.flags.since;
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
        since: typeof since === "string" ? since : undefined,
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
          // Issue #108: which seasons the cascade fetched, newest first — empty without `--players`.
          // Reported on BOTH the `ok` and `partial` branches (they spread `fields`) because a
          // one-year pull and a range pull are otherwise indistinguishable from the summary line,
          // which is exactly how the single-year defect stayed invisible for the whole v1 build.
          ["years", result.years.join(",")],
        ];

        // The team transaction has already committed, so a cascade failure is NOT an error — but it
        // is not `ok` either. Discarding `skippedRosterEntries` and printing `status=ok` meant a
        // command that was explicitly asked to enrich players could report success having enriched
        // ZERO of them, with an irreversible team write already on disk. (Codex adversarial review,
        // PR #31, rated high.) A requested-but-unfulfilled cascade reports `status=partial`, names
        // the entries, and exits non-zero — the outcome is visible to a caller that only reads the
        // exit code.
        if (result.skippedRosterEntries.length > 0) {
          // Issue #98. `skipped=K` alone said how much did not land, never what to do about it — an
          // operator could not tell a rate-limited pull to re-run from a dead URL to investigate
          // without reading the stderr warnings one by one. The three counts sum to `skipped`, so a
          // caller reading only this line can size the re-run; the per-entry `[disposition]` suffix
          // says which entries make it up.
          //
          // Counted from the SAME array that is rendered, in one pass — not tallied from a second
          // read of the result — so a count and the entries it summarizes cannot disagree.
          const counts = { retryable: 0, permanent: 0, unclassified: 0 };
          const rendered: string[] = [];
          for (const skipped of result.skippedRosterEntries) {
            counts[skipped.disposition] += 1;
            rendered.push(`${skipped.entry} [${skipped.disposition}]`);
          }

          emitSummary(
            "team pull",
            "partial",
            [
              ...fields,
              ["skipped", result.skippedRosterEntries.length],
              ["retryable", counts.retryable],
              ["permanent", counts.permanent],
              ["unclassified", counts.unclassified],
              // Separator unchanged from before #98. It is a HUMAN display and not a safe parse
              // target — a scraped roster name may itself contain `,` or `[` — which is why the
              // machine surface for this is the MCP handler's structured `skippedRosterEntries`, and
              // why the three counts above are their own fields rather than something to extract
              // from this string. GRAMMAR.md states that limit rather than leaving it implied.
              ["skippedEntries", rendered.join(", ")],
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
          ? ambiguousMessage(result)
          : result.message;
      emitSummary("team pull", "error", [["message", message]], opts);
      return 1;
    } finally {
      sqlite.close();
    }
  },
};
