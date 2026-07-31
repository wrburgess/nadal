import { dbMigrate } from "./commands/db-migrate.js";
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
  if (argv.length === 0 || argv.includes("--help")) {
    console.log(helpText());
    return 0;
  }
  const [noun, verb, ...rest] = argv;
  const cmd = COMMANDS.find((c) => c.noun === noun && c.verb === verb);
  if (!cmd) {
    const target = `${noun} ${verb ?? ""}`.trim();
    console.error(`error: unknown command "tn ${target}". Run tn --help`);
    return 2;
  }
  return logRequest("cli", `${cmd.noun} ${cmd.verb}`, rest, () => cmd.run(rest));
}
