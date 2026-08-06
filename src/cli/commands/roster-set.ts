import { readFileSync } from "node:fs";
import type { Command } from "../router.js";
import { openDb } from "../../db/client.js";
import { errorMessage } from "../../error-message.js";
import { describeSetEventRosterRefusal, setEventRoster } from "../../ingest/roster-set.js";
import { rosterPayloadSchema } from "../../ingest/roster-payload.js";
import type { RosterPayload } from "../../ingest/roster-payload.js";
import { globalFlags, parseArgs } from "../args.js";
import { emitSummary } from "../emit.js";

/** Every reason a payload FILE cannot be used — an unreadable path, malformed JSON, or a shape
 * that fails `rosterPayloadSchema` — collapsed into this one typed refusal (exit 1,
 * `status=error`), never an uncaught throw. Mirrors `InvalidScorecardPayloadFileError`
 * (src/cli/commands/match-add.ts) exactly. */
export class InvalidRosterPayloadFileError extends Error {}

/** Reads and validates `path` as a roster payload — the `tn match add`/`readScorecardPayloadFile`
 * shape (match-add.ts:23-53): readFileSync -> JSON.parse -> `safeParse`, all three failure modes
 * collapsed into one refusal class. */
function readRosterPayloadFile(path: string): RosterPayload {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new InvalidRosterPayloadFileError(
      // `errorMessage`, not the template literal's own coercion (#64).
      `could not read "${path}": ${errorMessage(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new InvalidRosterPayloadFileError(
      `"${path}" is not a valid JSON roster payload — author one by hand ({"team", "event", ` +
        `"players"}) or call the roster_set MCP tool from agent chat`,
    );
  }

  const parsed = rosterPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidRosterPayloadFileError(
      `"${path}" is not a valid roster payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * `tn roster set <payload-file>` (#113) — a positional target that is a FILE PATH, `tn match add`'s
 * shape, not `tn player avail`'s inline payload positionals: the source is a login-gated
 * registration page, so the primary door is the `roster_set` MCP tool (an agent reads the page and
 * calls it inline); this CLI surface is the re-runnable, auditable fallback that reads what an
 * agent already wrote to disk.
 *
 * Sets `payload.team`'s registered roster for `payload.event` to EXACTLY `payload.players` — the
 * HC's "replaces, does not accumulate" (`setEventRoster`, src/ingest/roster-set.ts, carries the full
 * reasoning). Re-running the SAME payload is a no-op; dropping a name from a re-run retires that
 * one membership at event scope, and re-adding a dropped name un-retires it rather than duplicating.
 */
export const rosterSet: Command = {
  noun: "roster",
  verb: "set",
  summary: "Replace an event's registered roster from a payload file",
  run: async (args) => {
    const parsed = parseArgs(args, [], []);
    const opts = globalFlags(parsed.flags);
    if (parsed.error !== undefined) {
      emitSummary("roster set", "error", [["message", parsed.error]], opts);
      return 1;
    }
    if (parsed.target === undefined) {
      emitSummary("roster set", "error", [["message", "usage: tn roster set <payload-file>"]], opts);
      return 1;
    }

    let payload: RosterPayload;
    try {
      payload = readRosterPayloadFile(parsed.target);
    } catch (err) {
      if (!(err instanceof InvalidRosterPayloadFileError)) throw err;
      emitSummary("roster set", "error", [["message", err.message]], opts);
      return 1;
    }

    const { db, sqlite } = openDb();
    try {
      const result = setEventRoster(db, payload);
      if (!result.ok) {
        emitSummary("roster set", "error", [["message", describeSetEventRosterRefusal(result)]], opts);
        return 1;
      }

      emitSummary(
        "roster set",
        "ok",
        [
          ["team", result.teamName],
          ["event", result.eventName],
          ["registered", result.registered],
          ["retired", result.retired],
        ],
        opts,
      );
      return 0;
    } finally {
      sqlite.close();
    }
  },
};
