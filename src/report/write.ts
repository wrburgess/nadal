// Assembly + filesystem writer for the dossier renderers (Task 8). Fetches a team's roster and
// every roster member's full profile, hands the result to `html.ts`/`markdown.ts`, and writes both
// forms to disk — every write funneled through Task 1's hardened `src/fs/output-root.ts` guard, the
// SAME code `src/ingest/archive.ts` uses for `raw/`, with `"reports"` as the permitted in-repo
// directory. Reports carry real people's names, ages, ratings and match histories in a PUBLIC repo
// (`.gitignore` covers `reports/` for exactly this reason) — a misconfigured `TN_REPORTS_PATH=src`
// must be refused by the same control that refuses `TN_RAW_PATH=src`, never a second hand-rolled
// check.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertOutputPathSafe } from "../fs/output-root.js";
import type { Db } from "../ingest/db-types.js";
import { getPlayerProfile } from "../query/player-profile.js";
import { getTeamProfile } from "../query/team-profile.js";
import { teams } from "../db/schema.js";
import { renderDossier, escapeHtml } from "./html.js";
import { renderDossierMarkdown } from "./markdown.js";
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
 */
function resolveTeamDirNames(entries: { teamId: number; teamName: string }[]): Map<number, string> {
  const used = new Set<string>();
  const dirNames = new Map<number, string>();
  for (const e of entries) {
    let slug = teamSlug(e.teamId, e.teamName);
    if (used.has(slug)) slug = `${slug}-${e.teamId}`;
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
 * between two teams in the same run is caught at the batch level; a standalone single-team call (no
 * sibling teams to collide with) computes its own from `teamSlug` directly. */
export function writeTeamDossier(
  db: Db,
  teamId: number,
  options: { since: string },
  dirName?: string,
): string[] {
  const dossier = buildTeamDossier(db, teamId, options);
  const dir = join(reportsRoot(), dirName ?? teamSlug(teamId, dossier.team.teamName));
  const htmlPath = join(dir, "index.html");
  const mdPath = join(dir, "index.md");

  assertReportPathSafe(htmlPath);
  assertReportPathSafe(mdPath);

  mkdirSync(dir, { recursive: true });
  writeFileSync(htmlPath, renderDossier(dossier), "utf8");
  writeFileSync(mdPath, renderDossierMarkdown(dossier), "utf8");

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
  const items = entries.map((e) => `- [${e.teamName}](${e.dirName}/index.md)`).join("\n");
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
  writeFileSync(indexHtmlPath, renderIndexHtml(entries), "utf8");
  writeFileSync(indexMdPath, renderIndexMarkdown(entries), "utf8");
  written.push(indexHtmlPath, indexMdPath);

  return written;
}
