// Assembly + filesystem writer for the dossier renderers (Task 8). Fetches a team's roster and
// every roster member's full profile, hands the result to `html.ts`/`markdown.ts`, and writes both
// forms to disk — every write funneled through Task 1's hardened `src/fs/output-root.ts` guard, the
// SAME code `src/ingest/archive.ts` uses for `raw/`, with `"reports"` as the permitted in-repo
// directory. Reports carry real people's names, ages, ratings and match histories in a PUBLIC repo
// (`.gitignore` covers `reports/` for exactly this reason) — a misconfigured `TN_REPORTS_PATH=src`
// must be refused by the same control that refuses `TN_RAW_PATH=src`, never a second hand-rolled
// check.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * A team's directory name under the reports root. Team names are NOT filesystem-safe — the
 * fixtures themselves use names like `IA/Versteeg/40&Over3.5M` (`/` would otherwise be read as a
 * path separator, silently nesting directories no one asked for) — so the directory is the opaque,
 * always-safe `team-<id>` rather than a slugified name. `assertReportPathSafe` guards every path
 * regardless, but avoiding attacker-shaped path components in the first place is simpler than
 * relying on the guard alone to catch a `..`-laden team name.
 */
function teamDirName(teamId: number): string {
  return `team-${teamId}`;
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

/** Renders both forms and writes them under `<reportsRoot>/team-<id>/`, returning the paths written
 * (2: `index.html`, `index.md`) — every path checked with `assertReportPathSafe` BEFORE anything is
 * written, so a refusal leaves nothing on disk (same discipline as `archivePage`). */
export function writeTeamDossier(db: Db, teamId: number, options: { since: string }): string[] {
  const dossier = buildTeamDossier(db, teamId, options);
  const dir = join(reportsRoot(), teamDirName(teamId));
  const htmlPath = join(dir, "index.html");
  const mdPath = join(dir, "index.md");

  assertReportPathSafe(htmlPath);
  assertReportPathSafe(mdPath);

  mkdirSync(dir, { recursive: true });
  writeFileSync(htmlPath, renderDossier(dossier), "utf8");
  writeFileSync(mdPath, renderDossierMarkdown(dossier), "utf8");

  return [htmlPath, mdPath];
}

type TeamIndexEntry = { teamId: number; teamName: string };

function renderIndexHtml(entries: TeamIndexEntry[]): string {
  const items = entries
    .map((e) => `<li><a href="${teamDirName(e.teamId)}/index.html">${escapeHtml(e.teamName)}</a></li>`)
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
  const items = entries.map((e) => `- [${e.teamName}](${teamDirName(e.teamId)}/index.md)`).join("\n");
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
  const written: string[] = [];
  for (const team of allTeams) {
    written.push(...writeTeamDossier(db, team.id, options));
  }

  const entries: TeamIndexEntry[] = allTeams.map((t) => ({ teamId: t.id, teamName: t.name }));
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
