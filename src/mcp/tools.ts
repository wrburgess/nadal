// The MCP tool registry (Task 7, #17). Spec § Interfaces: "Same services; tool names mirror the
// grammar (`team_pull`, `player_show`, …)." Every handler below calls the EXACT service function its
// CLI-command sibling calls (`src/cli/commands/*.ts`) — no query, upsert, or write logic is
// re-implemented here. This module is deliberately transport-agnostic (no `@modelcontextprotocol/sdk`
// import): `src/mcp/server.ts` is the only place that wires these definitions to a real MCP server, so
// this whole table can be unit/parity-tested without standing up a server or a transport.

import { z } from "zod";
import { backupDatabase } from "../db/backup.js";
import { openDb, runMigrations } from "../db/client.js";
import { teams } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { pullArchivedUstaProfile } from "../ingest/archived.js";
import { declareDistinctPlayer, recordPlayerAlias } from "../ingest/disambiguate.js";
import { ambiguousMessage } from "../ingest/errors.js";
import { fetchPage } from "../ingest/fetch.js";
import { addMatchFromScorecardWithArchive, describeMatchAddRefusal } from "../ingest/match-add.js";
import { pullPlayer } from "../ingest/player-pull.js";
import { rosterPayloadSchema } from "../ingest/roster-payload.js";
import type { RosterPayload } from "../ingest/roster-payload.js";
import { describeSetEventRosterRefusal, setEventRoster } from "../ingest/roster-set.js";
import { scorecardPayloadSchema } from "../ingest/scorecard.js";
import type { ScorecardPayload } from "../ingest/scorecard.js";
import { pullTeam } from "../ingest/team-pull.js";
import { setAvailability } from "../query/availability.js";
import { addCaptainNote } from "../query/captain-notes.js";
import { addEvent, resolveSeasonAnchor } from "../query/events.js";
import { NoCourtMatchHistoryError, getLineupPlan, resolveEvent } from "../query/lineup.js";
import { setHomeTeam } from "../query/home-team.js";
import { getPlayerProfile, resolvePlayerTarget } from "../query/player-profile.js";
import { getTeamProfile, resolveTeamTarget } from "../query/team-profile.js";
import { countTeams, resolvedReportsRoot, writeSectionalsDossiers, writeTeamDossier } from "../report/write.js";
import { seasonStart, seasonWindow } from "../cli/window.js";

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

/** Every "unknown target" / ambiguous-target resolution outcome, mapped to the same message shape
 * every CLI command already uses — shared here so all eight target-resolving tools stay consistent.
 *
 * The ambiguous branch renders through `ambiguousMessage` (src/ingest/errors.ts), the ONE formatter
 * every surface uses, so the three facts #94 requires are reported here too: a target-tier
 * ambiguity has an incoming name (the target the caller supplied) exactly like a deep one does, and
 * printing only the candidates was how the pre-#94 message managed to name nobody who was actually
 * in question. `label` names which argument was ambiguous (`target`, `pairTarget`), which is the
 * context a caller passing two names needs to tell them apart. */
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
    throw new McpToolError(ambiguousMessage({ incoming: target, candidates, context: `${label} name` }));
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
    name: "db_backup",
    cliCommand: "db backup",
    description: "Take a verified snapshot of the database",
    inputShape: {},
    // Not optional (issue #110, Task 5): test/mcp-tool-parity.test.ts requires a tool per
    // registered command, and `CLI_ONLY_COMMANDS` is reserved for a command with no service
    // function to call — `db backup` has one (`backupDatabase`), so it is mirrored like every
    // other command rather than opted out. Returns the real `BackupResult` object, matching every
    // other writer above that hands back its own result rather than a bare `{status:"ok"}` —
    // `db_migrate`'s literal status object above is the exception, since `runMigrations` itself
    // returns nothing to report.
    handler: async () => backupDatabase(),
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
      // Issue #108. Deliberately `z.string()` rather than a `z.number()` or a regex: `cascadeYears`
      // owns every rule about what a season is, and a second shape declared here would be a second
      // spelling of one predicate — the exact drift that let the CLI and this surface disagree in
      // #94. An invalid value reaches the service and comes back as a named refusal.
      since: z.string().optional(),
    },
    handler: async (rawArgs) => {
      const args = rawArgs as { target: string; players?: boolean; from?: string; sourceUrl?: string; since?: string };
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
          since: args.since,
          from: args.from !== undefined && args.sourceUrl !== undefined ? { path: args.from, sourceUrl: args.sourceUrl } : undefined,
        });
        if (result.kind !== "ok") {
          // The SAME formatter the CLI and the cascade warning use (src/ingest/errors.ts). This
          // read `ambiguous target: <candidates>` — the pre-#94 message — for the whole of #94's
          // first pass, because the formatter then lived in `src/cli/emit.ts` and this surface had
          // no reason to reach into the CLI for it. So the fix landed on two of the three reporters
          // and an agent driving nadal over MCP still got the wrong person's name with no incoming
          // value, which is the entire defect #94 exists to close.
          throw new McpToolError(result.kind === "ambiguous" ? ambiguousMessage(result) : result.message);
        }
        return {
          team: result.team.name,
          rosterCount: result.rosterCount,
          matchCount: result.matchCount,
          archivedPath: result.archivedPath,
          // Issue #98: each element is now a RECORD — `{ entry, disposition, reason }` — not a bare
          // name. This is a breaking change to this tool's result shape, made deliberately: an agent
          // driving nadal over MCP is the caller least able to read a stderr warning line, so a name
          // list left it unable to tell a pull worth re-running from one worth investigating. It
          // gets the fields; the CLI renders the same records into its summary line.
          //
          // `sanitizeJson` (src/sanitize.ts) recurses into arrays and plain-prototype objects, so
          // the scraped `entry` and the failure-quoting `reason` are both sanitized at this
          // boundary exactly as the flat strings were.
          skippedRosterEntries: result.skippedRosterEntries,
          // Issue #49: same reason `tn team pull` prints `retired=N` — retirement REMOVES a player
          // from every current-roster read and write gate, so it has to be visible in the surface's
          // own output rather than only in the database. This handler hand-builds its result object
          // (it does not spread `result`), so a field added to the CLI summary does NOT reach MCP on
          // its own: omitting it here would let an MCP-driven pull retire real teammates with
          // nothing in the response to say so, while the CLI reported it.
          retiredCount: result.retiredCount,
          // Issue #108, and for the same reason `retiredCount` is spelled out above: this handler
          // hand-builds its result object, so a field added to the CLI summary does NOT reach MCP on
          // its own. Omitting it would leave an MCP-driven caller unable to tell a one-season pull
          // from a range pull — the exact blindness that hid the single-year defect.
          years: result.years,
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
    inputShape: {
      target: z.string().min(1),
      // #97: resolves against `events.name`; its league scope restricts the court matches every
      // roster record and slot tendency below is computed over. A bad name propagates as its own
      // distinct error class, which the SDK converts to a structured result (src/mcp/server.ts).
      event: z.string().optional(),
    },
    handler: async (rawArgs) => {
      const { target, event } = rawArgs as { target: string; event?: string };
      const { db, sqlite } = openDb();
      try {
        const resolution = requireResolved(resolveTeamTarget(db, target), "target", target);
        const leagueScope = event === undefined ? null : resolveEvent(db, event).leagueScope;
        // The scope summary rides inside the returned profile (`evidenceScope`), so an agent reading
        // this over MCP is handed the same disclosure the CLI prints rather than a bare set of
        // records it would have to take on trust — #97's whole point, one surface over.
        return getTeamProfile(db, resolution.teamId, { since: seasonStart(), leagueScope });
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
          // The SAME formatter the CLI and the cascade warning use (src/ingest/errors.ts). This
          // read `ambiguous target: <candidates>` — the pre-#94 message — for the whole of #94's
          // first pass, because the formatter then lived in `src/cli/emit.ts` and this surface had
          // no reason to reach into the CLI for it. So the fix landed on two of the three reporters
          // and an agent driving nadal over MCP still got the wrong person's name with no incoming
          // value, which is the entire defect #94 exists to close.
          throw new McpToolError(result.kind === "ambiguous" ? ambiguousMessage(result) : result.message);
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
    inputShape: {
      target: z.string().min(1),
      // #97, same as `team_show` above — the event whose league scope this profile's records were
      // computed under. Omitted, every league counts, and `evidenceScope` in the result says so.
      event: z.string().optional(),
    },
    handler: async (rawArgs) => {
      const { target, event } = rawArgs as { target: string; event?: string };
      const { db, sqlite } = openDb();
      try {
        const resolution = requireResolved(resolvePlayerTarget(db, target), "target", target);
        const leagueScope = event === undefined ? null : resolveEvent(db, event).leagueScope;
        return getPlayerProfile(db, resolution.playerId, { since: seasonStart(), leagueScope });
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
    inputShape: {
      target: z.string().min(1),
      // #63: resolves against `events.name`; its format REPLACES the derived slot set. A bad name
      // (unknown, or on file with no format) propagates as its own distinct error class — the SDK
      // converts any thrown error into a structured result (src/mcp/server.ts), so no special
      // wrapping is needed here beyond the one NoCourtMatchHistoryError already gets below.
      event: z.string().optional(),
    },
    handler: async (rawArgs) => {
      const { target, event } = rawArgs as { target: string; event?: string };
      const { db, sqlite } = openDb();
      try {
        const resolution = requireResolved(resolveTeamTarget(db, target), "target", target);
        try {
          // The structured plan, not the CLI's rendered text: agent chat is where the pairings get
          // worked (spec § Deliverables 3), and it needs the confidence/basis/support fields to
          // reason with. The "this is a guess" framing rides in the fields themselves rather than
          // in prose a model might drop.
          return getLineupPlan(db, resolution.teamId, event);
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
      // #63: raw `parseEventFormat` syntax (e.g. "S1:singles,D1:doubles") — omitted preserves
      // whatever is already stored, matching the CLI's own "never clobber with an incoming null"
      // rule (see `addEvent`'s doc comment).
      format: z.string().optional(),
      // #97: raw `parseLeagueScope` syntax ("exclude:Mixed" / "only:Mixed") — the event's evidence
      // scope, under the identical omitted-preserves rule. Unlike the CLI's sixth positional, this
      // is nameable WITHOUT also supplying a format, since MCP arguments are keyed rather than
      // ordered — the one place that stated CLI limitation does not apply.
      leagueScope: z.string().optional(),
    },
    handler: async (rawArgs) => {
      const { target, kind, startsOn, endsOn, format, leagueScope } = rawArgs as {
        target: string;
        kind: string;
        startsOn: string;
        endsOn: string;
        format?: string;
        leagueScope?: string;
      };
      const { db, sqlite } = openDb();
      try {
        // No `requireResolved` here, unlike every other target-taking tool: this is the writer that
        // CREATES events, so resolving the name against existing rows first would make it
        // impossible to add the first one.
        const result = addEvent(db, { name: target, kind, startsOn, endsOn, format, leagueScope });
        return {
          event: result.name,
          kind: result.kind,
          startsOn: result.startsOn,
          endsOn: result.endsOn,
          created: result.created,
          // Only when a format is actually on file — omitted (rather than `format: null`) when
          // none, so a call that never mentions a format gets back exactly the same shape it always
          // has, matching the CLI summary line's identical "only when non-null" convention.
          ...(result.format !== null ? { format: result.format } : {}),
          ...(result.leagueScope !== null ? { leagueScope: result.leagueScope } : {}),
        };
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "roster_set",
    cliCommand: "roster set",
    description: "Replace an event's registered roster from a payload",
    // The payload INLINE, not a file — the source is a login-gated registration page, so the
    // primary door is an agent reading it and calling this tool with what it read; `tn roster set
    // <file>` is the re-runnable, auditable fallback that reads the identical shape from disk.
    // `rosterPayloadSchema` carries no top-level `.superRefine` — every invariant (team/event/player
    // resolution, duplicate names, the "replaces, does not accumulate" reconcile) lives in the
    // SERVICE (`setEventRoster`, called identically by both presenters), so the
    // spread-drops-a-whole-object-refinement trap documented on `match_add` above does not apply:
    // `players.min(1)` is a per-field validator and DOES survive `.shape` being spread into
    // `inputShape`.
    inputShape: { ...rosterPayloadSchema.shape },
    handler: async (rawArgs) => {
      const payload = rawArgs as RosterPayload;
      const { db, sqlite } = openDb();
      try {
        const result = setEventRoster(db, payload);
        if (!result.ok) throw new McpToolError(describeSetEventRosterRefusal(result));
        return {
          team: result.teamName,
          event: result.eventName,
          registered: result.registered,
          retired: result.retired,
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
    // than re-declared here, so the two surfaces cannot drift on any PER-KEY schema: each field's
    // own validator (a court's per-discipline player-count invariant, `playedOn`'s calendar-date
    // rule) rides along unchanged, since it lives on that field's own schema object, and
    // `McpServer#registerTool` rebuilds `z.object(inputShape)` from these same per-key schemas.
    //
    // What the spread does NOT carry: a top-level `.superRefine` on the WHOLE payload object.
    // A cross-field invariant declared that way on `scorecardPayloadSchema` itself — rather than on
    // one of its fields — would apply when the CLI parses the whole object directly, and silently
    // NOT apply here, protecting one surface and skipping the other with no error at all (PR #54
    // verify, findings 1-2 — the exact trap `docs/findings.md:195` already names: a true sentence
    // about what a spread preserves, read one inference too far into what it preserves). That is
    // exactly why the duplicate-resolved-player and same-team invariants live in the SERVICE
    // (`addMatchFromScorecard`, `src/ingest/match-add.ts`) instead: both presenters call that one
    // function, so both get the same guard for free, and neither schema carries a cross-field check
    // this spread would only sometimes honor.
    inputShape: { ...scorecardPayloadSchema.shape },
    handler: async (rawArgs) => {
      // No `requireResolved` here, matching `event_add` above: this writer's whole point is to
      // persist rows an agent just extracted from a photo, and the SDK has already validated
      // `rawArgs` against `scorecardPayloadSchema`'s own shape via `inputShape`.
      const payload = rawArgs as ScorecardPayload;
      const { db, sqlite } = openDb();
      try {
        // Ordering: the DB write runs FIRST, and the photo is archived only after it succeeds — a
        // refused ingest must persist nothing (Codex adversarial review, rated Critical). See
        // `addMatchFromScorecardWithArchive`'s own doc comment in src/ingest/match-add.ts for why a
        // post-commit archive failure is returned as `archiveError` rather than thrown: the write
        // has already committed by then, so throwing would hide a successful `teamMatchId` behind
        // what reads as a total failure.
        const { serviceResult: result, archivedPath, archiveError } = addMatchFromScorecardWithArchive(db, payload);
        if (!result.ok) throw new McpToolError(describeMatchAddRefusal(result));
        return { teamMatchId: result.teamMatchId, courts: result.courts, archivedPath, archiveError };
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
    name: "player_distinct",
    cliCommand: "player distinct",
    description: "Declare a name a different person from its near-matches, creating that player",
    inputShape: { target: z.string().min(1) },
    handler: async (rawArgs) => {
      const { target } = rawArgs as { target: string };
      const { db, sqlite } = openDb();
      try {
        // No `requireResolved`, matching `event_add`/`match_add`: this is a WRITER that creates the
        // identity, so resolving the name against existing rows first is precisely the refusal it
        // exists to settle.
        const result = declareDistinctPlayer(db, { name: target });
        if (result.kind === "created") {
          return { player: result.player.canonicalName, created: true, distinctFrom: result.distinctFrom };
        }
        if (result.kind === "already-on-file") {
          return { player: result.player.canonicalName, created: false, distinctFrom: [] };
        }
        throw new McpToolError(
          result.kind === "empty-name"
            ? "a player name cannot be blank"
            : result.kind === "not-ambiguous"
              ? `"${target}" is not ambiguous — it matches no player on file and is near none, so nothing refused it. Check the spelling against the reported name, or use the player_pull tool to create it.`
              : `"${target}" is already on file more than once (${result.candidates.join(", ")}) — those rows need merging, which this tool cannot do`,
        );
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "player_alias",
    cliCommand: "player alias",
    description: "Record a second spelling as the same person as a known player",
    inputShape: { target: z.string().min(1), alias: z.string().min(1) },
    handler: async (rawArgs) => {
      const { target, alias } = rawArgs as { target: string; alias: string };
      const { db, sqlite } = openDb();
      try {
        const result = recordPlayerAlias(db, { knownTarget: target, alias });
        if (result.kind === "recorded" || result.kind === "already-recorded") {
          return {
            player: result.player.canonicalName,
            alias: result.alias,
            recorded: result.kind === "recorded",
          };
        }
        throw new McpToolError(
          result.kind === "empty-alias"
            ? "an alias cannot be blank"
            : result.kind === "unknown-target"
              ? `unknown target "${target}"`
              : result.kind === "ambiguous-target"
                ? ambiguousMessage(result)
                : `"${alias}" already belongs to ${result.holder.canonicalName} — recording it here would leave the name resolving to two players, permanently`,
        );
      } finally {
        sqlite.close();
      }
    },
  },

  {
    name: "report_build",
    cliCommand: "report build",
    description: "Render per-opponent scouting dossiers (HTML + markdown) to disk",
    inputShape: {
      target: z.string().optional(),
      // #63: applies to EVERY dossier this call builds — a bad name propagates as its own error
      // class, converted to a structured result by the SDK like any other thrown error.
      event: z.string().optional(),
    },
    handler: async (rawArgs) => {
      const { target, event } = rawArgs as { target?: string; event?: string };
      const { db, sqlite } = openDb();
      try {
        // Issue #90: the same anchor resolution as `tn report build`, from the same helpers. Three
        // of this issue's six call sites are in this file, and a binder that disagreed with the
        // agent chat about which season it covered would have nothing to surface the difference.
        const anchor = resolveSeasonAnchor(db, event);
        const season = seasonWindow(anchor.value);
        let written: string[];
        let teamsCount: number;
        if (target === undefined || target === "sectionals") {
          written = writeSectionalsDossiers(db, { season, eventName: event });
          teamsCount = countTeams(db);
        } else {
          const resolution = requireResolved(resolveTeamTarget(db, target), "target", target);
          written = writeTeamDossier(db, resolution.teamId, { season, eventName: event });
          teamsCount = 1;
        }
        // `season` and `anchoredTo` are returned for the same reason `tn report build` prints them
        // (issue #90): an event with no `starts_on` falls back to the clock, and a caller that
        // cannot tell that from a real event anchor has no way to know its binder covers a
        // different season than it asked for. Omitting them here left the CLI honest and this
        // surface silent — the drift this issue's own parity test was meant to prevent, one field
        // over. (Codex adversarial review of PR #91, Finding 1 [high].)
        return {
          target: target ?? "sectionals",
          teams: teamsCount,
          files: written.length,
          root: resolvedReportsRoot(),
          season: season.year,
          anchoredTo: anchor.anchoredTo,
        };
      } finally {
        sqlite.close();
      }
    },
  },
];
