import { dbMigrate } from "./commands/db-migrate.js";
import { playerPull } from "./commands/player-pull.js";
import { playerShow } from "./commands/player-show.js";
import { reportBuild } from "./commands/report-build.js";
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
  playerPull,
  playerShow,
  reportBuild,
];

export function helpText(): string {
  const lines = ["tn <noun> <verb> <target> [payload] [flags]", ""];
  for (const c of COMMANDS) {
    lines.push(`  tn ${c.noun} ${c.verb.padEnd(8)} ${c.summary}`);
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
