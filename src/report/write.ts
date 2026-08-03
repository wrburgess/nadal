// Assembly + filesystem writer for the dossier renderers (Task 8). Fetches a team's roster and
// every roster member's full profile, hands the result to `html.ts`/`markdown.ts`, and writes both
// forms to disk — every write funneled through Task 1's hardened `src/fs/output-root.ts` guard, the
// SAME code `src/ingest/archive.ts` uses for `raw/`, with `"reports"` as the permitted in-repo
// directory. Reports carry real people's names, ages, ratings and match histories in a PUBLIC repo
// (`.gitignore` covers `reports/` for exactly this reason) — a misconfigured `TN_REPORTS_PATH=src`
// must be refused by the same control that refuses `TN_RAW_PATH=src`, never a second hand-rolled
// check.

import { asc } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assertLeafWritable,
  assertOutputPathSafe,
  overwriteOutputFile,
  resolveRealOutputPath,
} from "../fs/output-root.js";
import type { Db } from "../ingest/db-types.js";
import { resolveHomeTeam } from "../query/home-team.js";
import { NoCourtMatchHistoryError, getLineupPlan, resolveEventFormat } from "../query/lineup.js";
import type { SeasonWindow } from "../cli/window.js";
import type { ResolvedEventFormat } from "../query/lineup.js";
import { getPlayerProfile } from "../query/player-profile.js";
import { getTeamProfile } from "../query/team-profile.js";
import { teams } from "../db/schema.js";
import { renderDossier, escapeHtml } from "./html.js";
import { escapeMarkdownCell, renderDossierMarkdown } from "./markdown.js";
import type { TeamDossier } from "./types.js";

const DEFAULT_REPORTS_DIR = "reports";

/** Mirrors `dbPath()`/`rawRoot()`: an explicit env var when set, a repo-relative default otherwise
 * — no new flag, no grammar change (Task 8's constraint), exactly like `TN_DB_PATH`/`TN_RAW_PATH`. */
export function reportsRoot(): string {
  return process.env.TN_REPORTS_PATH ?? DEFAULT_REPORTS_DIR;
}

function assertReportPathSafe(candidatePath: string, root: string = reportsRoot()): void {
  assertOutputPathSafe(candidatePath, root, DEFAULT_REPORTS_DIR);
}

/** The reports root as an absolute path — what the CLI's `root=` summary field reports, so a caller
 * knows exactly where the binder landed regardless of what directory `tn` was invoked from. */
export function resolvedReportsRoot(): string {
  return resolve(reportsRoot());
}

/** The number of teams currently on file — what the CLI's `teams=` summary field reports for a
 * `sectionals` build. A single-team `report build <team>` never needs this: it always writes
 * exactly one team's dossier by definition. */
export function countTeams(db: Db): number {
  return db.select().from(teams).all().length;
}

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
  options: { season: SeasonWindow; event?: ResolvedEventFormat },
): TeamDossier {
  const homeTeam = resolveHomeTeam(db);
  const versusTeamId = homeTeam !== null && homeTeam.id !== teamId ? homeTeam.id : undefined;
  const team = getTeamProfile(db, teamId, { since: options.season.since, versusTeamId });
  const players = team.roster.map((member) => getPlayerProfile(db, member.playerId, { since: options.season.since }));

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

  return { season: options.season.label, team, players, lineup };
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
  options: { season: SeasonWindow; event?: ResolvedEventFormat },
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
export function writeTeamDossier(
  db: Db,
  teamId: number,
  options: { season: SeasonWindow; eventName?: string },
  dirName?: string,
): string[] {
  // Resolved once, before anything is prepared — the same shape as the batch path below, so both
  // entry points refuse a bad event name before touching the filesystem rather than partway through.
  const event = options.eventName === undefined ? undefined : resolveEventFormat(db, options.eventName);
  return commitDossierWrite(prepareTeamDossierWrite(db, teamId, { season: options.season, event }, dirName));
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
 * one dossier per team present in the DB, plus a top-level `index.html`/`index.md` linking each.
 * "Every team in the DB" is the only available reading of "the field". The reason is narrower than
 * it used to be: #17 PR B added `addEvent`, so `events` rows DO now exist — but nothing associates a
 * TEAM with an event (`team_memberships.event_id` and `team_matches.event_id` are null on every real
 * pull, docs/findings.md #15), so there is still no way to ask "which teams are in this event". The
 * missing piece is the association, not the events table. Scoping this call to an event becomes
 * possible when that lands (TennisLink, #27, is the likely source).
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
export function writeSectionalsDossiers(db: Db, options: { season: SeasonWindow; eventName?: string }): string[] {
  // PHASE 0 — resolve the named event's format exactly ONCE, before any team is read or any leaf is
  // validated. Every dossier in this batch then predicts across the SAME slot set, which is what
  // `docs/cli/GRAMMAR.md` promises; a per-team lookup could not keep that promise across a
  // concurrent `tn event add` (Codex adversarial review of PR #82, Finding 1 [high]). It also fails
  // fast in the same direction Phase 1 below already does: an unknown event, or one with no format,
  // refuses with nothing written — including on a team set that is empty or wholly without history,
  // where a per-team lookup would never have validated the name at all.
  const event = options.eventName === undefined ? undefined : resolveEventFormat(db, options.eventName);
  // Same load-bearing `ORDER BY teams.id` as `resolveDirNameForTeam` above, and for the identical
  // reason: this function's own collision-disambiguation only agrees with a later single-team
  // refresh's disambiguation if both see teams in the same order, and SQL does not grant that for
  // free (Codex adversarial review, PR #38 round 2, Finding 2 [high]).
  const allTeams = db.select().from(teams).orderBy(asc(teams.id)).all();
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
  const preparedTeams = allTeams.map((team) =>
    prepareTeamDossierWrite(db, team.id, { season: options.season, event }, dirNames.get(team.id)),
  );

  const entries: TeamIndexEntry[] = allTeams.map((t) => ({
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
  // top-level index names every team on file, so it deserves the identical protection, not a lesser
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

  return written;
}
