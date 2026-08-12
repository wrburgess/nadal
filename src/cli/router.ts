import { dbBackup } from "./commands/db-backup.js";
import { dbMigrate } from "./commands/db-migrate.js";
import { eventAdd } from "./commands/event-add.js";
import { lineupBuild } from "./commands/lineup-build.js";
import { lineupPlan } from "./commands/lineup-plan.js";
import { matchAdd } from "./commands/match-add.js";
import { mcpServe } from "./commands/mcp-serve.js";
import { playerAlias } from "./commands/player-alias.js";
import { playerAvail } from "./commands/player-avail.js";
import { playerDistinct } from "./commands/player-distinct.js";
import { playerNote } from "./commands/player-note.js";
import { playerPlays } from "./commands/player-plays.js";
import { playerPull } from "./commands/player-pull.js";
import { playerShow } from "./commands/player-show.js";
import { reportBuild } from "./commands/report-build.js";
import { rosterSet } from "./commands/roster-set.js";
import { teamHome } from "./commands/team-home.js";
import { teamPull } from "./commands/team-pull.js";
import { teamShow } from "./commands/team-show.js";
import { scanFlags } from "./args.js";
import { logRequest } from "../telemetry/request-log.js";
import { sanitizeValue } from "../sanitize.js";

export type Command = {
  noun: string;
  verb: string;
  summary: string;
  // #44 Task 3/4: optional so a command with no flags of its own (most of them) declares nothing.
  // `dispatch` reads these to run `scanFlags` with the SAME list the command's own parser uses —
  // that shared list is what makes it impossible for the two to disagree about which `--` is the
  // end-of-flags delimiter, the bug this file fixes. `team-pull.ts` / `player-pull.ts` declare
  // these here and read them back in `run` (Task 4), so the declaration exists in exactly one
  // place instead of two that have to be kept in sync by hand.
  booleanFlags?: string[];
  valueFlags?: string[];
  run: (args: string[]) => Promise<number>;
};

export const COMMANDS: Command[] = [
  dbMigrate,
  dbBackup,
  teamPull,
  teamShow,
  teamHome,
  playerPull,
  playerShow,
  playerAvail,
  playerPlays,
  playerNote,
  playerDistinct,
  playerAlias,
  eventAdd,
  rosterSet,
  matchAdd,
  lineupPlan,
  lineupBuild,
  reportBuild,
  mcpServe,
];

/**
 * The one worked example the help prints, held as **argv** because that is the form the tests can
 * execute: `test/cli-player-avail-command.test.ts` dispatches this array against a seeded database
 * and asserts the row it stores, so the line a reader copies is a line CI has run. A string here
 * with the argv retyped in the test would be two things to keep in agreement, which is how a doc
 * example comes to name an argument order the command does not take.
 *
 * `tn player avail` rather than another command because it exercises three things at once that no
 * summary row in the table below can show: a multi-word target and therefore the shell quoting it
 * needs, and two payload positionals in an order the reader has no other way to learn. It is also
 * safe to demonstrate — its payload is a date and a closed set of three status words, where
 * `tn player note`'s is free text a shell would parse (see docs/runbooks/capture-availability.md).
 * One example, not one per command: spec § Interfaces asks that help fit one screen.
 */
export const HELP_EXAMPLE_ARGV = ["player", "avail", "Randy Burgess", "2026-08-29", "available"] as const;

/**
 * `HELP_EXAMPLE_ARGV` rendered as a paste-able command line — quoting only a token that contains a
 * space, which is the only reason any token in this example needs quoting at all.
 *
 * Deliberately NOT a general shell quoter. Inside double quotes a POSIX shell still expands `$`, a
 * backtick, and `\`, so a renderer that silently quoted such a token would hand the reader a line
 * that runs something when pasted — the hazard docs/runbooks/capture-availability.md already warns
 * about for `tn player note`. The guard is an allowlist over the tokens themselves, asserted in
 * test/cli-router.test.ts, rather than escaping logic here that would have to be right forever.
 */
export const HELP_EXAMPLE = `tn ${HELP_EXAMPLE_ARGV.map((token) => (token.includes(" ") ? `"${token}"` : token)).join(" ")}`;

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
  // A labelled single line, the same shape as the flags line above it — NOT an indented block. The
  // command rows are the only lines that start with "  tn ", and the alignment test counts them to
  // assert one row per registered command; an indented example would be counted as a nineteenth.
  lines.push("", "Global flags: --quiet/-q  --json  --help", `Example: ${HELP_EXAMPLE}`);
  return lines.join("\n");
}

export async function dispatch(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.log(helpText());
    return 0;
  }
  const [noun, verb, ...rest] = argv;
  const cmd = COMMANDS.find((c) => c.noun === noun && c.verb === verb);

  if (!cmd) {
    // UNRESOLVED noun+verb: no command means no `booleanFlags`/`valueFlags` to be aware of, so
    // there is nothing for a value-flag-aware scan to do here that the raw scan below doesn't
    // already do correctly. This is the same whole-`argv`, first-bare-`--` scan `dispatch` has
    // always run for this path — kept BYTE-FOR-BYTE so `tn --help`, `tn player --help`, and `tn
    // bogus nope --help` all still print help (test: "dispatch's unresolved-command path still
    // honors --help"). Found by the independent reviewer in round 2 of #17 PR A: this check used
    // to run before command resolution and outranked the `--` end-of-flags delimiter for every
    // invocation, resolved or not — `tn player note Randy -- --help` printed help and exited 0
    // instead of recording the note, disagreeing with the MCP `player_note` tool on the identical
    // text. #44 Task 3 moves this scan to run only once resolution has already failed, which is
    // what makes it safe to leave unchanged: a RESOLVED command gets the value-flag-aware scan
    // below instead, so this path never again has to know about any command's value flags.
    const terminator = argv.indexOf("--");
    const beforeTerminator = terminator === -1 ? argv : argv.slice(0, terminator);
    if (beforeTerminator.includes("--help")) {
      console.log(helpText());
      return 0;
    }
    // Echoed straight back from argv, so it is whatever the caller typed — and this write happens
    // BEFORE any command's formatter exists to sanitize it, which is precisely why it was the last
    // unguarded terminal sink in the codebase. Found by the independent Codex review of PR #47.
    const target = sanitizeValue(`${noun} ${verb ?? ""}`.trim());
    console.error(`error: unknown command "tn ${target}". Run tn --help`);
    return 2;
  }

  // RESOLVED command: scan `rest` — the exact slice `cmd.run` receives, per its own
  // `booleanFlags`/`valueFlags` — instead of the raw whole-argv scan above, so a `--` that is a
  // declared value flag's value can no longer be misread as the end-of-flags delimiter here while
  // the command's own parser reads it correctly. This is #44's fix: before it, `dispatch` never
  // knew a command's value flags at all, so `tn player pull usta:1234 --from -- --source-url
  // https://x --help` read the `--` after `--from` as the delimiter and suppressed the trailing
  // `--help`, which then reached the parser as an "unrecognized flag" instead of printing help.
  //
  // Consequence, deliberate and pinned by its own test: `tn player pull X --from --help` no longer
  // prints help — `--help` is consumed as `--from`'s value by this same scan, exactly like the
  // parser has always treated it, so the two layers now agree instead of `dispatch` outranking the
  // parser for one specific token.
  const scan = scanFlags(rest, cmd.booleanFlags ?? [], cmd.valueFlags ?? []);
  if (scan.helpRequested) {
    console.log(helpText());
    return 0;
  }
  return logRequest("cli", `${cmd.noun} ${cmd.verb}`, rest, () => cmd.run(rest));
}
