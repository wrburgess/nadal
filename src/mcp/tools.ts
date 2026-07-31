// The MCP tool registry (Task 7, #17). Spec § Interfaces: "Same services; tool names mirror the
// grammar (`team_pull`, `player_show`, …)." Every handler below calls the EXACT service function its
// CLI-command sibling calls (`src/cli/commands/*.ts`) — no query, upsert, or write logic is
// re-implemented here. This module is deliberately transport-agnostic (no `@modelcontextprotocol/sdk`
// import): `src/mcp/server.ts` is the only place that wires these definitions to a real MCP server, so
// this whole table can be unit/parity-tested without standing up a server or a transport.

import { z } from "zod";
import { openDb, runMigrations } from "../db/client.js";
import { teams } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { pullArchivedUstaProfile } from "../ingest/archived.js";
import { fetchPage } from "../ingest/fetch.js";
import { addMatchFromScorecard, archiveScorecardImage, describeMatchAddRefusal } from "../ingest/match-add.js";
import { pullPlayer } from "../ingest/player-pull.js";
import { scorecardPayloadSchema } from "../ingest/scorecard.js";
import type { ScorecardPayload } from "../ingest/scorecard.js";
import { pullTeam } from "../ingest/team-pull.js";
import { setAvailability } from "../query/availability.js";
import { addCaptainNote } from "../query/captain-notes.js";
import { addEvent } from "../query/events.js";
import { NoCourtMatchHistoryError, getLineupPlan } from "../query/lineup.js";
import { setHomeTeam } from "../query/home-team.js";
import { getPlayerProfile, resolvePlayerTarget } from "../query/player-profile.js";
import { getTeamProfile, resolveTeamTarget } from "../query/team-profile.js";
import { countTeams, resolvedReportsRoot, writeSectionalsDossiers, writeTeamDossier } from "../report/write.js";
import { sixMonthsAgo } from "../cli/window.js";

/** A tool-level refusal, mapped to `CallToolResult.isError` by `src/mcp/server.ts` — never a crash.
 * Every "unknown target" / "ambiguous target" / domain-service refusal below throws this (or lets
 * the underlying service's own distinct error class propagate) rather than returning a sentinel. */
export class McpToolError extends Error {}

export type McpToolDef = {
  /** `noun_verb` — mirrors the CLI grammar's `tn <noun> <verb>` (spec § Interfaces). */
  name: string;
  /** The CLI command this tool mirrors, `"<noun> <verb>"` — what `test/mcp-tool-parity.test.ts`
   * checks both directions against `src/cli/router.ts`'s `COMMANDS`. */
  cliCommand: string;
  description: string;
  /** A zod raw shape (plain object of per-field schemas), the shape `McpServer#registerTool`'s
   * `inputSchema` option expects — the SDK itself validates a call's arguments against this and
   * returns a structured error result on a missing/invalid required field, so no tool handler below
   * re-validates presence by hand. */
  inputShape: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

/** Every "unknown target" / "ambiguous target" resolution outcome, mapped to the same message shape
 * every CLI command already uses — shared here so all eight target-resolving tools stay consistent. */
function requireResolved<T extends { kind: string }>(
  resolution: T,
  label: string,
  target: string,
): Exclude<T, { kind: "not-found" } | { kind: "ambiguous" }> {
  if (resolution.kind === "not-found") {
    throw new McpToolError(`unknown ${label} "${target}"`);
  }
  if (resolution.kind === "ambiguous") {
    const candidates = (resolution as unknown as { candidates: string[] }).candidates;
    throw new McpToolError(`ambiguous ${label}: ${candidates.join(", ")}`);
  }
  return resolution as Exclude<T, { kind: "not-found" } | { kind: "ambiguous" }>;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "db_migrate",
    cliCommand: "db migrate",
    description: "Apply pending schema migrations",
    inputShape: {},
    handler: async () => {
      runMigrations();
      return { status: "ok" };
    },
  },

  {
    name: "team_pull",
    cliCommand: "team pull",
    description: "Pull a team roster and schedule from TennisRecord",
    inputShape: {
      target: z.string().min(1),
      players: z.boolean().optional(),
      from: z.string().optional(),
      sourceUrl: z.string().optional(),
    },
    handler: async (rawArgs) => {
      const args = rawArgs as { target: string; players?: boolean; from?: string; sourceUrl?: string };
      if ((args.from !== undefined) !== (args.sourceUrl !== undefined)) {
        throw new McpToolError("from requires sourceUrl and vice versa");
      }
      const { db, sqlite } = openDb();
      try {
        const result = await pullTeam({
          db,
          fetchPage,
          target: args.target,
          cascadePlayers: args.players === true,
          from: args.from !== undefined && args.sourceUrl !== undefined ? { path: args.from, sourceUrl: args.sourceUrl } : undefined,
        });
        if (result.kind !== "ok") {
          throw new McpToolError(
            result.kind === "ambiguous" ? `ambiguous target: ${result.candidates.join(", ")}` : result.message,
          );
        }
        return {
          team: result.team.name,
          rosterCount: result.rosterCount,
          matchCount: result.matchCount,
          archivedPath: result.archivedPath,
          skippedRosterEntries: result.skippedRosterEntries,
        };
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "team_show",
    cliCommand: "team show",
    description: "Show a team's roster and match record",
    inputShape: { target: z.string().min(1) },
    handler: async (rawArgs) => {
      const { target } = rawArgs as { target: string };
      const { db, sqlite } = openDb();
      try {
        const resolution = requireResolved(resolveTeamTarget(db, target), "target", target);
        return getTeamProfile(db, resolution.teamId, { since: sixMonthsAgo() });
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "team_home",
    cliCommand: "team home",
    description: "Designate a team as home (our team) for availability, notes, and dossiers",
    inputShape: { target: z.string().min(1) },
    handler: async (rawArgs) => {
      const { target } = rawArgs as { target: string };
      const { db, sqlite } = openDb();
      try {
        const resolution = requireResolved(resolveTeamTarget(db, target), "target", target);
        setHomeTeam(db, resolution.teamId);
        const team = db.select().from(teams).where(eq(teams.id, resolution.teamId)).all()[0]!;
        return { team: team.name };
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "player_pull",
    cliCommand: "player pull",
    description: "Pull a player's ratings and match history from TennisRecord",
    inputShape: { target: z.string().min(1), from: z.string().optional(), sourceUrl: z.string().optional() },
    handler: async (rawArgs) => {
      const args = rawArgs as { target: string; from?: string; sourceUrl?: string };
      if ((args.from !== undefined) !== (args.sourceUrl !== undefined)) {
        throw new McpToolError("from requires sourceUrl and vice versa");
      }
      const { db, sqlite } = openDb();
      try {
        // Mirrors src/cli/commands/player-pull.ts exactly: usta:/wtn: targets are login-gated and
        // route through the archived, login-assisted path, which REQUIRES from+sourceUrl since this
        // tool never automates a login itself.
        const isLoginGated = args.target.startsWith("usta:") || args.target.startsWith("wtn:");
        const result = isLoginGated
          ? await (async () => {
              if (args.from === undefined || args.sourceUrl === undefined) {
                throw new McpToolError(
                  `target "${args.target}" requires from and sourceUrl (login-assisted path)`,
                );
              }
              return pullArchivedUstaProfile({ db, path: args.from, sourceUrl: args.sourceUrl });
            })()
          : await pullPlayer({
              db,
              fetchPage,
              target: args.target,
              from: args.from !== undefined && args.sourceUrl !== undefined ? { path: args.from, sourceUrl: args.sourceUrl } : undefined,
            });
        if (result.kind !== "ok") {
          throw new McpToolError(
            result.kind === "ambiguous" ? `ambiguous target: ${result.candidates.join(", ")}` : result.message,
          );
        }
        return {
          player: result.player.canonicalName,
          archivedPath: result.archivedPath,
          courtMatchCount: "courtMatchCount" in result ? result.courtMatchCount : undefined,
        };
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "player_show",
    cliCommand: "player show",
    description: "Show a player's full profile: ratings trajectory, history, records",
    inputShape: { target: z.string().min(1) },
    handler: async (rawArgs) => {
      const { target } = rawArgs as { target: string };
      const { db, sqlite } = openDb();
      try {
        const resolution = requireResolved(resolvePlayerTarget(db, target), "target", target);
        return getPlayerProfile(db, resolution.playerId, { since: sixMonthsAgo() });
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "player_avail",
    cliCommand: "player avail",
    description: "Record a home-team player's availability for an event day",
    inputShape: {
      target: z.string().min(1),
      day: z.string().min(1),
      status: z.string().min(1),
      // Optional, and needed only when the day falls inside more than one event's range — the
      // ordinary case once a league season and a tournament both exist.
      event: z.string().optional(),
    },
    handler: async (rawArgs) => {
      const { target, day, status, event } = rawArgs as {
        target: string;
        day: string;
        status: string;
        event?: string;
      };
      const { db, sqlite } = openDb();
      try {
        const resolution = requireResolved(resolvePlayerTarget(db, target), "target", target);
        const result = setAvailability(db, { playerId: resolution.playerId, day, status, eventName: event });
        return { player: target, day, availability: result.status, event: result.eventName };
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "lineup_plan",
    cliCommand: "lineup plan",
    description: "Predict an opponent's lineup from court-assignment history and ratings",
    inputShape: { target: z.string().min(1) },
    handler: async (rawArgs) => {
      const { target } = rawArgs as { target: string };
      const { db, sqlite } = openDb();
      try {
        const resolution = requireResolved(resolveTeamTarget(db, target), "target", target);
        try {
          // The structured plan, not the CLI's rendered text: agent chat is where the pairings get
          // worked (spec § Deliverables 3), and it needs the confidence/basis/support fields to
          // reason with. The "this is a guess" framing rides in the fields themselves rather than
          // in prose a model might drop.
          return getLineupPlan(db, resolution.teamId);
        } catch (err) {
          if (!(err instanceof NoCourtMatchHistoryError)) throw err;
          throw new McpToolError(
            `no court-match history on file for "${target}" — run the team_pull tool with players: true first`,
          );
        }
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "event_add",
    cliCommand: "event add",
    description: "Create or update an event and its inclusive date range",
    inputShape: {
      target: z.string().min(1),
      kind: z.string().min(1),
      startsOn: z.string().min(1),
      endsOn: z.string().min(1),
    },
    handler: async (rawArgs) => {
      const { target, kind, startsOn, endsOn } = rawArgs as {
        target: string;
        kind: string;
        startsOn: string;
        endsOn: string;
      };
      const { db, sqlite } = openDb();
      try {
        // No `requireResolved` here, unlike every other target-taking tool: this is the writer that
        // CREATES events, so resolving the name against existing rows first would make it
        // impossible to add the first one.
        const result = addEvent(db, { name: target, kind, startsOn, endsOn });
        return {
          event: result.name,
          kind: result.kind,
          startsOn: result.startsOn,
          endsOn: result.endsOn,
          created: result.created,
        };
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "match_add",
    cliCommand: "match add",
    description: "Record a scorecard's results from an agent-extracted payload",
    // The payload INLINE, not a file — that is the whole point: the agent has just produced this
    // shape from vision and has no file to hand (unlike `tn match add <file>`, the CLI's own
    // presenter for the same service). `scorecardPayloadSchema.shape` is spread directly rather
    // than re-declared here, so the two surfaces cannot silently drift on what counts as valid —
    // every nested check (a court's per-discipline player-count invariant, `playedOn`'s calendar-
    // date rule) rides along unchanged, since it lives on the schema object itself.
    inputShape: { ...scorecardPayloadSchema.shape },
    handler: async (rawArgs) => {
      // No `requireResolved` here, matching `event_add` above: this writer's whole point is to
      // persist rows an agent just extracted from a photo, and the SDK has already validated
      // `rawArgs` against `scorecardPayloadSchema`'s own shape via `inputShape`.
      const payload = rawArgs as ScorecardPayload;
      const { db, sqlite } = openDb();
      try {
        const archivedPath =
          payload.sourceImage === undefined ? undefined : archiveScorecardImage(payload.sourceImage);
        const result = addMatchFromScorecard(db, payload);
        if (!result.ok) throw new McpToolError(describeMatchAddRefusal(result));
        return { teamMatchId: result.teamMatchId, courts: result.courts, archivedPath };
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "player_note",
    cliCommand: "player note",
    description: "Append a captain note about a home-team player or pairing",
    inputShape: { target: z.string().min(1), text: z.string(), pairTarget: z.string().optional() },
    handler: async (rawArgs) => {
      const { target, text, pairTarget } = rawArgs as { target: string; text: string; pairTarget?: string };
      const { db, sqlite } = openDb();
      try {
        const resolution = requireResolved(resolvePlayerTarget(db, target), "target", target);
        // A PAIRING note (`pairTarget` given) is reachable only over MCP, not the CLI (see
        // src/cli/commands/player-note.ts's own doc comment) — agent chat is where a second name is
        // natural to supply conversationally, spec § Interfaces.
        const pairPlayerId =
          pairTarget === undefined
            ? undefined
            : requireResolved(resolvePlayerTarget(db, pairTarget), "pairTarget", pairTarget).playerId;
        const note = addCaptainNote(db, { playerId: resolution.playerId, pairPlayerId, text });
        return { player: target, note: note.note, pairPlayerId: note.pairPlayerId, createdAt: note.createdAt };
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "report_build",
    cliCommand: "report build",
    description: "Render per-opponent scouting dossiers (HTML + markdown) to disk",
    inputShape: { target: z.string().optional() },
    handler: async (rawArgs) => {
      const { target } = rawArgs as { target?: string };
      const since = sixMonthsAgo();
      const { db, sqlite } = openDb();
      try {
        let written: string[];
        let teamsCount: number;
        if (target === undefined || target === "sectionals") {
          written = writeSectionalsDossiers(db, { since });
          teamsCount = countTeams(db);
        } else {
          const resolution = requireResolved(resolveTeamTarget(db, target), "target", target);
          written = writeTeamDossier(db, resolution.teamId, { since });
          teamsCount = 1;
        }
        return { target: target ?? "sectionals", teams: teamsCount, files: written.length, root: resolvedReportsRoot() };
      } finally {
        sqlite.close();
      }
    },
  },
];
