/**
 * Hand-rolled arg parsing shared by every command — the surface needing more than the global flags
 * is small enough that a dependency is not worth taking for it (spec constraint: no new npm deps).
 *
 * Grammar: `tn <noun> <verb> <target> [flags]` — the first non-flag argument is the target; every
 * `--name` must be one of the caller's declared `booleanFlags`/`valueFlags`, or be one of the
 * GLOBAL flags below, or parsing fails. This is deliberately stricter than "ignore what I don't
 * recognize": an unrecognized flag is very likely a typo'd real one, and silently accepting it
 * would make the typo invisible.
 */
export type ParsedArgs = {
  target?: string;
  flags: Record<string, string | true>;
  error?: string;
};

// `helpText()` (src/cli/router.ts) advertises `--quiet/-q` and `--json` as GLOBAL flags — accepted
// by every command, not just the ones that bother to declare them. Recognizing them here, ahead of
// each command's own `booleanFlags` list, is what makes that advertisement true rather than
// aspirational: before this, `parseArgs` rejected any flag its caller did not explicitly declare
// in `booleanFlags`/`valueFlags`, so `team pull <target> --json` (say) would have failed with
// "unrecognized flag --json" despite the help text's promise — every caller of `parseArgs` would
// otherwise have had to remember to list both flags itself, and one that forgot would silently
// break its own help text. `-q` is a single-dash short alias for `--quiet` (GRAMMAR.md:
// "--quiet/-q"); it sets its own `q` key rather than being normalized into `quiet` —
// `globalFlags()` below is the one place that reconciles the two spellings into a single boolean,
// so every caller asks it that question once instead of re-deriving "quiet OR q" at each call site.
const GLOBAL_BOOLEAN_FLAGS = ["quiet", "json"];

/**
 * The shared flag/positional loop both `parseArgs` and `parsePayloadArgs` build on: everything
 * except how many bare (non-flag) tokens are collected before "unexpected extra argument" fires.
 * `parseArgs` (target only) is `maxPositionals: 1`; `parsePayloadArgs` (target + N payload tokens —
 * GRAMMAR.md's `tn <noun> <verb> <target> [payload]`, e.g. `tn player avail <name> <day> <status>`)
 * is `1 + payloadCount`. Centralizing this is what keeps global-flag recognition and the
 * unrecognized-flag/missing-value error shapes identical for every command, single- or
 * multi-positional alike.
 */
function parsePositionals(
  args: string[],
  maxPositionals: number,
  booleanFlags: string[],
  valueFlags: string[],
): { positionals: string[]; flags: Record<string, string | true>; error?: string } {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  // Everything after a bare `--` is payload, never a flag (standard GNU end-of-flags). Added in
  // #17 PR A after the independent reviewer showed there was no lossless way to record an ordinary
  // captain note beginning with `--`: `tn player note Randy "--poach at net"` died as
  // `unrecognized flag --poach at net`, and the two workarounds both corrupt the note (leading
  // whitespace changes text this service deliberately stores untrimmed). Free-text payload
  // commands did not exist when GRAMMAR.md wrote "there is no `--` payload terminator", which is
  // why that line was true then and is a defect now; it is updated alongside this.
  //
  // Applied in the SHARED loop rather than only for payload commands, so a `--`-leading TARGET
  // (a team or player named that way) is equally recordable — the same defect, one positional over.
  let endOfFlags = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!endOfFlags && arg === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && arg === "-q") {
      flags.q = true;
      continue;
    }
    if (!endOfFlags && arg.startsWith("--")) {
      const name = arg.slice(2);
      if (GLOBAL_BOOLEAN_FLAGS.includes(name) || booleanFlags.includes(name)) {
        flags[name] = true;
        continue;
      }
      if (valueFlags.includes(name)) {
        const value = args[i + 1];
        if (value === undefined) {
          return { positionals, flags, error: `flag --${name} requires a value` };
        }
        flags[name] = value;
        i++;
        continue;
      }
      return { positionals, flags, error: `unrecognized flag --${name}` };
    }
    if (positionals.length < maxPositionals) {
      positionals.push(arg);
      continue;
    }
    return { positionals, flags, error: `unexpected extra argument "${arg}"` };
  }

  return { positionals, flags };
}

export function parseArgs(args: string[], booleanFlags: string[], valueFlags: string[]): ParsedArgs {
  const result = parsePositionals(args, 1, booleanFlags, valueFlags);
  if (result.error !== undefined) return { flags: result.flags, error: result.error };
  return { target: result.positionals[0], flags: result.flags };
}

export type ParsedPayloadArgs = {
  target?: string;
  /** Positional tokens after `target`, in order — always exactly `payloadCount` long once
   * `error` is undefined AND `target` is defined; a caller still checks `payload.length` (or
   * destructures and checks each element for `undefined`) because a short invocation (too few
   * tokens) is not itself a parse error here, the same way a missing `target` is reported by the
   * caller rather than by this parser. */
  payload: string[];
  flags: Record<string, string | true>;
  error?: string;
};

/**
 * Like `parseArgs`, but for a command whose grammar is `tn <noun> <verb> <target> <payload...>`
 * with a FIXED number of payload positionals (e.g. `tn player avail <name> <day> <status>` is
 * `payloadCount: 2`; `tn player note <name> <text>` is `payloadCount: 1`) — GRAMMAR.md's "payload
 * positionals, no new flags" shape (Task 3 decision 2), rather than a `--flag value` pair, so this
 * stays consistent with every other command's "one spelling per operation" rather than adding a
 * second way to say the same thing.
 */
export function parsePayloadArgs(
  args: string[],
  payloadCount: number,
  booleanFlags: string[] = [],
  valueFlags: string[] = [],
): ParsedPayloadArgs {
  const result = parsePositionals(args, 1 + payloadCount, booleanFlags, valueFlags);
  if (result.error !== undefined) return { payload: [], flags: result.flags, error: result.error };
  const [target, ...payload] = result.positionals;
  return { target, payload, flags: result.flags };
}

/**
 * Reconciles the two accepted spellings of the quiet flag (`--quiet`, `-q`) into a single boolean,
 * alongside `--json`, so every command asks this one question instead of re-deriving
 * `flags.quiet === true || flags.q === true` at each call site. Pass the result straight through to
 * `emitSummary`'s `opts` (src/cli/emit.ts): `--quiet` wins when both are set, which `emitSummary`
 * enforces by checking `quiet` before `json`.
 */
export function globalFlags(flags: Record<string, string | true>): { quiet: boolean; json: boolean } {
  return {
    quiet: flags.quiet === true || flags.q === true,
    json: flags.json === true,
  };
}
