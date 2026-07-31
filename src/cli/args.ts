/**
 * Hand-rolled arg parsing shared by `team pull` and `player pull` — GRAMMAR.md forbids a `--`
 * payload terminator and these two commands are the whole surface that needs more than the
 * global flags, so a dependency is not worth taking for it (spec constraint: no new npm deps).
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

export function parseArgs(args: string[], booleanFlags: string[], valueFlags: string[]): ParsedArgs {
  let target: string | undefined;
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-q") {
      flags.q = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (GLOBAL_BOOLEAN_FLAGS.includes(name) || booleanFlags.includes(name)) {
        flags[name] = true;
        continue;
      }
      if (valueFlags.includes(name)) {
        const value = args[i + 1];
        if (value === undefined) {
          return { flags, error: `flag --${name} requires a value` };
        }
        flags[name] = value;
        i++;
        continue;
      }
      return { flags, error: `unrecognized flag --${name}` };
    }
    if (target === undefined) {
      target = arg;
      continue;
    }
    return { flags, error: `unexpected extra argument "${arg}"` };
  }

  return { target, flags };
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
