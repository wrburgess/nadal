import { dbMigrate } from "./commands/db-migrate.js";
import { eventAdd } from "./commands/event-add.js";
import { lineupPlan } from "./commands/lineup-plan.js";
import { mcpServe } from "./commands/mcp-serve.js";
import { playerAvail } from "./commands/player-avail.js";
import { playerNote } from "./commands/player-note.js";
import { playerPull } from "./commands/player-pull.js";
import { playerShow } from "./commands/player-show.js";
import { reportBuild } from "./commands/report-build.js";
import { teamHome } from "./commands/team-home.js";
import { teamPull } from "./commands/team-pull.js";
import { teamShow } from "./commands/team-show.js";
import { logRequest } from "../telemetry/request-log.js";
import { sanitizeValue } from "../sanitize.js";

export type Command = {
  noun: string;
  verb: string;
  summary: string;
  run: (args: string[]) => Promise<number>;
};

export const COMMANDS: Command[] = [
  dbMigrate,
  teamPull,
  teamShow,
  teamHome,
  playerPull,
  playerShow,
  playerAvail,
  playerNote,
  eventAdd,
  lineupPlan,
  reportBuild,
  mcpServe,
];

export function helpText(): string {
  const lines = ["tn <noun> <verb> <target> [payload] [flags]", ""];
  // Padding only the verb (the old approach) misaligns every row whose NOUN differs in length —
  // "db migrate" and "player show" have different noun widths, so their summaries never lined up.
  // The command column has to be the padded `noun verb` PAIR, and its width has to come from the
  // registry rather than a magic number so it stays correct as commands are added (spec §
  // Interfaces: "help fits one screen" implies a readable, aligned one, not merely a short one).
  const commandColumnWidth = Math.max(...COMMANDS.map((c) => `${c.noun} ${c.verb}`.length));
  for (const c of COMMANDS) {
    const command = `${c.noun} ${c.verb}`.padEnd(commandColumnWidth);
    lines.push(`  tn ${command}  ${c.summary}`);
  }
  lines.push("", "Global flags: --quiet/-q  --json  --help");
  return lines.join("\n");
}

export async function dispatch(argv: string[]): Promise<number> {
  // Help detection is DELIMITER-AWARE: `--help` is honored only BEFORE the first bare `--`.
  //
  // This check runs before any command's parser, so when it looked at the whole of `argv` it
  // silently outranked the `--` end-of-flags delimiter that same PR had just added — `tn player
  // note Randy -- --help` printed help and exited 0 instead of recording the note, for exactly one
  // token, while the MCP `player_note` tool accepted the identical text. That is the same
  // lossless-escape failure the delimiter existed to close, and it left the two surfaces
  // disagreeing. Found by the independent reviewer in round 2 of #17 PR A, reviewing the round-1
  // fix — the "a round's fix introduces the next round's defect" shape docs/findings.md records.
  //
  // Everything before the delimiter is unchanged: `tn player note --help`, `tn --help`, and a
  // trailing `--help` with no delimiter present all still print help.
  const terminator = argv.indexOf("--");
  const beforeTerminator = terminator === -1 ? argv : argv.slice(0, terminator);
  if (argv.length === 0 || beforeTerminator.includes("--help")) {
    console.log(helpText());
    return 0;
  }
  const [noun, verb, ...rest] = argv;
  const cmd = COMMANDS.find((c) => c.noun === noun && c.verb === verb);
  if (!cmd) {
    // Echoed straight back from argv, so it is whatever the caller typed — and this write happens
    // BEFORE any command's formatter exists to sanitize it, which is precisely why it was the last
    // unguarded terminal sink in the codebase. Found by the independent Codex review of PR #47.
    const target = sanitizeValue(`${noun} ${verb ?? ""}`.trim());
    console.error(`error: unknown command "tn ${target}". Run tn --help`);
    return 2;
  }
  return logRequest("cli", `${cmd.noun} ${cmd.verb}`, rest, () => cmd.run(rest));
}
