import { readFileSync } from "node:fs";
import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { addMatchFromScorecardWithArchive, describeMatchAddRefusal } from "../../ingest/match-add.js";
import { errorMessage } from "../../error-message.js";
import { scorecardPayloadSchema } from "../../ingest/scorecard.js";
import type { ScorecardPayload } from "../../ingest/scorecard.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary, type SummaryField } from "../emit.js";

/** Every reason a payload FILE cannot be used — an unreadable path, malformed JSON, or a shape
 * that fails `scorecardPayloadSchema` — collapsed into this one typed refusal (exit 1,
 * `status=error`), never an uncaught throw. */
export class InvalidScorecardPayloadFileError extends Error {}

/**
 * Reads and validates `path` as a scorecard payload. This command cannot read an image itself
 * (spec § Ingestion path 4: the AGENT reads the photo via vision; this command reads what the
 * agent already extracted) — a photo handed to it directly fails JSON.parse and lands in the same
 * refusal as malformed JSON, whose message names the agent/`match_add` path rather than pretending
 * this surface can read a screenshot.
 */
function readScorecardPayloadFile(path: string): ScorecardPayload {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new InvalidScorecardPayloadFileError(
      // `errorMessage`, not the template literal's own coercion: `${sym}` throws on a Symbol
      // where `String(sym)` does not, so an interpolating site is NOT already safe (#64).
      `could not read "${path}": ${errorMessage(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new InvalidScorecardPayloadFileError(
      `"${path}" is not a valid JSON scorecard payload — this command cannot read a screenshot ` +
        `directly; extract the payload via agent vision (see docs/runbooks/in-event-screenshot-ingest.md) ` +
        `or call the match_add MCP tool from agent chat`,
    );
  }

  const parsed = scorecardPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidScorecardPayloadFileError(
      `"${path}" is not a valid scorecard payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * `tn match add <payload-file>` — a positional target, no new flags (deliberately: bug #44 is
 * reachable only through a declared VALUE flag whose value is literally `--`, and this command adds
 * none). Reads an agent-extracted scorecard payload from `path`, archives the photo it names
 * (`sourceImage`) when present, and writes through `addMatchFromScorecard` — the SAME service the
 * `match_add` MCP tool calls, so the two surfaces cannot drift. This CLI surface and the MCP tool
 * deliberately differ in CAPABILITY, not contract: only the agent can produce a payload from a
 * photo; this command reads one that already exists as a file.
 */
export const matchAdd: Command = {
  noun: "match",
  verb: "add",
  summary: "Record a scorecard's results from an agent-extracted payload",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("match add", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("match add", "error", [["message", "usage: tn match add <payload-file>"]], opts);
      return 1;
    }

    let payload: ScorecardPayload;
    try {
      payload = readScorecardPayloadFile(parsed.target);
    } catch (err) {
      if (!(err instanceof InvalidScorecardPayloadFileError)) throw err;
      emitSummary("match add", "error", [["message", err.message]], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      // Ordering: the DB write runs FIRST, and the photo is archived only after it succeeds — a
      // refused ingest must persist nothing (Codex adversarial review, rated Critical). See
      // `addMatchFromScorecardWithArchive`'s own doc comment in src/ingest/match-add.ts for the
      // full reasoning, including the deliberate choice below for a post-commit archive failure.
      const { serviceResult: result, archivedPath, archiveError } = addMatchFromScorecardWithArchive(db, payload);
      if (!result.ok) {
        emitSummary("match add", "error", [["message", describeMatchAddRefusal(result)]], opts);
        return 1;
      }

      const fields: SummaryField[] = [
        ["home", payload.homeTeam],
        ["visiting", payload.visitingTeam],
        ["playedOn", payload.playedOn],
        ["teamMatchId", String(result.teamMatchId)],
        ["courts", result.courts],
      ];
      if (archivedPath !== undefined) fields.push(["archivedPath", archivedPath]);

      // The match write already committed by the time archiving can fail, so this is NOT
      // `status=error` (that would read as "nothing happened" when the match was, in fact,
      // recorded) — same shape as `tn team pull`'s existing `status=partial` for a
      // requested-but-unfulfilled roster cascade alongside an already-committed team write.
      if (archiveError !== undefined) {
        emitSummary("match add", "partial", [...fields, ["archiveError", archiveError]], opts);
        return 1;
      }

      emitSummary("match add", "ok", fields, opts);
      return 0;
    } finally {
      sqlite.close();
    }
  },
};
