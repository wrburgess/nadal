// Assembly + filesystem writer for the dossier renderers (Task 8). Fetches a team's roster and
// every roster member's full profile, hands the result to `html.ts`/`markdown.ts`, and writes both
// forms to disk — every write funneled through Task 1's hardened `src/fs/output-root.ts` guard, the
// SAME code `src/ingest/archive.ts` uses for `raw/`, with `"reports"` as the permitted in-repo
// directory. Reports carry real people's names, ages, ratings and match histories in a PUBLIC repo
// (`.gitignore` covers `reports/` for exactly this reason) — a misconfigured `TN_REPORTS_PATH=src`
// must be refused by the same control that refuses `TN_RAW_PATH=src`, never a second hand-rolled
// check.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertLeafWritable,
  assertOutputPathSafe,
  overwriteOutputFile,
  resolveRealOutputPath,
} from "../fs/output-root.js";
import type { Db } from "../ingest/db-types.js";
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
 */
function resolveDirNameForTeam(db: Db, teamId: number): string {
  const allTeams = db.select().from(teams).all();
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
 */
export function buildTeamDossier(db: Db, teamId: number, options: { since: string }): TeamDossier {
  const team = getTeamProfile(db, teamId, { since: options.since });
  const players = team.roster.map((member) => getPlayerProfile(db, member.playerId, { since: options.since }));
  return { team, players };
}

/** Renders both forms and writes them under `<reportsRoot>/<team-slug>/`, returning the paths
 * written (2: `index.html`, `index.md`) — every path checked with `assertReportPathSafe` BEFORE
 * anything is written, so a refusal leaves nothing on disk (same discipline as `archivePage`).
 * `dirName`, when given, is a pre-resolved (and, for a batch, collision-disambiguated) directory
 * name from `resolveTeamDirNames` — `writeSectionalsDossiers` passes one so a `team-a` collision
 * between two teams in the same run is caught at the batch level. A standalone single-team call
 * (`tn report build "<team>"`, which never passes `dirName`) resolves its own via
 * `resolveDirNameForTeam` — the SAME whole-DB, collision-disambiguated resolution `sectionals` would
 * have produced for this team — rather than a bare `teamSlug` that only sees the one team being
 * built and would happily place it in a slug another team already claims (Finding 2 above).
 *
 * Reports carry the same personal data as raw archive captures and land in the same public repo, so
 * the write is held to `archivePage`'s standard, not just its pre-check: after `mkdirSync` (which
 * silently succeeds over an existing symlinked directory) the path is re-validated and resolved to
 * its REAL location via `resolveRealOutputPath`, and the leaf is written with `overwriteOutputFile`
 * — which refuses to follow an existing symlink at `index.html`/`index.md` rather than writing
 * through it. Unlike `archivePage`'s never-rewritten, timestamped filenames, a dossier IS rewritten
 * in place on every run (byte-identical reruns are a tested guarantee), so the leaf write can't be a
 * bare `flag: "wx"` — `overwriteOutputFile` tolerates and replaces a plain file left by a prior run
 * while still refusing a symlink.
 *
 * BOTH leaves are checked with `assertLeafWritable` before EITHER is written, so a symlink at
 * `index.md` refuses before `index.html` — written first, below — ever touches disk: the earlier
 * version of this function only discovered a symlinked leaf inside `overwriteOutputFile`, AT WRITE
 * TIME, so the html write could already have landed before the md write's symlink check threw,
 * leaving a fresh partial dossier behind despite this function's own "a refusal leaves nothing on
 * disk" promise above (Codex adversarial review, PR #38, Finding 3 [medium]). */
export function writeTeamDossier(
  db: Db,
  teamId: number,
  options: { since: string },
  dirName?: string,
): string[] {
  const dossier = buildTeamDossier(db, teamId, options);
  const dir = join(reportsRoot(), dirName ?? resolveDirNameForTeam(db, teamId));
  const htmlPath = join(dir, "index.html");
  const mdPath = join(dir, "index.md");

  assertReportPathSafe(htmlPath);
  assertReportPathSafe(mdPath);

  mkdirSync(dir, { recursive: true });
  const realHtmlPath = resolveRealOutputPath(reportsRoot(), htmlPath, DEFAULT_REPORTS_DIR);
  const realMdPath = resolveRealOutputPath(reportsRoot(), mdPath, DEFAULT_REPORTS_DIR);
  assertLeafWritable(realHtmlPath);
  assertLeafWritable(realMdPath);
  overwriteOutputFile(realHtmlPath, renderDossier(dossier));
  overwriteOutputFile(realMdPath, renderDossierMarkdown(dossier));

  return [htmlPath, mdPath];
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
 * `events` has no writer at all (docs/findings.md, #15), so "every team in the DB" is the only
 * available reading of "the field" — there is no `events` row to scope this to instead.
 */
export function writeSectionalsDossiers(db: Db, options: { since: string }): string[] {
  const allTeams = db.select().from(teams).all();
  const dirNames = resolveTeamDirNames(allTeams.map((t) => ({ teamId: t.id, teamName: t.name })));
  const written: string[] = [];
  for (const team of allTeams) {
    written.push(...writeTeamDossier(db, team.id, options, dirNames.get(team.id)));
  }

  const entries: TeamIndexEntry[] = allTeams.map((t) => ({
    teamId: t.id,
    teamName: t.name,
    dirName: dirNames.get(t.id)!,
  }));
  const indexHtmlPath = join(reportsRoot(), "index.html");
  const indexMdPath = join(reportsRoot(), "index.md");
  assertReportPathSafe(indexHtmlPath);
  assertReportPathSafe(indexMdPath);
  mkdirSync(reportsRoot(), { recursive: true });
  // Same post-mkdir re-check + no-follow-leaf-overwrite discipline as `writeTeamDossier` above — the
  // top-level index names every team on file, so it deserves the identical protection, not a lesser
  // one just because it lives one directory up. And the same BOTH-before-EITHER leaf validation as
  // `writeTeamDossier` (Finding 3): without it, a symlinked `index.md` would let `index.html` land on
  // disk first before the refusal ever surfaced.
  const realIndexHtmlPath = resolveRealOutputPath(reportsRoot(), indexHtmlPath, DEFAULT_REPORTS_DIR);
  const realIndexMdPath = resolveRealOutputPath(reportsRoot(), indexMdPath, DEFAULT_REPORTS_DIR);
  assertLeafWritable(realIndexHtmlPath);
  assertLeafWritable(realIndexMdPath);
  overwriteOutputFile(realIndexHtmlPath, renderIndexHtml(entries));
  overwriteOutputFile(realIndexMdPath, renderIndexMarkdown(entries));
  written.push(indexHtmlPath, indexMdPath);

  return written;
}
