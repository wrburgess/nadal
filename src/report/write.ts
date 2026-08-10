// Assembly + filesystem writer for the dossier renderers (Task 8). Fetches a team's roster and
// every roster member's full profile, hands the result to `html.ts`/`markdown.ts`, and writes both
// forms to disk — every write funneled through Task 1's hardened `src/fs/output-root.ts` guard, the
// SAME code `src/ingest/archive.ts` uses for `raw/`, with `"reports"` as the permitted in-repo
// directory. Reports carry real people's names, ages, ratings and match histories in a PUBLIC repo
// (`.gitignore` covers `reports/` for exactly this reason) — a misconfigured `TN_REPORTS_PATH=src`
// must be refused by the same control that refuses `TN_RAW_PATH=src`, never a second hand-rolled
// check.

import { asc, eq } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assertLeafWritable,
  assertOutputPathSafe,
  overwriteOutputFile,
  resolveRealOutputPath,
} from "../fs/output-root.js";
import { repoDefault } from "../fs/package-root.js";
import type { Db } from "../ingest/db-types.js";
import { getAvailabilityForEvent } from "../query/availability.js";
import { getCaptainNotes } from "../query/captain-notes.js";
import { resolveHomeTeam } from "../query/home-team.js";
import { NoCourtMatchHistoryError, getLineupPlan, requireSlotSet } from "../query/lineup.js";
import { type EvidenceWindow, windowSnapshot } from "../cli/window.js";
import type { ResolvedEvent } from "../query/lineup.js";
import { getPlayerProfile } from "../query/player-profile.js";
import { getTeamProfile } from "../query/team-profile.js";
import { teamMemberships, teams } from "../db/schema.js";
import { renderDossier, escapeHtml } from "./html.js";
import { escapeMarkdownCell, renderDossierMarkdown } from "./markdown.js";
import type { TeamDossier } from "./types.js";

const DEFAULT_REPORTS_DIR = "reports";

/** Mirrors `dbPath()`/`rawRoot()`: an explicit env var when set (used verbatim — a relative
 * `TN_REPORTS_PATH` stays cwd-relative, the documented escape hatch), a package-root-anchored
 * default otherwise (issue #111) — no new flag, no grammar change (Task 8's constraint), exactly
 * like `TN_DB_PATH`/`TN_RAW_PATH`. */
export function reportsRoot(): string {
  return repoDefault(process.env.TN_REPORTS_PATH, DEFAULT_REPORTS_DIR);
}

function assertReportPathSafe(candidatePath: string, root: string = reportsRoot()): void {
  assertOutputPathSafe(candidatePath, root, DEFAULT_REPORTS_DIR);
}

/** The reports root as an absolute path — what the CLI's `root=` summary field reports, so a caller
 * knows exactly where the binder landed regardless of what directory `tn` was invoked from. */
export function resolvedReportsRoot(): string {
  return resolve(reportsRoot());
}

// `countTeams(db)` used to live here, supplying the CLI's and MCP's `teams=` for a `sectionals`
// build. #124 removed it rather than leaving it exported and uncalled: it counted every team on
// file, which is the WRONG number the moment a batch is scoped to an event's field, and both doors
// now take the count out of `SectionalsBatch` — from the pass that actually wrote the dossiers.

/**
 * Lowercase, collapse every run of non-alphanumeric characters to a single `-`, then trim leading
 * and trailing `-`. This is the ONLY thing standing between a team name and a filesystem path
 * component — team names are NOT filesystem-safe (fixtures themselves use names like
 * `IA/Versteeg/40&Over3.5M`, where `/` would otherwise be read as a path separator, silently
 * nesting directories no one asked for) — so no character outside `[a-z0-9-]` can survive this
 * function by construction. In particular `.`, `..`, `/`, and `\` are all non-alphanumeric and are
 * therefore always collapsed away: a team literally named `../../etc/passwd` cannot produce a `..`
 * segment no matter what. `assertReportPathSafe` still guards every write as defense in depth, but
 * the slug generator itself is designed to make the escape impossible, not just caught.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A team's directory-safe name: the slugified team name, so a courtside binder is navigable by
 * opponent name rather than an opaque `team-<id>` — that WAS the always-safe fallback (see git
 * history), but it defeated the entire point of a binder: you cannot tell which opponent `team-1`
 * is without opening it. A name that is entirely punctuation (e.g. `"!!!"`) slugifies to the empty
 * string, which is not a usable directory name, so `teamSlug` falls back to the same opaque
 * `team-<id>` form in exactly that case — the fallback is now the exception, not the rule.
 * Collision-safety (two DISTINCT names slugifying to the SAME string) is handled by the caller
 * (`resolveTeamDirNames`), which has visibility across every team in one build; this function alone
 * cannot know about sibling teams.
 */
export function teamSlug(teamId: number, teamName: string): string {
  const slug = slugify(teamName);
  return slug === "" ? `team-${teamId}` : slug;
}

/**
 * Resolves one directory name per team, collision-safe across the whole batch: when two distinct
 * team names slugify to the same string, every team AFTER the first to claim that slug gets its id
 * appended, so neither dossier ever overwrites the other. Deterministic given a fixed input order
 * (callers pass teams in DB id order), not merely "safe" — the same DB produces the same directory
 * names every time, preserving `writeTeamDossier`'s byte-identical-reruns guarantee.
 *
 * The disambiguated candidate (`${slug}-${teamId}`) is itself re-checked in a LOOP rather than added
 * unconditionally after a single retry: it can ALSO already be taken by a third team. Example, in DB
 * id order: id 1 "X" -> slug "x"; id 2 "X 3" -> slug "x-3"; id 3 "X!" -> slug "x" collides -> retries
 * "x-3" -> collides AGAIN with team 2. A single check-and-append let that second collision through
 * silently (one dossier overwriting another) despite this function's own promise above. Each further
 * retry keeps appending the same team's own id (never another team's), so the candidate is still
 * fully determined by (this team's id, prior teams' names) — the loop only ever makes the string
 * longer and more specific, and with finitely many teams it is guaranteed to land on a free one.
 */
/**
 * The directory name `writeSectionalsDossiers` would assign a single team, computed with the SAME
 * whole-DB visibility the batch path has — every team currently in the DB, in DB id order — rather
 * than looking only at the one team being built. `writeTeamDossier`'s own `dirName` parameter used
 * to fall back to a bare `teamSlug(teamId, teamName)` when omitted, which only ever sees the ONE
 * team it was asked to build: two teams that slug identically ("Team A!!!" and "Team A???" both ->
 * "team-a") landed in the SAME directory whenever each was built individually via `tn report build
 * "<team>"` — the command `writeTeamDossier` without a `dirName` — even though `sectionals` had
 * already solved this exact collision for the batch case. A given team must land in the same
 * directory whether it was built alone or as part of `sectionals`, so a later single-team refresh
 * never produces a second directory for a team `sectionals` already placed (Codex adversarial
 * review, PR #38, Finding 2 [high]).
 *
 * `.orderBy(asc(teams.id))` below is load-bearing, not cosmetic: the whole disambiguation scheme in
 * `resolveTeamDirNames` is defined in terms of "DB id order", but SQL makes no guarantee about the
 * row order of a SELECT without an explicit ORDER BY — SQLite can and does invert it (see
 * `PRAGMA reverse_unordered_selects`, which exists specifically to catch code that assumes
 * otherwise). Without this, two different invocations (a batch `sectionals` run and a later
 * single-team refresh through this function, each its own connection/query plan) can observe
 * `teams.*` in different orders and therefore disambiguate the SAME collision in opposite
 * directions — one dossier silently overwriting the other, which is the exact bug this whole
 * function exists to prevent, one layer up (Codex adversarial review, PR #38 round 2, Finding 2
 * [high]; round 1 fixed the disambiguation LOOP but never pinned the ORDER the loop depends on).
 */
function resolveDirNameForTeam(db: Db, teamId: number): string {
  const allTeams = db.select().from(teams).orderBy(asc(teams.id)).all();
  const dirNames = resolveTeamDirNames(allTeams.map((t) => ({ teamId: t.id, teamName: t.name })));
  // `teamId` is guaranteed present: the caller (`writeTeamDossier`) only reaches this after
  // `buildTeamDossier` already fetched this exact team's profile without throwing, so it exists in
  // the same DB `allTeams` was just read from.
  return dirNames.get(teamId)!;
}

function resolveTeamDirNames(entries: { teamId: number; teamName: string }[]): Map<number, string> {
  const used = new Set<string>();
  const dirNames = new Map<number, string>();
  for (const e of entries) {
    let slug = teamSlug(e.teamId, e.teamName);
    if (used.has(slug)) {
      let candidate = `${slug}-${e.teamId}`;
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = `${slug}-${e.teamId}-${suffix}`;
        suffix += 1;
      }
      slug = candidate;
    }
    used.add(slug);
    dirNames.set(e.teamId, slug);
  }
  return dirNames;
}

/**
 * Assemble one team's dossier: the team profile plus a FULL `PlayerProfile` for every roster
 * member, in the same order as `team.roster` (src/report/types.ts's ordering contract) — the
 * roster table and per-player blocks need ratings/partner data `RosterMemberProfile` does not carry
 * (see that type's doc comment in src/query/team-profile.ts).
 *
 * Task 5 (#17): the designated home team (nadal ADR 0001) is passed to `getTeamProfile` as
 * `versusTeamId`, finally populating spec § Deliverables #1's "prior meetings vs our players" —
 * except when `teamId` itself IS the home team, since a team's dossier comparing itself against
 * itself is not a meaningful "prior meetings" section (and would just report every match as a
 * self-versus-self meeting). With no home team designated at all, `versusTeamId` stays `undefined`
 * and `getTeamProfile` keeps its existing "not available" `headToHead: null` path — already tested
 * in src/query/team-profile.ts's own suite, unchanged by this.
 */
export function buildTeamDossier(
  db: Db,
  teamId: number,
  options: { window: EvidenceWindow; event?: ResolvedEvent },
): TeamDossier {
  // ONE read of the caller's window, validated, before anything derives from it: a structural
  // `EvidenceWindow` can carry an accessor that answers differently on each read, which would filter
  // the team and its players to one window and label the page with another.
  const window = windowSnapshot(options.window);
  const homeTeam = resolveHomeTeam(db);
  const versusTeamId = homeTeam !== null && homeTeam.id !== teamId ? homeTeam.id : undefined;
  // #97: taken from the ALREADY-RESOLVED event, exactly like the slot set below and for the same
  // reason — the batch entry points resolve one row once, so every dossier in a run is scoped by the
  // same stored value even if `tn event add` commits mid-build from the neighbouring process.
  // `undefined` when no event was named, which `getTeamProfile`/`getPlayerProfile` report as "no
  // scope applied" rather than treating as an absent field.
  const leagueScope = options.event?.leagueScope ?? null;
  // #113: the SAME already-resolved event's id scopes the roster — never a second lookup, for the
  // identical reason `leagueScope` above is taken from it rather than re-read.
  const eventId = options.event?.event.id ?? null;
  // #122 round-1 Finding 1: `window` (a `WindowSnapshot`) is passed straight through as the
  // profiles' `evidenceWindow` disclosure — it already IS the one validated read this function
  // performed above, so there is nothing to re-derive.
  // `homeTeamId` is the SAME read performed at the top of this function — never a second one. This
  // assembly derives three separate things from "who is the home team" (`versusTeamId`, `isHome`,
  // and `ownTeam` below), and until #134's review they did not all come from one read: a
  // `tn team home` from the neighbouring process (nadal runs `tn mcp serve` beside the CLI against
  // one WAL database) landing mid-assembly produced a dossier that carried an Own-team book AND
  // printed "no home team configured" — the #19 defect, reintroduced through the back door.
  // `homeTeam?.id ?? null` distinguishes "no home team" (null, an answer) from "not supplied"
  // (undefined, which would re-read).
  const team = getTeamProfile(db, teamId, {
    window,
    versusTeamId,
    leagueScope,
    eventId,
    homeTeamId: homeTeam?.id ?? null,
  });
  const players = team.roster.map((member) => getPlayerProfile(db, member.playerId, { window, leagueScope }));

  // #17 PR B: spec § Deliverables #1 puts the predicted lineup in the dossier, not only behind the
  // `tn lineup plan` command. "No history to predict from" is a normal state for a team that has
  // been created but not yet pulled, so it is caught and rendered as an explicit absence rather
  // than being allowed to fail the whole dossier build — a `report build` over five teams must not
  // die because one of them has no matches yet. Any OTHER error still propagates: a genuine bug in
  // the heuristic should surface, not be swallowed into a missing section.
  //
  // #63: `options.event` is an ALREADY-RESOLVED format, never a name. The named event applies to
  // EVERY dossier a `report build` run writes, and this function is called once per team — so
  // resolving here would re-read `events.format` per team and let a concurrent `tn event add`
  // (nadal runs `tn mcp serve` beside the CLI against one WAL database) split a single batch across
  // two format versions. The batch entry points below resolve exactly once and hand the same value
  // to every team (Codex adversarial review of PR #82, Finding 1 [high]).
  let lineup: TeamDossier["lineup"] = null;
  try {
    lineup = getLineupPlan(db, teamId, options.event);
  } catch (err) {
    if (!(err instanceof NoCourtMatchHistoryError)) throw err;
  }

  // #126, spec § Deliverables #2: the own-team book rides on the HOME dossier only. `homeTeam` and
  // `eventId` are both the values resolved at the top of this function — never a second read, the
  // defect class #97 and #125 each closed once.
  //
  // The condition is `homeTeam?.id === teamId`, the exact complement of the `versusTeamId` line
  // above: a dossier is either about us or about an opponent, and those two fields must never both
  // be set. When no home team is designated at all, `resolveHomeTeam` returns null and every dossier
  // in the run — correctly — carries no book.
  const ownTeam: TeamDossier["ownTeam"] =
    homeTeam !== null && homeTeam.id === teamId
      ? {
          // `null`, not an empty grid, when no event was named: availability is per-event-day, so
          // there is no day range to render and the renderers say so rather than implying nobody is
          // available. See `OwnTeamBook.availability`.
          // `team.roster` — the roster this dossier is ABOUT (registered when an event was named,
          // season otherwise), never a fresh membership query. See `getAvailabilityForEvent`: a
          // second derivation here made the grid list 13 while the roster table said 11.
          availability:
            eventId === null
              ? null
              : getAvailabilityForEvent(db, {
                  eventId,
                  roster: team.roster.map((m) => ({ playerId: m.playerId, canonicalName: m.canonicalName })),
                }),
          notes: getCaptainNotes(db, { teamId }),
        }
      : null;

  return {
    window: window.label,
    // Taken from the same resolved value `leagueScope` came from, so the event a dossier names
    // beside its evidence scope is provably the event that scope was read from.
    event: options.event === undefined ? null : { id: options.event.event.id, name: options.event.event.name },
    // #113: copied from `team.rosterSource`, never re-derived — see `TeamDossier`'s own doc comment.
    rosterSource: team.rosterSource,
    team,
    players,
    lineup,
    ownTeam,
  };
}

/** Everything `writeTeamDossier` needs to know BEFORE it writes a single byte: the two real,
 * validated leaf paths and their already-rendered content. Splitting "figure out whether this team
 * CAN be written" from "write it" is what lets `writeSectionalsDossiers` below validate every team
 * in the batch — plus the top-level index pair — before committing any of them to disk (Codex
 * adversarial review, PR #38 round 2, Finding 3 [medium]). */
type PreparedDossierWrite = {
  htmlPath: string;
  mdPath: string;
  realHtmlPath: string;
  realMdPath: string;
  htmlContent: string;
  mdContent: string;
  /** Carried out of the render (#113) so a caller reporting which roster was used reads the value
   * this dossier was actually built from, rather than asking the database again after the write. */
  rosterSource: "registered" | "season";
};

/** Assembles one team's dossier and validates both of its leaves — `assertReportPathSafe`,
 * `mkdirSync`, `resolveRealOutputPath`, `assertLeafWritable` — WITHOUT writing anything yet. Content
 * is rendered here too (not deferred to the commit step) so a rendering failure is caught at the
 * same "nothing written yet" point as a path-safety failure, rather than after some other team in
 * the batch has already committed.
 *
 * `dirName`, when given, is a pre-resolved (and, for a batch, collision-disambiguated) directory
 * name from `resolveTeamDirNames` — `writeSectionalsDossiers` passes one so a `team-a` collision
 * between two teams in the same run is caught at the batch level. A standalone single-team call
 * (`writeTeamDossier`, which never passes `dirName`) resolves its own via `resolveDirNameForTeam` —
 * the SAME whole-DB, collision-disambiguated resolution `sectionals` would have produced for this
 * team — rather than a bare `teamSlug` that only sees the one team being built and would happily
 * place it in a slug another team already claims (Finding 2 above).
 *
 * Deliberately does NOT call `mkdirSync` — prepare only VALIDATES and RESOLVES paths, it never
 * mutates the filesystem (Codex adversarial review, PR #38 round 3, Finding 3 [medium]). The
 * previous version created `dir` here, so a LATER team's (or the top-level index's) refusal during
 * this same batch's validation pass left an already-created, empty directory behind for every team
 * prepared before the one that refused — round 2 only ever fixed the two FILES inside that directory
 * from being written, never the directory's own creation. `resolveRealOutputPath` below does not
 * need `dir` to exist to do its job: `realpathOfNearestExisting` (see its doc comment in
 * `src/fs/output-root.ts`) walks up to the nearest EXISTING ancestor and re-appends the missing
 * trailing components unresolved — exactly the state a brand-new team's directory is in before its
 * first write — so validation is complete without creating anything. `commitDossierWrite` below is
 * the one and only place `mkdirSync` runs for a team dossier now, immediately before the leaves it
 * guards are written. */
function prepareTeamDossierWrite(
  db: Db,
  teamId: number,
  options: { window: EvidenceWindow; event?: ResolvedEvent },
  dirName?: string,
): PreparedDossierWrite {
  const dossier = buildTeamDossier(db, teamId, options);
  const dir = join(reportsRoot(), dirName ?? resolveDirNameForTeam(db, teamId));
  const htmlPath = join(dir, "index.html");
  const mdPath = join(dir, "index.md");

  assertReportPathSafe(htmlPath);
  assertReportPathSafe(mdPath);

  const realHtmlPath = resolveRealOutputPath(reportsRoot(), htmlPath, DEFAULT_REPORTS_DIR);
  const realMdPath = resolveRealOutputPath(reportsRoot(), mdPath, DEFAULT_REPORTS_DIR);
  assertLeafWritable(realHtmlPath);
  assertLeafWritable(realMdPath);

  return {
    htmlPath,
    mdPath,
    realHtmlPath,
    realMdPath,
    htmlContent: renderDossier(dossier),
    mdContent: renderDossierMarkdown(dossier),
    rosterSource: dossier.rosterSource,
  };
}

/** Writes a `PreparedDossierWrite`'s two leaves — the only place `overwriteOutputFile` is called
 * for a team dossier, and (since Finding 3 above moved directory creation out of prepare) the only
 * place `mkdirSync` runs for one either. Both leaves share one directory, so `dirname(realHtmlPath)`
 * is created once (`{ recursive: true }`, so a second team landing in an already-existing sibling
 * directory is a silent no-op, same as before) rather than repeating the derivation for
 * `realMdPath`. By the time this runs, `prepareTeamDossierWrite` has already confirmed both leaves
 * are writable, so `overwriteOutputFile` (not a bare `writeFileSync`) is not expected to throw here —
 * it stays in place anyway so the no-follow-a-symlink discipline holds even against a leaf that
 * changed on disk between prepare and commit. */
function commitDossierWrite(prepared: PreparedDossierWrite): string[] {
  mkdirSync(dirname(prepared.realHtmlPath), { recursive: true });
  overwriteOutputFile(prepared.realHtmlPath, prepared.htmlContent);
  overwriteOutputFile(prepared.realMdPath, prepared.mdContent);
  return [prepared.htmlPath, prepared.mdPath];
}

/** Renders both forms and writes them under `<reportsRoot>/<team-slug>/`, returning the paths
 * written (2: `index.html`, `index.md`).
 *
 * The PRECISE guarantee, stated without overclaiming (Codex adversarial review, PR #38 round 3,
 * Finding 2 [high] — a prior version of this comment claimed "a refusal leaves nothing on disk"
 * unconditionally, which the code has never actually delivered end to end): every leaf this call
 * will touch — both `index.html` and `index.md` — is checked with `assertReportPathSafe` and
 * `assertLeafWritable` (inside `prepareTeamDossierWrite`) BEFORE either is written, so a VALIDATION
 * refusal (a bad root, a `..` escape, a symlinked leaf, a git-tracked destination) leaves nothing on
 * disk — no file, and (since `prepareTeamDossierWrite` does not itself call `mkdirSync` either) no
 * directory. `commitDossierWrite` is the one place that creates the team's directory and writes both
 * leaves, each leaf via `overwriteOutputFile`'s atomic temp-file-then-rename (see that function's own
 * doc comment in `src/fs/output-root.ts`), so each INDIVIDUAL leaf is either fully replaced or left
 * exactly as it was — never partially written, never briefly missing. What that does NOT cover: a
 * COMMIT-TIME failure (disk full, permissions revoked mid-run) between writing `index.html` and
 * `index.md` can still leave one leaf updated and the other not, because updating two files is
 * inherently two separate atomic operations, not one. Reports are cheaply regenerable from the DB by
 * design, so that narrower, honest guarantee is the one this module is built to provide — full
 * cross-file transactional atomicity is not.
 *
 * Reports carry the same personal data as raw archive captures and land in the same public repo, so
 * the write is held to `archivePage`'s standard, not just its pre-check: the path is re-validated and
 * resolved to its REAL location via `resolveRealOutputPath` (which tolerates the directory not
 * existing yet — see that function's own doc comment), and the leaf is written with
 * `overwriteOutputFile` — which refuses to follow an existing symlink at `index.html`/`index.md`
 * rather than writing through it. Unlike `archivePage`'s never-rewritten, timestamped filenames, a
 * dossier IS rewritten in place on every run (byte-identical reruns are a tested guarantee), so the
 * leaf write can't be a bare `flag: "wx"` — `overwriteOutputFile` tolerates and replaces a plain file
 * left by a prior run while still refusing a symlink.
 *
 * BOTH leaves are checked with `assertLeafWritable` before EITHER is written (inside
 * `prepareTeamDossierWrite`, run before `commitDossierWrite`), so a symlink at `index.md` refuses
 * before `index.html` ever touches disk: an earlier version of this function only discovered a
 * symlinked leaf inside `overwriteOutputFile`, AT WRITE TIME, so the html write could already have
 * landed before the md write's symlink check threw, leaving a fresh partial dossier behind (Codex
 * adversarial review, PR #38, Finding 3 [medium]). That validation-time guarantee holds for a single
 * `writeTeamDossier` call; it does NOT by itself extend across a whole batch of teams — see
 * `writeSectionalsDossiers` below, which is why `prepareTeamDossierWrite`/`commitDossierWrite` are
 * split out as their own functions rather than inlined here. */
/**
 * The roster source of the dossier this call actually wrote, returned alongside the paths rather
 * than re-derived by the caller (#113). `tn report build`'s summary line reports it, and an earlier
 * revision read it back from the database after the write had already landed — a check-then-act
 * window a concurrent `tn roster set` could land inside, so the summary could say
 * `roster=registered` about files that say season roster. Returning the value the render actually
 * used closes it by construction: there is nothing to re-read and therefore nothing to disagree
 * with. (Codex adversarial review of PR #121, round 1, finding 3 [medium].)
 *
 * `writeSectionalsDossiers` below deliberately does NOT carry this field. A batch mixes registered
 * and season teams, so one scalar cannot describe it without lying about some of them — the same
 * reason the CLI only emits `roster=` on the single-team path.
 */
export type TeamDossierWriteResult = {
  /** The paths written (2: `index.html`, `index.md`). */
  files: string[];
  rosterSource: "registered" | "season";
};

export function writeTeamDossier(
  db: Db,
  teamId: number,
  options: { window: EvidenceWindow; event?: ResolvedEvent },
  dirName?: string,
): TeamDossierWriteResult {
  // #122 round-1 Finding 3: `options.event`, when given, is ALREADY resolved by the caller (the
  // command's own single `resolveEvent` call, shared with the window anchor derived from it) — this
  // function never resolves a name itself. `requireSlotSet` still runs here, on the PASSED value, at
  // the same point in the sequence `resolveEventFormat` used to throw from — before any dossier is
  // prepared, and therefore with nothing written — so a named event with no format still refuses at
  // the same moment it always has.
  if (options.event !== undefined) requireSlotSet(options.event);
  const prepared = prepareTeamDossierWrite(db, teamId, { window: options.window, event: options.event }, dirName);
  return { files: commitDossierWrite(prepared), rosterSource: prepared.rosterSource };
}

type TeamIndexEntry = { teamId: number; teamName: string; dirName: string };

function renderIndexHtml(entries: TeamIndexEntry[]): string {
  const items = entries
    .map((e) => `<li><a href="${e.dirName}/index.html">${escapeHtml(e.teamName)}</a></li>`)
    .join("");
  const body = entries.length === 0 ? "<p>No teams on file yet.</p>" : `<ul>${items}</ul>`;
  return (
    "<!doctype html>" +
    '<html lang="en"><head><meta charset="utf-8"><title>Sectionals dossiers</title></head>' +
    `<body><h1>Sectionals dossiers <span>v0 layout</span></h1>${body}</body></html>`
  );
}

function renderIndexMarkdown(entries: TeamIndexEntry[]): string {
  if (entries.length === 0) return "# Sectionals dossiers _(v0 layout)_\n\nNo teams on file yet.\n";
  // `e.teamName` is attacker-influenced (scraped) same as everywhere else a name is interpolated in
  // this codebase — `escapeMarkdownCell` (markdown.ts) is the ONE escaping helper for that, reused
  // here rather than duplicated, exactly as `renderIndexHtml` above reuses `escapeHtml` for the same
  // field. Unescaped, a name containing `]` closes the link label early (turning the rest of the name
  // into a live URL) and a name containing raw HTML survives into the `.md` file, which CommonMark
  // renders verbatim.
  const items = entries
    .map((e) => `- [${escapeMarkdownCell(e.teamName)}](${e.dirName}/index.md)`)
    .join("\n");
  return `# Sectionals dossiers _(v0 layout)_\n\n${items}\n`;
}

/**
 * `sectionals` (and bare, no target — spec: "Bare (no target) is equivalent to `sectionals`"):
 * one dossier per team in the event's FIELD, plus a top-level `index.html`/`index.md` linking each.
 *
 * #124 replaced "every team in the DB" as the reading of "the field". This comment previously argued
 * that scoping was impossible until a team-level link landed, on the grounds that `tn roster set`
 * (#113) associates individual PLAYERS with an event and never a TEAM. Two of the three objections it
 * raised are answered rather than waived:
 *
 *   - *"a team with players registered for event A says nothing about event B"* — answered by
 *     binding the derivation to `event.event.id`, so a registration for another event is not read as
 *     evidence about this one (pinned by "ignores registrations belonging to a different event").
 *   - *"answering which teams are in this event needs a link the schema does not have"* — the link is
 *     derived, not stored: for the events nadal actually builds binders for, a team with a player
 *     registered IS in the field, and that is a fact `tn roster set` already records.
 *
 * The third objection stands and is NOT solved here: *a team with zero registered players is not
 * thereby excluded* — it may simply not have registered anyone yet, and nothing in this schema tells
 * the two apart. That is why the scope engages only when the event has at least one registration at
 * all, falls back to every team on file when it has none, and REPORTS which of the two readings it
 * used (`SectionalsFieldSource`) instead of leaving a caller to infer it from a count. A partially
 * registered event will therefore under-report its field, and the honest signal for that is the
 * per-team `Roster:` line, not this count.
 *
 * (`team_matches.event_id` is still null on every real `tn team pull`, docs/findings.md #15 — a
 * TennisLink-sourced field, #27, would supply the stored association this derives.)
 *
 * The PRECISE guarantee this batch call makes, stated without overclaiming (Codex adversarial
 * review, PR #38 round 3, Finding 2 [high]): every leaf in the WHOLE batch — every team's html+md
 * pair, plus the top-level index pair — is validated (`assertReportPathSafe`, `assertLeafWritable`)
 * before ANY of them is written, and neither phase creates a directory (see Finding 3 [medium] below)
 * — so a VALIDATION refusal anywhere leaves nothing on disk at all, no files and no directories, for
 * the entire batch. Each individual leaf is then replaced ATOMICALLY (temp-file-then-rename — see
 * `overwriteOutputFile`'s doc comment in `src/fs/output-root.ts`), so no single file is ever observed
 * half-written. What this does NOT cover, and what no design built from independent per-file renames
 * can cover: a COMMIT-TIME failure (an I/O error — disk full, permissions revoked — partway through
 * the loop below) can still leave a PARTIALLY-updated batch, some teams' dossiers refreshed and
 * others not. Reports are cheaply regenerable from the DB by design (re-run the build), so that
 * narrower guarantee — validate-before-any-write, atomic-per-leaf, no cross-file transaction — is
 * what this module actually provides, not a stronger one this comment used to imply.
 */
/**
 * Which reading of "the field" a `sectionals` batch actually used (#124). `registered` means the
 * named event had at least one team with a player registered for it and the batch rendered exactly
 * those teams; `all-teams` means every team on file was rendered — either because no event was named,
 * or because the named event has no registrations yet. The two are indistinguishable from a team
 * count alone, which is why the batch reports this rather than leaving a caller to guess.
 */
export type SectionalsFieldSource = "registered" | "all-teams";

/** What a `sectionals` batch wrote, and on what reading of "the field" — returned together, from the
 * ONE pass that wrote them, so a caller's summary can never disagree with what landed on disk. The
 * count deliberately does NOT come from a second `countTeams(db)` read: once the field is scoped,
 * that read reports every team on file while the batch wrote only the field, and a concurrent write
 * between the two could make them disagree even when it is not (the same one-read discipline
 * `writeTeamDossier` already follows for its `rosterSource`). */
export type SectionalsBatch = {
  readonly files: string[];
  readonly teamCount: number;
  readonly fieldSource: SectionalsFieldSource;
};

export function writeSectionalsDossiers(
  db: Db,
  options: { window: EvidenceWindow; event?: ResolvedEvent },
): SectionalsBatch {
  // PHASE 0 (#122 round-1 Finding 3) — `options.event`, when given, was ALREADY resolved once by the
  // caller — the command's own single `resolveEvent` call, the SAME resolution the window anchor
  // passed in `options.window` was derived from. This function used to resolve the name itself, a
  // SECOND, independent read of the `events` row from the one `resolveWindowAnchor` performed for the
  // window — so a concurrent `tn event add` between the two could hand one batch the OLD event's
  // window and the NEW event's format/scope/roster. Taking the resolved value as a parameter closes
  // that: every dossier in this batch predicts across the SAME slot set, draws from the SAME evidence
  // scope, resolves the SAME roster, AND is windowed against the SAME anchor — one read, four
  // consumers, not two reads that could each answer differently.
  //
  // `requireSlotSet` still runs here, on the PASSED value, at the same point in the sequence it
  // always has — before any team is read or any leaf is validated — so an event with no format still
  // refuses with nothing written, including on a team set that is empty or wholly without history.
  // The unknown-event refusal itself now lives with `resolveEvent`, at the command boundary that
  // performs the one read this function (and the window) both consume.
  if (options.event !== undefined) requireSlotSet(options.event);
  // Same load-bearing `ORDER BY teams.id` as `resolveDirNameForTeam` above, and for the identical
  // reason: this function's own collision-disambiguation only agrees with a later single-team
  // refresh's disambiguation if both see teams in the same order, and SQL does not grant that for
  // free (Codex adversarial review, PR #38 round 2, Finding 2 [high]).
  const allTeams = db.select().from(teams).orderBy(asc(teams.id)).all();
  // #124 — scope the batch to the event's FIELD when one is on record. `tn roster set` (#113)
  // registers PLAYERS against an event; a team with at least one such registration for THIS event is
  // in this event's field, which is the team-level link the doc comment above says the schema lacks.
  // It is derived rather than stored, and the derivation is deliberately narrow:
  //
  //   - bound to `event.event.id`, never `event_id IS NOT NULL` — a registration for event A says
  //     nothing about event B, which is the objection that kept this call unscoped until now;
  //   - read from the SAME resolved event the window/scope/roster come from, so this adds no second
  //     read of `events` for a concurrent `tn event add` to slip inside (#122 round-1 Finding 3).
  //
  // The residual this CANNOT resolve, stated rather than hidden: a team that is in the field but has
  // registered nobody is indistinguishable from a team that is not in the field. Both have zero rows.
  // That is why an event with NO registrations at all falls back to every team on file instead of
  // writing an empty binder — and why the reading used is REPORTED (`fieldSource`) rather than left
  // for a caller to infer from a count that looks identical either way.
  const registeredTeamIds =
    options.event === undefined
      ? new Set<number>()
      : new Set(
          db
            .selectDistinct({ teamId: teamMemberships.teamId })
            .from(teamMemberships)
            .where(eq(teamMemberships.eventId, options.event.event.id))
            .all()
            .map((r) => r.teamId),
        );
  const fieldSource: SectionalsFieldSource = registeredTeamIds.size === 0 ? "all-teams" : "registered";
  const fieldTeams = fieldSource === "registered" ? allTeams.filter((t) => registeredTeamIds.has(t.id)) : allTeams;
  // Dir names are still assigned across ALL teams, not just the field: a later single-team refresh of
  // a team OUTSIDE the field must land on the same directory this batch would have given it, and
  // `resolveTeamDirNames`' collision suffixes depend on which teams it is shown. Narrowing this input
  // to the field would make `team-a` mean one team in the batch and a different one on a refresh.
  const dirNames = resolveTeamDirNames(allTeams.map((t) => ({ teamId: t.id, teamName: t.name })));

  // PHASE 1 — validate every leaf this batch will touch, EVERY team's html+md pair plus the
  // top-level index pair, before writing ANY of them. Deliberately creates nothing on the
  // filesystem — see `prepareTeamDossierWrite`'s own doc comment (Finding 3 [medium]) for why
  // directory creation is deferred entirely to `commitDossierWrite`/Phase 2 below. A refusal here
  // (a symlinked leaf, an unsafe root, a git-tracked destination) therefore leaves the WHOLE batch
  // untouched: no team's directory or file, and no top-level index either. The old version of this
  // function called `writeTeamDossier` in a loop that WROTE each team as soon as that team's own two
  // leaves checked out — so a LATER team's symlinked leaf still left every EARLIER team's fresh
  // dossier sitting on disk, discovered only at write time, one team too late (Codex adversarial
  // review, PR #38 round 2, Finding 3 [medium]; round 1 fixed the html-then-md ordering WITHIN one
  // team but never widened the guarantee to the whole batch this function drives).
  const preparedTeams = fieldTeams.map((team) =>
    prepareTeamDossierWrite(db, team.id, { window: options.window, event: options.event }, dirNames.get(team.id)),
  );

  // `fieldTeams`, not `allTeams`: the top-level index is how a captain navigates the binder, so an
  // entry here for a team whose dossier this batch did not write is a dead link. (Caught by #124's
  // own "must not be linked from the index" assertion — scoping only the WRITE loop left every
  // out-of-field team still listed, pointing at a directory that does not exist.)
  const entries: TeamIndexEntry[] = fieldTeams.map((t) => ({
    teamId: t.id,
    teamName: t.name,
    dirName: dirNames.get(t.id)!,
  }));
  const indexHtmlPath = join(reportsRoot(), "index.html");
  const indexMdPath = join(reportsRoot(), "index.md");
  assertReportPathSafe(indexHtmlPath);
  assertReportPathSafe(indexMdPath);
  // No `mkdirSync` here — same Finding 3 fix as `prepareTeamDossierWrite` above, one layer up:
  // `resolveRealOutputPath` does not need `reportsRoot()` to already exist (it walks up to the
  // nearest existing ancestor), so validating the top-level pair never has to create anything. The
  // previous version's `mkdirSync(reportsRoot(), { recursive: true })` ran here, in the validation
  // pass, BEFORE the two `assertLeafWritable` calls below — so a symlinked top-level leaf refused
  // AFTER `reportsRoot()` had already been (re)created, leaving a fresh empty directory behind on a
  // machine where it did not previously exist (Codex adversarial review, PR #38 round 3, Finding 3
  // [medium]).
  const realIndexHtmlPath = resolveRealOutputPath(reportsRoot(), indexHtmlPath, DEFAULT_REPORTS_DIR);
  const realIndexMdPath = resolveRealOutputPath(reportsRoot(), indexMdPath, DEFAULT_REPORTS_DIR);
  // Same post-mkdir re-check + no-follow-leaf-overwrite discipline as `writeTeamDossier` above — the
  // top-level index names every team in the field, so it deserves the identical protection, not a lesser
  // one just because it lives one directory up.
  assertLeafWritable(realIndexHtmlPath);
  assertLeafWritable(realIndexMdPath);

  // PHASE 2 — every leaf in the batch (every team's pair, and the top-level pair) is now confirmed
  // writable. Only now does anything actually get written to disk (`commitDossierWrite` below is
  // also where each team's own directory is finally created), so a VALIDATION refusal anywhere
  // above this line leaves the ENTIRE batch — files AND directories — untouched, not just the one
  // team or the top-level pair that triggered it. A COMMIT-time failure (disk full, permissions
  // changed mid-batch) is a different case this loop cannot protect against once it has started —
  // see the doc comment on `overwriteOutputFile` in `src/fs/output-root.ts` for the precise boundary
  // between what is and is not guaranteed once writing begins.
  const written: string[] = [];
  for (const prepared of preparedTeams) {
    written.push(...commitDossierWrite(prepared));
  }
  mkdirSync(dirname(realIndexHtmlPath), { recursive: true });
  overwriteOutputFile(realIndexHtmlPath, renderIndexHtml(entries));
  overwriteOutputFile(realIndexMdPath, renderIndexMarkdown(entries));
  written.push(indexHtmlPath, indexMdPath);

  return { files: written, teamCount: fieldTeams.length, fieldSource };
}
